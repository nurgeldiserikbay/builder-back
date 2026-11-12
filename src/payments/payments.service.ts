import { inLocale, money, tr, type Message } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { hasOpenDispute } from '../disputes/disputes.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { DEFAULT_TOKENS, costOf } from '../budget/budget.js';
import { PaymentProviderError, activeProvider, automaticRefund, freedomCallback, freedomCheckout, freedomConfig, freedomReply } from './providers.js';
export { activeProvider } from './providers.js';
import { billingSettings, projectBalance, walletLockKey } from './wallet.js';
import { STAGE_ORDER_PREFIX, normalizeIban, splitFee } from './payouts.js';
import { openSecret, sealSecret, secretKey } from '../common/secret-box.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';
import { reportError } from '../observability/error-reporting.js';

const MAX_TOP_UP_TIYN = 50_000_000; // 500 000 ₸
const tenge = (tiyn: number) => tiyn / 100;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const apiBase = () => (process.env.PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const appBase = () => (process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const FREEDOM_RESULT_PATH = '/api/v1/payments/freedompay/result';

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService) {}

  /** Balance, recent top-ups and whether paying is possible. Seen by those who decide on the project. */
  async wallet(userId: string, projectId: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('WALLET_FORBIDDEN');
    const settings = await billingSettings(this.prisma);
    const [balance, topUps] = await Promise.all([
      projectBalance(this.prisma, projectId, settings.prepaidSince),
      this.prisma.projectTopUp.findMany({
        where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, amountTiyn: true, status: true, provider: true, createdAt: true, paidAt: true, refundedTiyn: true, refundStatus: true, refundRequestedTiyn: true, refundRequestedAt: true, refundDecidedAt: true, refundNote: true },
      }),
    ]);
    const typical = settings.priced ? costOf({ inputTokens: DEFAULT_TOKENS.input, outputTokens: DEFAULT_TOKENS.output }, settings) ?? 0 : 0;
    return {
      data: {
        mode: settings.mode, provider: activeProvider(), currency: 'KZT',
        balance: tenge(balance.balanceTiyn), paid: tenge(balance.paidTiyn), spent: tenge(balance.spentTiyn),
        minTopUp: tenge(settings.minTopUpTiyn), maxTopUp: tenge(MAX_TOP_UP_TIYN), typicalRequest: tenge(typical),
        requestsLeft: typical > 0 ? Math.max(0, Math.floor(balance.balanceTiyn / typical)) : null,
        refunded: tenge(balance.refundedTiyn), pendingRefund: tenge(balance.pendingRefundTiyn),
        topUps: topUps.map(({ refundRequestedTiyn, refundedTiyn, ...item }) => ({
          ...item, amount: tenge(item.amountTiyn), refunded: tenge(refundedTiyn), refundRequested: refundRequestedTiyn === null ? null : tenge(refundRequestedTiyn),
          // Only money not yet spent on AI can be returned.
          refundable: item.status === 'paid' && item.refundStatus !== 'requested' ? tenge(Math.max(0, Math.min(item.amountTiyn - refundedTiyn, balance.balanceTiyn))) : 0,
        })),
      },
    };
  }

  /** Creates a top-up and returns the provider's payment page. Nothing is credited until the provider confirms. */
  async startTopUp(userId: string, projectId: string, amountTenge: number) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('WALLET_FORBIDDEN');
    if (access.status === 'archived') throw new ConflictException('PROJECT_NOT_ACTIVE');
    const provider = activeProvider();
    if (!provider) throw new ServiceUnavailableException('PAYMENTS_NOT_CONFIGURED');
    const settings = await billingSettings(this.prisma);
    const amountTiyn = Math.round(amountTenge * 100);
    if (!Number.isInteger(amountTenge) || amountTiyn < settings.minTopUpTiyn || amountTiyn > MAX_TOP_UP_TIYN) throw new BadRequestException('TOP_UP_AMOUNT_INVALID');
    const recent = await this.prisma.projectTopUp.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (recent >= 10) throw new ConflictException('TOP_UP_TOO_MANY');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const topUp = await this.prisma.projectTopUp.create({ data: { projectId, userId, amountTiyn, provider }, select: { id: true } });
    const back = (result: string) => `${appBase()}/projects/${projectId}?payment=${result}&topup=${topUp.id}`;
    try {
      const checkout = provider === 'mock'
        ? { redirectUrl: `${apiBase()}/api/v1/payments/mock/${topUp.id}`, providerPaymentId: `mock-${topUp.id.slice(0, 8)}` }
        : await freedomCheckout(freedomConfig()!, {
          orderId: topUp.id, amountTiyn, description: `BuildPath: пополнение баланса проекта «${access.name}»`,
          resultUrl: `${apiBase()}${FREEDOM_RESULT_PATH}`, successUrl: back('success'), failureUrl: back('failure'), email: user?.email ?? null,
        });
      await this.prisma.projectTopUp.update({ where: { id: topUp.id }, data: { providerPaymentId: checkout.providerPaymentId } });
      await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'top_up_started', details: { topUpId: topUp.id, amount: amountTenge, provider } } });
      return { data: { topUpId: topUp.id, redirectUrl: checkout.redirectUrl } };
    } catch (error) {
      await this.prisma.projectTopUp.update({ where: { id: topUp.id }, data: { status: 'failed' } });
      if (error instanceof PaymentProviderError) throw new ServiceUnavailableException(error.code);
      throw error;
    }
  }

  /**
   * Marks a top-up paid exactly once. The amount and currency must match what was created; a mismatch is refused
   * and left for staff to look at.
   */
  private async settle(orderId: string, result: { status: 'paid' | 'failed' | 'pending'; amountTiyn: number | null; currency: string | null; providerPaymentId: string | null }): Promise<'ok' | 'rejected' | 'unknown'> {
    if (orderId.startsWith(STAGE_ORDER_PREFIX)) return this.settleStagePayment(orderId.slice(STAGE_ORDER_PREFIX.length), result);
    const topUpId = orderId;
    if (!isUuid(topUpId)) return 'unknown';
    const topUp = await this.prisma.projectTopUp.findUnique({ where: { id: topUpId }, select: { id: true, projectId: true, userId: true, amountTiyn: true, status: true } });
    if (!topUp) return 'unknown';
    if (result.status === 'pending') return 'ok';
    if (result.status === 'failed') {
      await this.prisma.projectTopUp.updateMany({ where: { id: topUp.id, status: 'created' }, data: { status: 'failed' } });
      return 'ok';
    }
    if (result.amountTiyn !== topUp.amountTiyn || (result.currency && result.currency !== 'KZT')) return 'rejected';
    const updated = await this.prisma.projectTopUp.updateMany({ where: { id: topUp.id, status: { in: ['created', 'failed'] } }, data: { status: 'paid', paidAt: new Date(), providerPaymentId: result.providerPaymentId } });
    if (!updated.count && result.providerPaymentId && !(await this.prisma.projectTopUp.count({ where: { id: topUp.id, providerPaymentId: result.providerPaymentId } }))) {
      // A second successful payment for the same top-up: it is not credited twice, so staff must return it.
      await this.prisma.projectEvent.create({ data: { projectId: topUp.projectId, actorUserId: topUp.userId, type: 'top_up_duplicate', details: { topUpId: topUp.id, amount: tenge(topUp.amountTiyn), providerPaymentId: result.providerPaymentId } } });
      reportError(new Error(`PAYMENT_DUPLICATE top_up=${topUp.id} provider_payment=${result.providerPaymentId}`));
      return 'ok';
    }
    if (updated.count) {
      await this.prisma.projectEvent.create({ data: { projectId: topUp.projectId, actorUserId: topUp.userId, type: 'top_up_paid', details: { topUpId: topUp.id, amount: tenge(topUp.amountTiyn) } } });
    }
    return 'ok';
  }

  /** Freedom Pay result_url: verify the signature, settle, answer with signed XML. */
  async freedomResult(fields: Record<string, string>): Promise<string> {
    const config = freedomConfig();
    const resultUrl = `${apiBase()}${FREEDOM_RESULT_PATH}`;
    if (!config) return '';
    let parsed;
    try { parsed = freedomCallback(config, resultUrl, fields); } catch { return freedomReply(config, resultUrl, 'error', 'Неверная подпись'); }
    const outcome = await this.settle(parsed.orderId, parsed);
    if (outcome === 'unknown') return freedomReply(config, resultUrl, 'error', 'Платёж не найден');
    if (outcome === 'rejected') return freedomReply(config, resultUrl, 'rejected', 'Сумма не совпадает');
    return freedomReply(config, resultUrl, 'ok', 'Платёж принят');
  }

  /** Local development only: a page that stands in for the provider. orderId is a top-up id or «sp-» + a stage payment id. */
  private async mockOrder(orderId: string): Promise<{ amountTiyn: number; status: string; projectId: string } | null> {
    if (orderId.startsWith(STAGE_ORDER_PREFIX)) {
      const id = orderId.slice(STAGE_ORDER_PREFIX.length);
      return isUuid(id) ? this.prisma.stagePayment.findUnique({ where: { id }, select: { amountTiyn: true, status: true, projectId: true } }) : null;
    }
    return isUuid(orderId) ? this.prisma.projectTopUp.findUnique({ where: { id: orderId }, select: { amountTiyn: true, status: true, projectId: true } }) : null;
  }

  async mockPage(orderId: string): Promise<string> {
    if (activeProvider() !== 'mock') throw new NotFoundException('NOT_FOUND');
    const order = await this.mockOrder(orderId);
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовая оплата</title>
<body style="font:17px system-ui;max-width:420px;margin:40px auto;padding:0 16px"><p style="background:#fff3cd;padding:10px;border-radius:8px">Тестовая страница оплаты: настоящих денег здесь нет.</p>
<h1>Оплата ${tenge(order.amountTiyn).toLocaleString('ru-RU')} ₸</h1><p>Статус: ${order.status}</p>
<form method="post" action="/api/v1/payments/mock/${orderId}"><button name="result" value="paid" style="font:inherit;padding:14px 20px">Оплатить</button> <button name="result" value="failed" style="font:inherit;padding:14px 20px">Отказаться</button></form></body></html>`;
  }

  async mockComplete(orderId: string, result: string): Promise<string> {
    if (activeProvider() !== 'mock') throw new NotFoundException('NOT_FOUND');
    const order = await this.mockOrder(orderId);
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    const paid = result === 'paid';
    await this.settle(orderId, { status: paid ? 'paid' : 'failed', amountTiyn: order.amountTiyn, currency: 'KZT', providerPaymentId: `mock-${orderId.slice(-8)}` });
    return `${appBase()}/projects/${order.projectId}?payment=${paid ? 'success' : 'failure'}`;
  }

  // --- Refunds ---

  /** The owner asks to return the unspent part of a paid top-up. The amount is set aside at once so it cannot be spent meanwhile. */
  async requestRefund(userId: string, projectId: string, topUpId: string, amountTenge: number, reason: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('WALLET_FORBIDDEN');
    if (!isUuid(topUpId)) throw new NotFoundException('TOP_UP_NOT_FOUND');
    const amountTiyn = Math.round(amountTenge * 100);
    if (!Number.isFinite(amountTenge) || amountTiyn < 100) throw new BadRequestException('REFUND_AMOUNT_INVALID');
    const cleanReason = reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    const settings = await billingSettings(this.prisma);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${walletLockKey(projectId)}))`;
      const topUp = await tx.projectTopUp.findFirst({ where: { id: topUpId, projectId }, select: { id: true, status: true, amountTiyn: true, refundedTiyn: true, refundStatus: true } });
      if (!topUp || topUp.status !== 'paid') throw new NotFoundException('TOP_UP_NOT_FOUND');
      if (topUp.refundStatus === 'requested') throw new ConflictException('REFUND_ALREADY_REQUESTED');
      const balance = await projectBalance(tx, projectId, settings.prepaidSince);
      if (amountTiyn > topUp.amountTiyn - topUp.refundedTiyn || amountTiyn > balance.balanceTiyn) throw new ConflictException('REFUND_MORE_THAN_LEFT');
      await tx.projectTopUp.update({ where: { id: topUp.id }, data: { refundStatus: 'requested', refundRequestedTiyn: amountTiyn, refundReason: cleanReason || null, refundRequestedAt: new Date(), refundDecidedAt: null, refundNote: null, refundReference: null } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'refund_requested', details: { topUpId, amount: tenge(amountTiyn) } } });
    });
    return this.wallet(userId, projectId);
  }

  async cancelRefund(userId: string, projectId: string, topUpId: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('WALLET_FORBIDDEN');
    if (!isUuid(topUpId)) throw new NotFoundException('TOP_UP_NOT_FOUND');
    const updated = await this.prisma.projectTopUp.updateMany({ where: { id: topUpId, projectId, refundStatus: 'requested' }, data: { refundStatus: null, refundRequestedTiyn: null, refundRequestedAt: null } });
    if (!updated.count) throw new ConflictException('REFUND_NOT_REQUESTED');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'refund_cancelled', details: { topUpId } } });
    return this.wallet(userId, projectId);
  }

  /** Staff: refund requests waiting for a decision, then recent decisions. */
  async refundQueue() {
    const rows = await this.prisma.projectTopUp.findMany({
      where: { refundStatus: { not: null } }, orderBy: [{ refundStatus: 'asc' }, { refundRequestedAt: 'asc' }], take: 100,
      select: { id: true, projectId: true, amountTiyn: true, refundedTiyn: true, refundStatus: true, refundRequestedTiyn: true, refundReason: true, refundRequestedAt: true, refundDecidedAt: true, refundReference: true, refundNote: true, provider: true, providerPaymentId: true, paidAt: true, project: { select: { name: true, owner: { select: { email: true } } } } },
    });
    return {
      data: {
        automatic: Object.fromEntries(['mock', 'freedompay'].map((key) => [key, Boolean(automaticRefund(key))])),
        items: rows.map((row) => ({
          id: row.id, project: row.project.name, owner: row.project.owner.email, provider: row.provider, providerPaymentId: row.providerPaymentId, paidAt: row.paidAt,
          amount: tenge(row.amountTiyn), refunded: tenge(row.refundedTiyn), requested: row.refundRequestedTiyn === null ? null : tenge(row.refundRequestedTiyn),
          status: row.refundStatus, reason: row.refundReason, requestedAt: row.refundRequestedAt, decidedAt: row.refundDecidedAt, reference: row.refundReference, note: row.refundNote,
          automatic: Boolean(automaticRefund(row.provider)),
        })),
      },
    };
  }

  /**
   * Staff decide on a refund request. With the test provider the money «returns» at once; with a real provider staff
   * make the refund in its merchant cabinet first and record its reference here.
   */
  async decideRefund(staffId: string, topUpId: string, decision: 'refund' | 'reject', input: { reference: string | null; note: string | null }) {
    if (!isUuid(topUpId)) throw new NotFoundException('TOP_UP_NOT_FOUND');
    const note = input.note?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) || null;
    const topUp = await this.prisma.projectTopUp.findUnique({ where: { id: topUpId }, select: { id: true, projectId: true, userId: true, provider: true, providerPaymentId: true, refundStatus: true, refundRequestedTiyn: true } });
    if (!topUp || topUp.refundStatus !== 'requested' || !topUp.refundRequestedTiyn) throw new ConflictException('REFUND_NOT_REQUESTED');
    let reference: string | null = null;
    if (decision === 'refund') {
      const auto = automaticRefund(topUp.provider);
      reference = auto ? auto(topUp.providerPaymentId, topUp.refundRequestedTiyn).reference : (input.reference?.replace(/[\u0000-\u001f]/g, '').trim() ?? '');
      if (!reference || reference.length < 3 || reference.length > 100) throw new BadRequestException('REFUND_REFERENCE_REQUIRED');
    } else if (!note) throw new BadRequestException('REFUND_NOTE_REQUIRED');
    const amountTiyn = topUp.refundRequestedTiyn;
    const settings = await billingSettings(this.prisma);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${walletLockKey(topUp.projectId)}))`;
      if (decision === 'refund') {
        // The amount was set aside at the request, but an AI answer longer than its hold may have spent past zero since:
        // money already spent must not be returned.
        const { balanceTiyn } = await projectBalance(tx, topUp.projectId, settings.prepaidSince);
        if (balanceTiyn < 0) throw new ConflictException('REFUND_MORE_THAN_LEFT');
      }
      const updated = await tx.projectTopUp.updateMany({
        where: { id: topUp.id, refundStatus: 'requested' },
        data: decision === 'refund'
          ? { refundStatus: 'refunded', refundedTiyn: { increment: amountTiyn }, refundRequestedTiyn: null, refundDecidedAt: new Date(), refundDecidedByStaffId: staffId, refundReference: reference, refundNote: note }
          : { refundStatus: 'rejected', refundRequestedTiyn: null, refundDecidedAt: new Date(), refundDecidedByStaffId: staffId, refundNote: note },
      });
      if (!updated.count) throw new ConflictException('REFUND_NOT_REQUESTED');
      await tx.adminAuditEvent.create({ data: { staffId, eventType: decision === 'refund' ? 'refund.made' : 'refund.rejected', targetType: 'project_top_up', targetId: topUp.id, details: { amount: tenge(amountTiyn), reference, note } } });
      await tx.projectEvent.create({ data: { projectId: topUp.projectId, type: decision === 'refund' ? 'refund_made' : 'refund_rejected', details: { topUpId: topUp.id, amount: tenge(amountTiyn) } } });
    });
    await this.notify(topUp.userId, () => (decision === 'refund'
      ? tr('BuildPath вернул {0} ₸ с баланса проекта. Деньги придут на карту, с которой вы платили; обычно это занимает несколько рабочих дней.', [money(amountTiyn)])
      : tr('Возврат {0} ₸ отклонён: {1}. Деньги снова доступны на балансе проекта.', [money(amountTiyn), note])));
    return this.refundQueue();
  }

  /** Staff: money held for a specialist goes back to the owner (e.g. a dispute settled in the owner's favour). Only before the payout. */
  async refundStagePayment(staffId: string, paymentId: string, input: { reference: string | null; note: string }) {
    if (!isUuid(paymentId)) throw new NotFoundException('PAYMENT_NOT_FOUND');
    const note = input.note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (note.length < 3) throw new BadRequestException('REFUND_NOTE_REQUIRED');
    const payment = await this.prisma.stagePayment.findUnique({ where: { id: paymentId }, select: { id: true, projectId: true, status: true, amountTiyn: true, provider: true, providerPaymentId: true, assignment: { select: { userId: true, stage: { select: { stageKey: true } } } } } });
    if (!payment || payment.status !== 'held') throw new ConflictException('PAYMENT_NOT_HELD');
    const auto = automaticRefund(payment.provider ?? '');
    const reference = auto ? auto(payment.providerPaymentId, payment.amountTiyn).reference : (input.reference?.trim() ?? '');
    if (!reference || reference.length < 3 || reference.length > 100) throw new BadRequestException('REFUND_REFERENCE_REQUIRED');
    const updated = await this.prisma.stagePayment.updateMany({ where: { id: paymentId, status: 'held' }, data: { status: 'refunded', refundedAt: new Date(), refundReference: reference, refundNote: note } });
    if (!updated.count) throw new ConflictException('PAYMENT_NOT_HELD');
    await this.prisma.$transaction([
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'refund.stage_payment', targetType: 'stage_payment', targetId: paymentId, details: { amount: tenge(payment.amountTiyn), reference, note } } }),
      this.prisma.projectEvent.create({ data: { projectId: payment.projectId, type: 'specialist_payment_refunded', stageKey: payment.assignment.stage.stageKey, details: { paymentId, amount: tenge(payment.amountTiyn) } } }),
    ]);
    await this.notify(payment.assignment.userId, () => tr('Оплата {0} ₸ за этап «{1}» возвращена владельцу проекта: {2}.', [money(payment.amountTiyn), tr(stageDefinitions[payment.assignment.stage.stageKey as StageKey]?.title ?? ''), note]));
    return this.payoutQueue();
  }

  // --- Receipts ---

  /**
   * A payment confirmation the payer can keep or print. It is not a fiscal receipt: those are issued by the provider or
   * a fiscal data operator once a real provider is connected, and the test provider says so on the document.
   */
  async receipt(userId: string, projectId: string, kind: 'top-up' | 'stage', id: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('WALLET_FORBIDDEN');
    if (!isUuid(id)) throw new NotFoundException('RECEIPT_NOT_FOUND');
    const number = (date: Date) => `BP-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(0, 8).toUpperCase()}`;
    const buyer = await this.prisma.project.findUnique({ where: { id: projectId }, select: { owner: { select: { name: true, email: true } } } });
    if (kind === 'top-up') {
      const row = await this.prisma.projectTopUp.findFirst({ where: { id, projectId, status: 'paid' }, select: { amountTiyn: true, refundedTiyn: true, paidAt: true, provider: true, providerPaymentId: true, refundDecidedAt: true, refundReference: true, userId: true } });
      if (!row?.paidAt) throw new NotFoundException('RECEIPT_NOT_FOUND');
      const payer = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true } });
      return { data: {
        number: number(row.paidAt), paidAt: row.paidAt, payer: payer?.name || payer?.email || buyer?.owner.email, payerEmail: payer?.email ?? null, project: access.name,
        items: [{ title: 'Пополнение баланса проекта для запросов к ИИ', amount: tenge(row.amountTiyn) }], total: tenge(row.amountTiyn), currency: 'KZT',
        refunds: row.refundedTiyn ? [{ amount: tenge(row.refundedTiyn), at: row.refundDecidedAt, reference: row.refundReference }] : [],
        provider: row.provider, providerPaymentId: row.providerPaymentId, test: row.provider === 'mock', seller: 'BuildPath',
      } };
    }
    const row = await this.prisma.stagePayment.findFirst({ where: { id, projectId, status: { in: ['held', 'paid_out', 'refunded'] } }, select: { amountTiyn: true, feeTiyn: true, payoutTiyn: true, paidAt: true, provider: true, providerPaymentId: true, status: true, refundedAt: true, refundReference: true, assignment: { select: { email: true, user: { select: { name: true } }, stage: { select: { stageKey: true } } } } } });
    if (!row?.paidAt) throw new NotFoundException('RECEIPT_NOT_FOUND');
    const stage = stageDefinitions[row.assignment.stage.stageKey as StageKey]?.title ?? row.assignment.stage.stageKey;
    return { data: {
      number: number(row.paidAt), paidAt: row.paidAt, payer: buyer?.owner.name || buyer?.owner.email, payerEmail: buyer?.owner.email ?? null, project: access.name,
      items: [
        { title: `Работа специалиста (${row.assignment.user?.name || row.assignment.email}), этап «${stage}»`, amount: tenge(row.payoutTiyn ?? row.amountTiyn) },
        ...(row.feeTiyn ? [{ title: 'Комиссия BuildPath', amount: tenge(row.feeTiyn) }] : []),
      ],
      total: tenge(row.amountTiyn), currency: 'KZT',
      refunds: row.status === 'refunded' ? [{ amount: tenge(row.amountTiyn), at: row.refundedAt, reference: row.refundReference }] : [],
      provider: row.provider, providerPaymentId: row.providerPaymentId, test: row.provider === 'mock', seller: 'BuildPath',
    } };
  }

  // --- Specialists paid through BuildPath ---

  private async notify(userId: string | null, text: Message) {
    const config = telegramConfig();
    if (!config || !userId) return;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { chatId: true, user: { select: { locale: true } } } });
    if (identity) await sendTelegramMessage(config, identity.chatId, inLocale(identity.user.locale, text)).catch(() => undefined);
  }


  /** The specialist's own payout account: only the holder name and the last digits are ever shown back. */
  async payoutDetails(userId: string) {
    const row = await this.prisma.payoutDetails.findUnique({ where: { userId }, select: { holderName: true, ibanHint: true, updatedAt: true } });
    return { data: { details: row ? { holderName: row.holderName, iban: `KZ…${row.ibanHint}`, updatedAt: row.updatedAt } : null, canSave: Boolean(secretKey()) } };
  }

  async savePayoutDetails(userId: string, input: { holderName: string; iban: string }) {
    const key = secretKey();
    if (!key) throw new ServiceUnavailableException('PAYOUTS_NOT_CONFIGURED');
    const iban = normalizeIban(input.iban);
    if (!iban) throw new BadRequestException('IBAN_INVALID');
    const holderName = input.holderName.replace(/[\u0000-\u001f]/g, '').trim();
    if (holderName.length < 3 || holderName.length > 120) throw new BadRequestException('HOLDER_NAME_INVALID');
    const data = { holderName, ibanEncrypted: sealSecret(iban, key), ibanHint: iban.slice(-4) };
    await this.prisma.payoutDetails.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return this.payoutDetails(userId);
  }

  async deletePayoutDetails(userId: string) {
    await this.prisma.payoutDetails.deleteMany({ where: { userId } });
    return this.payoutDetails(userId);
  }

  /** Owner pays what a specialist is owed through BuildPath; the platform fee is fixed now and the rest goes to the specialist. */
  async stageCheckout(userId: string, projectId: string, paymentId: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('PAYMENT_FORBIDDEN');
    const provider = activeProvider();
    if (!provider) throw new ServiceUnavailableException('PAYMENTS_NOT_CONFIGURED');
    if (!isUuid(paymentId)) throw new NotFoundException('PAYMENT_NOT_FOUND');
    const payment = await this.prisma.stagePayment.findFirst({ where: { id: paymentId, projectId }, select: { id: true, status: true, amountTiyn: true, assignment: { select: { stage: { select: { stageKey: true } } } } } });
    if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
    if (payment.status !== 'due' && payment.status !== 'checkout') throw new ConflictException('PAYMENT_NOT_DUE');
    const settings = await billingSettings(this.prisma);
    const split = splitFee(payment.amountTiyn, settings.specialistFeeBp);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const orderId = `${STAGE_ORDER_PREFIX}${payment.id}`;
    const back = (result: string) => `${appBase()}/projects/${projectId}/stages/${payment.assignment.stage.stageKey}?payment=${result}`;
    const title = stageDefinitions[payment.assignment.stage.stageKey as StageKey]?.title ?? '';
    let checkout;
    try {
      checkout = provider === 'mock'
        ? { redirectUrl: `${apiBase()}/api/v1/payments/mock/${orderId}`, providerPaymentId: `mock-${payment.id.slice(0, 8)}` }
        : await freedomCheckout(freedomConfig()!, {
          orderId, amountTiyn: payment.amountTiyn, description: `BuildPath: оплата работы специалиста, этап «${title}», проект «${access.name}»`,
          resultUrl: `${apiBase()}${FREEDOM_RESULT_PATH}`, successUrl: back('success'), failureUrl: back('failure'), email: user?.email ?? null,
        });
    } catch (error) {
      if (error instanceof PaymentProviderError) throw new ServiceUnavailableException(error.code);
      throw error;
    }
    await this.prisma.stagePayment.update({ where: { id: payment.id }, data: { status: 'checkout', provider, providerPaymentId: checkout.providerPaymentId, feeTiyn: split.feeTiyn, payoutTiyn: split.payoutTiyn } });
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'specialist_payment_started', details: { paymentId, amount: tenge(payment.amountTiyn), fee: tenge(split.feeTiyn) } } });
    return { data: { redirectUrl: checkout.redirectUrl, fee: tenge(split.feeTiyn), payout: tenge(split.payoutTiyn) } };
  }

  private async settleStagePayment(id: string, result: { status: 'paid' | 'failed' | 'pending'; amountTiyn: number | null; currency: string | null; providerPaymentId: string | null }): Promise<'ok' | 'rejected' | 'unknown'> {
    if (!isUuid(id)) return 'unknown';
    const payment = await this.prisma.stagePayment.findUnique({ where: { id }, select: { id: true, projectId: true, amountTiyn: true, status: true, payoutTiyn: true, assignment: { select: { userId: true, stage: { select: { stageKey: true } } } } } });
    if (!payment) return 'unknown';
    if (result.status === 'pending') return 'ok';
    if (result.status === 'failed') {
      await this.prisma.stagePayment.updateMany({ where: { id, status: 'checkout' }, data: { status: 'due' } });
      return 'ok';
    }
    if (result.amountTiyn !== payment.amountTiyn || (result.currency && result.currency !== 'KZT')) return 'rejected';
    const updated = await this.prisma.stagePayment.updateMany({ where: { id, status: { in: ['due', 'checkout'] } }, data: { status: 'held', heldAt: new Date(), paidAt: new Date(), providerPaymentId: result.providerPaymentId } });
    if (!updated.count && result.providerPaymentId && !(await this.prisma.stagePayment.count({ where: { id, providerPaymentId: result.providerPaymentId } }))) {
      // Money arrived for a payment that is already settled (paid twice, or marked as paid directly meanwhile).
      // Nothing is lost silently: the project history shows it and error reporting alerts staff to return it.
      await this.prisma.projectEvent.create({ data: { projectId: payment.projectId, type: 'specialist_payment_duplicate', stageKey: payment.assignment.stage.stageKey, details: { paymentId: id, amount: tenge(payment.amountTiyn), providerPaymentId: result.providerPaymentId, status: payment.status } } });
      reportError(new Error(`PAYMENT_DUPLICATE stage_payment=${id} provider_payment=${result.providerPaymentId}`));
      return 'ok';
    }
    if (updated.count) {
      await this.prisma.projectEvent.create({ data: { projectId: payment.projectId, type: 'specialist_payment_held', stageKey: payment.assignment.stage.stageKey, details: { paymentId: id, amount: tenge(payment.amountTiyn) } } });
      const details = payment.assignment.userId ? await this.prisma.payoutDetails.findUnique({ where: { userId: payment.assignment.userId }, select: { id: true } }) : null;
      await this.notify(payment.assignment.userId, () => `${tr('Владелец оплатил вашу работу через BuildPath: {0} ₸ к выплате.', [money(payment.payoutTiyn ?? payment.amountTiyn)])} ${details ? tr('Переведём на ваш счёт после проверки.') : tr('Укажите счёт для выплаты на странице этапа — без него перевести не сможем.')}`);
    }
    return 'ok';
  }

  /** Staff: payments held by the platform and waiting for transfer, then recent payouts. */
  async payoutQueue() {
    const rows = await this.prisma.stagePayment.findMany({
      where: { status: { in: ['held', 'paid_out'] } }, orderBy: [{ status: 'asc' }, { heldAt: 'asc' }], take: 100,
      select: {
        id: true, status: true, amountTiyn: true, feeTiyn: true, payoutTiyn: true, heldAt: true, paidOutAt: true, payoutReference: true, projectId: true,
        assignment: { select: { _count: { select: { disputes: { where: { status: 'open' } } } }, email: true, userId: true, user: { select: { name: true, payoutDetails: { select: { holderName: true, ibanHint: true } } } }, stage: { select: { stageKey: true } }, project: { select: { name: true } } } },
      },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, status: row.status, amount: tenge(row.amountTiyn), fee: tenge(row.feeTiyn ?? 0), payout: tenge(row.payoutTiyn ?? row.amountTiyn),
        heldAt: row.heldAt, paidOutAt: row.paidOutAt, reference: row.payoutReference, project: row.assignment.project.name, disputeOpen: row.assignment._count.disputes > 0,
        stage: stageDefinitions[row.assignment.stage.stageKey as StageKey]?.title ?? row.assignment.stage.stageKey,
        specialist: row.assignment.user?.name || row.assignment.email,
        account: row.assignment.user?.payoutDetails ? { holderName: row.assignment.user.payoutDetails.holderName, ibanHint: row.assignment.user.payoutDetails.ibanHint } : null,
      })),
    };
  }

  /** Staff: the full IBAN to make the transfer. Every reveal is audited. */
  async revealPayoutAccount(staffId: string, paymentId: string) {
    const key = secretKey();
    if (!key) throw new ServiceUnavailableException('PAYOUTS_NOT_CONFIGURED');
    if (!isUuid(paymentId)) throw new NotFoundException('PAYMENT_NOT_FOUND');
    const payment = await this.prisma.stagePayment.findUnique({ where: { id: paymentId }, select: { status: true, assignmentId: true, assignment: { select: { userId: true } } } });
    if (!payment || payment.status !== 'held' || !payment.assignment.userId) throw new NotFoundException('PAYMENT_NOT_FOUND');
    if (await hasOpenDispute(this.prisma, payment.assignmentId)) throw new ConflictException('DISPUTE_OPEN');
    const details = await this.prisma.payoutDetails.findUnique({ where: { userId: payment.assignment.userId } });
    if (!details) throw new ConflictException('PAYOUT_DETAILS_MISSING');
    const iban = openSecret(details.ibanEncrypted, key);
    if (!iban) throw new ServiceUnavailableException('PAYOUT_DETAILS_UNREADABLE');
    await this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'payout.account_viewed', targetType: 'stage_payment', targetId: paymentId, details: { ibanHint: details.ibanHint } } });
    return { data: { holderName: details.holderName, iban } };
  }

  /** Staff: the bank transfer to the specialist is done; record its reference. */
  async markPaidOut(staffId: string, paymentId: string, reference: string) {
    if (!isUuid(paymentId)) throw new NotFoundException('PAYMENT_NOT_FOUND');
    const clean = reference.replace(/[\u0000-\u001f]/g, '').trim();
    if (clean.length < 3 || clean.length > 100) throw new BadRequestException('PAYOUT_REFERENCE_INVALID');
    const payment = await this.prisma.stagePayment.findUnique({ where: { id: paymentId }, select: { projectId: true, assignmentId: true, payoutTiyn: true, amountTiyn: true, assignment: { select: { userId: true, stage: { select: { stageKey: true } } } } } });
    if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
    // Money of a disputed stage stays with BuildPath until staff decide the dispute.
    const updated = await this.prisma.stagePayment.updateMany({ where: { id: paymentId, status: 'held', assignment: { disputes: { none: { status: 'open' } } } }, data: { status: 'paid_out', paidOutAt: new Date(), payoutReference: clean, paidOutByStaffId: staffId } });
    if (!updated.count) throw new ConflictException(await hasOpenDispute(this.prisma, payment.assignmentId) ? 'DISPUTE_OPEN' : 'PAYMENT_NOT_HELD');
    await this.prisma.$transaction([
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'payout.paid_out', targetType: 'stage_payment', targetId: paymentId, details: { amount: tenge(payment.payoutTiyn ?? payment.amountTiyn), reference: clean } } }),
      this.prisma.projectEvent.create({ data: { projectId: payment.projectId, type: 'specialist_paid_out', stageKey: payment.assignment.stage.stageKey, details: { paymentId, amount: tenge(payment.payoutTiyn ?? payment.amountTiyn) } } }),
    ]);
    await this.notify(payment.assignment.userId, () => tr('BuildPath перевёл вам {0} ₸ за этап «{1}». Номер перевода: {2}.', [money(payment.payoutTiyn ?? payment.amountTiyn), tr(stageDefinitions[payment.assignment.stage.stageKey as StageKey]?.title ?? ''), clean]));
    return this.payoutQueue();
  }

  /** Staff: switch prepaid billing on or off and set the minimum top-up. Switching on starts counting from now. */
  async updateBillingMode(staffId: string, mode: 'off' | 'prepaid', minTopUpTenge: number, specialistFeePercent: number) {
    if (!Number.isFinite(specialistFeePercent) || specialistFeePercent < 0 || specialistFeePercent > 30) throw new BadRequestException('INVALID_SPECIALIST_FEE');
    if (!Number.isInteger(minTopUpTenge) || minTopUpTenge < 100 || minTopUpTenge > 100_000) throw new BadRequestException('INVALID_MIN_TOP_UP');
    const row = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    if (!row) throw new ConflictException('AI_PRICING_NOT_SET');
    if (mode === 'prepaid' && !activeProvider()) throw new ConflictException('PAYMENTS_NOT_CONFIGURED');
    const prepaidSince = mode === 'prepaid' ? (row.billingMode === 'prepaid' ? row.prepaidSince : new Date()) : row.prepaidSince;
    await this.prisma.$transaction([
      this.prisma.aiPricing.update({ where: { id: 1 }, data: { billingMode: mode, prepaidSince, minTopUpTiyn: minTopUpTenge * 100, specialistFeeBp: Math.round(specialistFeePercent * 100), updatedByStaffId: staffId } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'billing.mode_changed', targetType: 'ai_pricing', targetId: '1', details: { previousMode: row.billingMode, nextMode: mode, minTopUp: minTopUpTenge, previousSpecialistFee: row.specialistFeeBp / 100, specialistFee: specialistFeePercent } } }),
    ]);
    return this.billingModeView();
  }

  async billingModeView() {
    const settings = await billingSettings(this.prisma);
    return { data: { mode: settings.mode, prepaidSince: settings.prepaidSince, minTopUp: tenge(settings.minTopUpTiyn), specialistFeePercent: settings.specialistFeeBp / 100, provider: activeProvider(), priced: settings.priced } };
  }
}
