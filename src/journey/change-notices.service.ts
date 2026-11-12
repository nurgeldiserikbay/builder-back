// Change notices between stages: created when an accepted stage changes, explained by AI on request, decided by
// the dependent stage, reminded and escalated by deadline.
import { inLocale, tr, type Message } from '../i18n/i18n.js';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { ArtifactValidationError } from './artifacts.js';
import { describeChanges } from './change-summary.js';
import { costOf } from '../budget/budget.js';
import { StageAiError } from './stage-ai.js';
import { CHANGE_EXPLANATION_VERSION, buildChangeExplanationPrompt, normalizeChangeExplanation, type ChangeExplanation } from './change-explanation.js';
import { emailConfig, sendEmail } from '../notifications/email.js';
import { escapeHtml } from './site-renderer.js';
import { directDependents, type StatusMap } from './stage-state.js';
import { JourneyCore } from './journey-core.js';
import { acceptRoles, Viewer, editableProject, StageRow } from './journey-core.js';

@Injectable()
export class ChangeNoticesService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  /**
   * A new accepted version of `key` creates a change notice for every stage built directly on it that already has work.
   * The notice pins that stage to the version it was built on until its lead decides (section 11 of the stage model).
   */
  async createChangeNotices(
    tx: Pick<PrismaService, 'changeNotice' | 'projectStage' | 'projectEvent'>,
    ctx: { project: { id: string; changeResponseDays?: number }; route: StageKey[]; stages: StageRow[]; statuses: StatusMap },
    key: StageKey, previousApprovedId: string | null, accepted: { id: string; content: unknown }, userId: string,
  ): Promise<Array<{ targetKey: StageKey }>> {
    const created: Array<{ targetKey: StageKey }> = [];
    const source = this.core.stageOf(ctx, key);
    for (const dependent of directDependents(ctx.route, key)) {
      const target = this.core.stageOf(ctx, dependent);
      const existing = await tx.changeNotice.findFirst({ where: { sourceStageId: source.id, targetStageId: target.id, status: { in: ['open', 'discussing'] } }, select: { id: true, previousVersionId: true } });
      const builtOn = existing?.previousVersionId ?? previousApprovedId;
      if (!builtOn || builtOn === accepted.id) {
        // Back to the version the dependent stage was built on: nothing to decide any more.
        if (existing) await tx.changeNotice.update({ where: { id: existing.id }, data: { status: 'superseded', decidedAt: new Date() } });
        if (existing && target.status === 'stale') {
          const others = await tx.changeNotice.count({ where: { targetStageId: target.id, status: { in: ['open', 'discussing'] }, id: { not: existing.id } } });
          if (!others) await tx.projectStage.update({ where: { id: target.id }, data: { status: 'approved' } });
        }
        continue;
      }
      const hasWork = Boolean(target.currentVersionId) || ['approved', 'imported', 'stale'].includes(target.status);
      if (!hasWork) continue;
      const before = await tx.projectStage.findFirst({ where: { id: source.id }, select: { versions: { where: { id: builtOn }, select: { content: true }, take: 1 } } });
      const changes = describeChanges(key, before?.versions[0]?.content ?? null, accepted.content);
      if (!changes.length) continue;
      if (existing) await tx.changeNotice.update({ where: { id: existing.id }, data: { status: 'superseded', decidedAt: new Date() } });
      const respondBy = new Date(Date.now() + (ctx.project.changeResponseDays ?? 3) * 86_400_000);
      await tx.changeNotice.create({ data: { projectId: ctx.project.id, sourceStageId: source.id, targetStageId: target.id, previousVersionId: builtOn, newVersionId: accepted.id, changes, createdByUserId: userId, respondBy } });
      if (target.status === 'approved' || target.status === 'imported') await tx.projectStage.update({ where: { id: target.id }, data: { status: 'stale' } });
      await this.core.event(tx, ctx.project.id, userId, 'change_notice_created', dependent, { sourceStageKey: key, changes: changes.length });
      created.push({ targetKey: dependent });
    }
    return created;
  }

  /** Who acts for a stage: its active lead specialist, otherwise owners and managers. */
  async stageSide(ctx: { viewer: Viewer; role: string; stages: StageRow[] }, key: StageKey, userId: string): Promise<{ allowed: boolean; asOwner: boolean; leadUserId: string | null }> {
    const stage = this.core.stageOf(ctx, key);
    const lead = await this.prisma.stageAssignment.findFirst({ where: { stageId: stage.id, role: 'lead', status: 'active' }, select: { userId: true } });
    const owner = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    return { allowed: owner || (lead?.userId === userId), asOwner: owner, leadUserId: lead?.userId ?? null };
  }

  async notifyChange(ctx: { project: { ownerUserId: string }; stages: StageRow[] }, key: StageKey, text: Message, _side: 'target' | 'source'): Promise<void> {
    const stage = this.core.stageOf(ctx, key);
    const lead = await this.prisma.stageAssignment.findFirst({ where: { stageId: stage.id, role: 'lead', status: 'active' }, select: { userId: true } });
    const recipients = new Set([ctx.project.ownerUserId, ...(lead?.userId ? [lead.userId] : [])]);
    for (const recipient of recipients) {
      await this.core.notifyUser(recipient, text).catch(() => undefined);
      await this.emailUser(recipient, () => tr("BuildPath: изменения на этапе «{0}»", [tr(stageDefinitions[key].title)]), text).catch(() => undefined);
    }
  }

  /** Change notices also go by e-mail: they wait for a decision, and not everyone uses Telegram. Written in the recipient's account language. */
  async emailUser(userId: string, subject: Message, text: Message): Promise<void> {
    const config = emailConfig();
    if (!config) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, locale: true, deletionRequestedAt: true } });
    if (!user || user.deletionRequestedAt) return;
    const body = inLocale(user.locale, text);
    const html = `<div style="font:15px/1.5 system-ui,sans-serif;max-width:560px">${escapeHtml(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div>`;
    await sendEmail(config, user.email, inLocale(user.locale, subject), html);
  }

  /** Change notices where the stage is the one that changed (outgoing) or the one built on it (incoming). */
  async changeNotices(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const rows = await this.prisma.changeNotice.findMany({
      where: { projectId, OR: [{ targetStageId: stage.id }, { sourceStageId: stage.id }], status: { not: 'superseded' } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: {
        id: true, status: true, changes: true, createdAt: true, decidedAt: true, decidedByOwner: true, createdByUserId: true, decidedByUserId: true,
        sourceStageId: true, targetStageId: true, previousVersionId: true, newVersionId: true, respondBy: true, escalatedAt: true, aiExplanation: true, aiExplainedAt: true,
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, authorUserId: true, side: true, resolution: true, text: true, createdAt: true } },
      },
    });
    const keyById = new Map(ctx.stages.map((item) => [item.id, item.stageKey as StageKey]));
    const versionIds = rows.flatMap((row) => [row.previousVersionId, row.newVersionId]);
    const versions = await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNumber: true } });
    const number = (id: string) => versions.find((version) => version.id === id)?.versionNumber ?? null;
    const people = await this.core.historyPeople(ctx, projectId, userId);
    const person = (id: string | null) => (id ? people.get(id) ?? { id, name: 'Удалённый участник', kind: 'former' as const } : null);
    const sides = new Map<StageKey, Awaited<ReturnType<ChangeNoticesService['stageSide']>>>();
    const side = async (stageKey: StageKey) => {
      if (!sides.has(stageKey)) sides.set(stageKey, await this.stageSide(ctx, stageKey, userId));
      return sides.get(stageKey)!;
    };
    const items = [];
    for (const row of rows) {
      const sourceKey = keyById.get(row.sourceStageId)!; const targetKey = keyById.get(row.targetStageId)!;
      const open = row.status === 'open' || row.status === 'discussing';
      items.push({
        id: row.id, status: row.status, direction: row.targetStageId === stage.id ? 'incoming' as const : 'outgoing' as const,
        source: { key: sourceKey, title: stageDefinitions[sourceKey].title, fromVersion: number(row.previousVersionId), toVersion: number(row.newVersionId) },
        target: { key: targetKey, title: stageDefinitions[targetKey].title },
        changes: row.changes, createdAt: row.createdAt, createdBy: person(row.createdByUserId),
        decidedAt: row.decidedAt, decidedBy: person(row.decidedByUserId), decidedByOwner: row.decidedByOwner,
        respondBy: open ? row.respondBy : null, overdue: open && Boolean(row.respondBy && row.respondBy < new Date()), escalated: open && Boolean(row.escalatedAt),
        explanation: row.aiExplanation ? { ...(row.aiExplanation as object), createdAt: row.aiExplainedAt } : null,
        messages: row.messages.map((message) => ({ ...message, author: person(message.authorUserId) })),
        can: {
          decide: open && (await side(targetKey)).allowed,
          discuss: open && (await side(targetKey)).allowed,
          reply: row.status === 'discussing' && (await side(sourceKey)).allowed,
          explain: open && (await side(targetKey)).allowed && Boolean(this.core.ai()),
        },
      });
    }
    return { data: { items, responseDays: ctx.project.changeResponseDays } };
  }

  /**
   * AI explains a change notice to the side that decides: what changed, what it means for their stage, what to check.
   * It suggests, never decides. Costs one AI request (plan, balance and limits apply); the result is kept on the notice.
   */
  explainChange(userId: string, projectId: string, noticeId: string) {
    return this.core.load(userId, projectId, 'read').then(() => this.core.oneAiRequest(projectId, () => this.explainChangeNow(userId, projectId, noticeId)));
  }

  async explainChangeNow(userId: string, projectId: string, noticeId: string) {
    const notice = await this.prisma.changeNotice.findFirst({ where: { id: noticeId, projectId }, select: { id: true, status: true, changes: true, sourceStageId: true, targetStageId: true, previousVersionId: true, newVersionId: true, aiExplanation: true } });
    if (!notice) throw new NotFoundException('CHANGE_NOT_FOUND');
    if (notice.status !== 'open' && notice.status !== 'discussing') throw new ConflictException('CHANGE_ALREADY_DECIDED');
    const target = await this.prisma.projectStage.findUnique({ where: { id: notice.targetStageId }, select: { stageKey: true, approvedVersionId: true, currentVersionId: true } });
    const source = await this.prisma.projectStage.findUnique({ where: { id: notice.sourceStageId }, select: { stageKey: true } });
    if (!target || !source) throw new NotFoundException('CHANGE_NOT_FOUND');
    const ctx = await this.core.load(userId, projectId, 'read', target.stageKey);
    if (!(await this.stageSide(ctx, target.stageKey as StageKey, userId)).allowed) throw new ForbiddenException('CHANGE_DECISION_FORBIDDEN');
    if (notice.aiExplanation) return this.changeNotices(userId, projectId, target.stageKey);
    const provider = this.core.ai();
    if (!provider) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
    if (await this.core.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    const [before, after, mine] = await Promise.all([
      this.core.versionContent(notice.previousVersionId), this.core.versionContent(notice.newVersionId),
      this.core.versionContent(target.approvedVersionId ?? target.currentVersionId),
    ]);
    const prompt = buildChangeExplanationPrompt({
      sourceTitle: stageDefinitions[source.stageKey as StageKey].title, targetTitle: stageDefinitions[target.stageKey as StageKey].title,
      targetPurpose: stageDefinitions[target.stageKey as StageKey].purpose, changes: notice.changes,
      before: before?.content ?? null, after: after?.content ?? null, target: mine?.content ?? null,
    });
    const started = Date.now();
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    const run = (status: 'succeeded' | 'failed', usage: { inputTokens: number | null; outputTokens: number | null } | null, code: string | null) => this.prisma.generationRun.create({ data: {
      projectId, stageId: notice.targetStageId, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: CHANGE_EXPLANATION_VERSION,
      targetKey: 'change_explanation', inputVersionIds: [notice.previousVersionId, notice.newVersionId], status, safeErrorCode: code, durationMs: Date.now() - started,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
    } });
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    let explanation: ChangeExplanation;
    try {
      const detailed = provider.generateDetailed ? await provider.generateDetailed(prompt) : { output: await provider.generate(prompt), usage: null };
      usage = detailed.usage;
      explanation = normalizeChangeExplanation(detailed.output);
    } catch (error) {
      const code = error instanceof StageAiError ? error.code : error instanceof ArtifactValidationError ? 'AI_OUTPUT_REJECTED' : 'AI_FAILED';
      await run('failed', usage, code);
      if (code === 'AI_OUTPUT_REJECTED') throw new BadGatewayException(code);
      throw new ServiceUnavailableException(code);
    }
    await run('succeeded', usage, null);
    await this.prisma.changeNotice.update({ where: { id: notice.id }, data: { aiExplanation: explanation as object, aiExplainedAt: new Date() } });
    return this.changeNotices(userId, projectId, target.stageKey);
  }

  /**
   * Deadlines of change notices: when the answer is late, remind the deciding side once; two days later ask the owner
   * to decide instead (the owner can always decide for the stage). Returns how many notices were reminded and escalated.
   */
  async processChangeDeadlines(now = new Date()): Promise<{ reminded: number; escalated: number }> {
    const due = await this.prisma.changeNotice.findMany({
      where: { status: { in: ['open', 'discussing'] }, respondBy: { lt: now }, OR: [{ remindedAt: null }, { escalatedAt: null, respondBy: { lt: new Date(now.getTime() - 2 * 86_400_000) } }] },
      take: 100, select: { id: true, projectId: true, respondBy: true, remindedAt: true, sourceStageId: true, targetStageId: true, project: { select: { name: true, ownerUserId: true } } },
    });
    let reminded = 0; let escalated = 0;
    for (const notice of due) {
      const stages = await this.prisma.projectStage.findMany({ where: { id: { in: [notice.sourceStageId, notice.targetStageId] } }, select: { id: true, stageKey: true } });
      const sourceKey = stages.find((item) => item.id === notice.sourceStageId)?.stageKey as StageKey | undefined;
      const targetKey = stages.find((item) => item.id === notice.targetStageId)?.stageKey as StageKey | undefined;
      if (!sourceKey || !targetKey) continue;
      const link = this.core.stageLink(notice.projectId, targetKey);
      const lead = await this.prisma.stageAssignment.findFirst({ where: { stageId: notice.targetStageId, role: 'lead', status: 'active' }, select: { userId: true } });
      if (!notice.remindedAt) {
        const text = () => tr("Ждём решения: этап «{0}» в проекте «{1}» изменился, а этап «{2}» ещё не ответил — срок прошёл. Примите изменения, оставьте этап как есть или обсудите. {3}", [tr(stageDefinitions[sourceKey].title), notice.project.name, tr(stageDefinitions[targetKey].title), link]).trim();
        for (const recipient of new Set([notice.project.ownerUserId, ...(lead?.userId ? [lead.userId] : [])])) {
          await this.core.notifyUser(recipient, text).catch(() => undefined);
          await this.emailUser(recipient, () => tr("BuildPath: ждём решения по этапу «{0}»", [tr(stageDefinitions[targetKey].title)]), text).catch(() => undefined);
        }
        await this.prisma.changeNotice.update({ where: { id: notice.id }, data: { remindedAt: now } });
        reminded += 1;
      } else if (notice.respondBy && notice.respondBy.getTime() < now.getTime() - 2 * 86_400_000) {
        const text = () => tr("Решение по изменению этапа «{0}» в проекте «{1}» задерживается{2}. Вы можете решить за этап «{3}» сами. {4}", [tr(stageDefinitions[sourceKey].title), notice.project.name, lead?.userId ? tr(' — ведущий этапа не ответил') : '', tr(stageDefinitions[targetKey].title), link]).trim();
        await this.core.notifyUser(notice.project.ownerUserId, text).catch(() => undefined);
        await this.emailUser(notice.project.ownerUserId, () => tr("BuildPath: решите за этап «{0}»", [tr(stageDefinitions[targetKey].title)]), text).catch(() => undefined);
        await this.prisma.$transaction([
          this.prisma.changeNotice.update({ where: { id: notice.id }, data: { escalatedAt: now } }),
          this.prisma.projectEvent.create({ data: { projectId: notice.projectId, type: 'change_notice_escalated', stageKey: targetKey, details: { noticeId: notice.id, sourceStageKey: sourceKey } } }),
        ]);
        escalated += 1;
      }
    }
    return { reminded, escalated };
  }

  /** Owner sets how many days the next stage has to answer a change notice. */
  async setChangeResponseDays(userId: string, projectId: string, days: number) {
    const ctx = await this.core.load(userId, projectId, 'read');
    if (!(ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role))) throw new ForbiddenException('PROJECT_SETTINGS_FORBIDDEN');
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new BadRequestException('INVALID_RESPONSE_DAYS');
    await this.prisma.project.update({ where: { id: projectId }, data: { changeResponseDays: days } });
    return { data: { responseDays: days } };
  }

  async actOnChange(userId: string, projectId: string, noticeId: string, input: { action: 'accept' | 'accept_no_change' | 'discuss' | 'reply'; text: string | null; resolution: 'kept' | 'will_revise' | 'escalate' | null }) {
    const notice = await this.prisma.changeNotice.findFirst({ where: { id: noticeId, projectId }, select: { id: true, status: true, sourceStageId: true, targetStageId: true } });
    if (!notice) throw new NotFoundException('CHANGE_NOTICE_NOT_FOUND');
    const ctx = await this.core.load(userId, projectId, 'read');
    const sourceKey = ctx.stages.find((item) => item.id === notice.sourceStageId)!.stageKey as StageKey;
    const targetKey = ctx.stages.find((item) => item.id === notice.targetStageId)!.stageKey as StageKey;
    if (!this.core.canRead(ctx, sourceKey) && !this.core.canRead(ctx, targetKey)) throw new NotFoundException('CHANGE_NOTICE_NOT_FOUND');
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    if (notice.status !== 'open' && notice.status !== 'discussing') throw new ConflictException('CHANGE_NOTICE_CLOSED');
    const targetSide = await this.stageSide(ctx, targetKey, userId);
    const sourceSide = await this.stageSide(ctx, sourceKey, userId);
    const target = this.core.stageOf(ctx, targetKey);
    const sourceTitle = stageDefinitions[sourceKey].title; const targetTitle = stageDefinitions[targetKey].title;

    if (input.action === 'accept' || input.action === 'accept_no_change') {
      if (!targetSide.allowed) throw new ForbiddenException('CHANGE_DECISION_FORBIDDEN');
      const byOwnerOverLead = targetSide.asOwner && Boolean(targetSide.leadUserId) && targetSide.leadUserId !== userId;
      await this.prisma.$transaction(async (tx) => {
        await tx.changeNotice.update({ where: { id: notice.id }, data: { status: input.action === 'accept' ? 'accepted' : 'accepted_no_change', decidedByUserId: userId, decidedAt: new Date(), decidedByOwner: byOwnerOverLead } });
        if (input.text) await tx.changeMessage.create({ data: { noticeId: notice.id, authorUserId: userId, side: byOwnerOverLead ? 'owner' : 'target', text: input.text } });
        const others = await tx.changeNotice.count({ where: { targetStageId: target.id, status: { in: ['open', 'discussing'] } } });
        if (target.status === 'stale' && !others) {
          // Accepting the change means updating this stage; accepting without changes keeps its accepted result.
          await tx.projectStage.update({ where: { id: target.id }, data: { status: input.action === 'accept' ? 'in_progress' : 'approved' } });
        }
        await this.core.event(tx, projectId, userId, input.action === 'accept' ? 'change_accepted' : 'change_accepted_no_change', targetKey, { sourceStageKey: sourceKey, byOwner: byOwnerOverLead });
      });
      if (byOwnerOverLead && targetSide.leadUserId) await this.core.notifyUser(targetSide.leadUserId, () => tr("Владелец проекта «{0}» решил по изменению этапа «{1}»: {2} этап «{3}». {4}", [ctx.project.name, tr(sourceTitle), input.action === 'accept' ? tr('обновить') : tr('оставить без изменений'), tr(targetTitle), this.core.stageLink(projectId, targetKey)]).trim()).catch(() => undefined);
    } else if (input.action === 'discuss') {
      if (!targetSide.allowed) throw new ForbiddenException('CHANGE_DECISION_FORBIDDEN');
      if (!input.text) throw new BadRequestException('TEXT_REQUIRED');
      await this.prisma.$transaction(async (tx) => {
        await tx.changeMessage.create({ data: { noticeId: notice.id, authorUserId: userId, side: 'target', text: input.text! } });
        await tx.changeNotice.update({ where: { id: notice.id }, data: { status: 'discussing' } });
        await this.core.event(tx, projectId, userId, 'change_discussed', targetKey, { sourceStageKey: sourceKey });
      });
      await this.notifyChange(ctx, sourceKey, () => tr("По изменению этапа «{0}» в проекте «{1}» есть вопрос от этапа «{2}»: {3} {4}", [tr(sourceTitle), ctx.project.name, tr(targetTitle), input.text, this.core.stageLink(projectId, sourceKey)]).trim(), 'source');
    } else {
      if (!sourceSide.allowed) throw new ForbiddenException('CHANGE_REPLY_FORBIDDEN');
      if (notice.status !== 'discussing') throw new ConflictException('CHANGE_NOT_DISCUSSED');
      if (!input.text || !input.resolution) throw new BadRequestException('TEXT_REQUIRED');
      await this.prisma.$transaction(async (tx) => {
        await tx.changeMessage.create({ data: { noticeId: notice.id, authorUserId: userId, side: 'source', resolution: input.resolution, text: input.text! } });
        await this.core.event(tx, projectId, userId, 'change_replied', sourceKey, { targetStageKey: targetKey, resolution: input.resolution });
      });
      const what = () => (input.resolution === 'will_revise' ? tr('выпустит исправленную версию') : input.resolution === 'kept' ? tr('оставляет изменение как есть') : tr('просит решить владельца'));
      await this.notifyChange(ctx, targetKey, () => tr("Ответ по изменению этапа «{0}» в проекте «{1}»: {2}. {3} {4}", [tr(sourceTitle), ctx.project.name, what(), input.text, this.core.stageLink(projectId, targetKey)]).trim(), 'target');
    }
    return this.changeNotices(userId, projectId, targetSide.allowed || this.core.canRead(ctx, targetKey) ? targetKey : sourceKey);
  }
}
