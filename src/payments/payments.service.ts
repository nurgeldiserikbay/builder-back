import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { DEFAULT_TOKENS, costOf } from '../budget/budget.js';
import { PaymentProviderError, freedomCallback, freedomCheckout, freedomConfig, freedomReply, type ProviderKey } from './providers.js';
import { billingSettings, projectBalance } from './wallet.js';

const MAX_TOP_UP_TIYN = 50_000_000; // 500 000 ₸
const tenge = (tiyn: number) => tiyn / 100;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Which provider takes payments here: Freedom Pay when configured; the mock only outside production when asked for. */
export function activeProvider(env = process.env): ProviderKey | null {
  if (env.PAYMENTS_PROVIDER === 'mock') return env.NODE_ENV === 'production' ? null : 'mock';
  if (env.PAYMENTS_PROVIDER === 'freedompay' || (!env.PAYMENTS_PROVIDER && freedomConfig(env))) return freedomConfig(env) ? 'freedompay' : null;
  return null;
}
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
      this.prisma.projectTopUp.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, amountTiyn: true, status: true, provider: true, createdAt: true, paidAt: true } }),
    ]);
    const typical = settings.priced ? costOf({ inputTokens: DEFAULT_TOKENS.input, outputTokens: DEFAULT_TOKENS.output }, settings) ?? 0 : 0;
    return {
      data: {
        mode: settings.mode, provider: activeProvider(), currency: 'KZT',
        balance: tenge(balance.balanceTiyn), paid: tenge(balance.paidTiyn), spent: tenge(balance.spentTiyn),
        minTopUp: tenge(settings.minTopUpTiyn), maxTopUp: tenge(MAX_TOP_UP_TIYN), typicalRequest: tenge(typical),
        requestsLeft: typical > 0 ? Math.max(0, Math.floor(balance.balanceTiyn / typical)) : null,
        topUps: topUps.map((item) => ({ ...item, amount: tenge(item.amountTiyn) })),
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
  private async settle(topUpId: string, result: { status: 'paid' | 'failed' | 'pending'; amountTiyn: number | null; currency: string | null; providerPaymentId: string | null }): Promise<'ok' | 'rejected' | 'unknown'> {
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

  /** Local development only: a page that stands in for the provider. */
  async mockPage(topUpId: string): Promise<string> {
    if (activeProvider() !== 'mock') throw new NotFoundException('NOT_FOUND');
    const topUp = isUuid(topUpId) ? await this.prisma.projectTopUp.findUnique({ where: { id: topUpId }, select: { amountTiyn: true, status: true } }) : null;
    if (!topUp) throw new NotFoundException('TOP_UP_NOT_FOUND');
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовая оплата</title>
<body style="font:17px system-ui;max-width:420px;margin:40px auto;padding:0 16px"><p style="background:#fff3cd;padding:10px;border-radius:8px">Тестовая страница оплаты: настоящих денег здесь нет.</p>
<h1>Оплата ${tenge(topUp.amountTiyn).toLocaleString('ru-RU')} ₸</h1><p>Статус: ${topUp.status}</p>
<form method="post" action="/api/v1/payments/mock/${topUpId}"><button name="result" value="paid" style="font:inherit;padding:14px 20px">Оплатить</button> <button name="result" value="failed" style="font:inherit;padding:14px 20px">Отказаться</button></form></body></html>`;
  }

  async mockComplete(topUpId: string, result: string): Promise<string> {
    if (activeProvider() !== 'mock') throw new NotFoundException('NOT_FOUND');
    const topUp = isUuid(topUpId) ? await this.prisma.projectTopUp.findUnique({ where: { id: topUpId }, select: { projectId: true, amountTiyn: true } }) : null;
    if (!topUp) throw new NotFoundException('TOP_UP_NOT_FOUND');
    const paid = result === 'paid';
    await this.settle(topUpId, { status: paid ? 'paid' : 'failed', amountTiyn: topUp.amountTiyn, currency: 'KZT', providerPaymentId: `mock-${topUpId.slice(0, 8)}` });
    return `${appBase()}/projects/${topUp.projectId}?payment=${paid ? 'success' : 'failure'}&topup=${topUpId}`;
  }

  /** Staff: switch prepaid billing on or off and set the minimum top-up. Switching on starts counting from now. */
  async updateBillingMode(staffId: string, mode: 'off' | 'prepaid', minTopUpTenge: number) {
    if (!Number.isInteger(minTopUpTenge) || minTopUpTenge < 100 || minTopUpTenge > 100_000) throw new BadRequestException('INVALID_MIN_TOP_UP');
    const row = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    if (!row) throw new ConflictException('AI_PRICING_NOT_SET');
    if (mode === 'prepaid' && !activeProvider()) throw new ConflictException('PAYMENTS_NOT_CONFIGURED');
    const prepaidSince = mode === 'prepaid' ? (row.billingMode === 'prepaid' ? row.prepaidSince : new Date()) : row.prepaidSince;
    await this.prisma.$transaction([
      this.prisma.aiPricing.update({ where: { id: 1 }, data: { billingMode: mode, prepaidSince, minTopUpTiyn: minTopUpTenge * 100, updatedByStaffId: staffId } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'billing.mode_changed', targetType: 'ai_pricing', targetId: '1', details: { previousMode: row.billingMode, nextMode: mode, minTopUp: minTopUpTenge } } }),
    ]);
    return this.billingModeView();
  }

  async billingModeView() {
    const settings = await billingSettings(this.prisma);
    return { data: { mode: settings.mode, prepaidSince: settings.prepaidSince, minTopUp: tenge(settings.minTopUpTiyn), provider: activeProvider(), priced: settings.priced } };
  }
}
