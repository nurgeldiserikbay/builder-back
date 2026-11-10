import {
  BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus,
  Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { WorktimeService } from './worktime.service.js';
import { SLOT_STEPS, TIMEZONES, WEEKDAYS, templateSchedule, type BookingConfig, type Schedule } from './schedule.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  ROUTE_CATALOG_VERSION, projectTypeOf, projectTypes, routeAncestors, routeInputs, stageDefinitions, statusExplanations,
  type ArtifactType, type StageKey,
} from './catalog.js';
import {
  ArtifactValidationError, changedKeys, completenessIssues, defaultDesign, emptyBrief, importBriefText, importContentText,
  importOfferText, lockableKeys, stableStringify, mergeProposal, normalizeArtifact, normalizeContent, sectionTypeLabels, templateContent,
  contentImageIds, type Brief, type ContentArtifact, type DesignArtifact, type Offer, type SiteArtifact,
} from './artifacts.js';
import { inlineImages } from '../images/image-processing.js';
import { checkSite, corners, fonts, heroLayouts, palettes, renderSite, siteMeta, type ImageInfo } from './site-renderer.js';
import { describeChanges } from './change-summary.js';
import { costOf } from '../budget/budget.js';
import { StageAiError, buildStagePrompt, configuredStageProvider, type StageAiProvider } from './stage-ai.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { BillingService } from '../billing/billing.service.js';
import {
  canEdit, directDependents, effectiveStatuses, inputsSatisfied, isSatisfied, nextStage, reopenStage, unlockDependents, type StageStatus, type StatusMap,
} from './stage-state.js';

const writeRoles = new Set(['owner', 'manager', 'contributor']);
const acceptRoles = new Set(['owner', 'manager']);
type Access = 'read' | 'write' | 'accept' | 'members';
type AssignmentRow = { id: string; stageId: string; stageKey: string; role: 'lead' | 'consultant'; status: string; aiBudget: number | null; aiUsed: number; readUntil: Date | null };
type Viewer = { kind: 'member'; role: string } | { kind: 'specialist'; assignments: AssignmentRow[] };
const editableProject = (status: string) => status === 'active' || status === 'live';
const notEditableCode = (status: string) => (status === 'locked' ? 'STAGE_LOCKED' : status === 'in_review' ? 'STAGE_IN_REVIEW' : 'STAGE_ACCEPTED_REOPEN_FIRST');
const normalizedOrRaw = (type: ArtifactType, value: unknown) => { try { return normalizeArtifact(type, value); } catch { return value; } };
const SPECIALIST_READ_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

type StageRow = {
  id: string; stageKey: string; position: number; status: StageStatus; currentVersionId: string | null; approvedVersionId: string | null;
  lockedKeys: string[]; approvedAt: Date | null; updatedAt: Date; definitionVersion: string; reviewNote: string | null;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validationError(error: unknown): never {
  if (error instanceof ArtifactValidationError) throw new UnprocessableEntityException(error.code);
  throw error;
}

@Injectable()
export class JourneyService {
  private provider: StageAiProvider | null | undefined;

  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly worktime: WorktimeService) {}

  /** Tests may inject a provider; production reads environment configuration. */
  setProvider(provider: StageAiProvider | null): void { this.provider = provider; }
  private ai(): StageAiProvider | null {
    if (this.provider === undefined) this.provider = configuredStageProvider();
    return this.provider;
  }
  private dailyLimit(): number {
    const value = Number(process.env.BUILDER_AI_DAILY_RUNS_PER_PROJECT ?? 40);
    return Number.isInteger(value) && value > 0 ? value : 40;
  }

  catalog() {
    return {
      data: {
        version: ROUTE_CATALOG_VERSION,
        projectTypes: Object.values(projectTypes).map((type) => ({
          ...type,
          stages: type.stages.map((key) => ({ key, title: stageDefinitions[key].title, outcome: stageDefinitions[key].outcome, importHint: stageDefinitions[key].importHint })),
        })),
      },
    };
  }

  /**
   * Loads a project with the caller's access. Project members act on the whole route; specialists are not members
   * and reach only the stages they are assigned to (STAGE_WORK_MODEL.md, section 7).
   */
  private async load(userId: string, projectId: string, access: Access, stageKey?: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, OR: [{ members: { some: { userId, status: 'active' } } }, { assignments: { some: { userId, status: { in: ['active', 'completed'] } } } }] },
      select: {
        id: true, name: true, status: true, locale: true, projectType: true, startStageKey: true, routeVersion: true, ownerUserId: true,
        members: { where: { userId, status: 'active' }, select: { role: true } },
        assignments: { where: { userId, status: { in: ['active', 'completed'] } }, select: { id: true, stageId: true, role: true, status: true, aiBudget: true, aiUsed: true, readUntil: true } },
        stages: { orderBy: { position: 'asc' }, select: { id: true, stageKey: true, position: true, status: true, currentVersionId: true, approvedVersionId: true, lockedKeys: true, approvedAt: true, updatedAt: true, definitionVersion: true, reviewNote: true } },
      },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const type = projectTypeOf(project.projectType);
    if (!type) throw new ConflictException('PROJECT_HAS_NO_ROUTE');
    const stages = project.stages as StageRow[];
    const member = project.members[0] ?? null;
    const now = Date.now();
    const assignments: AssignmentRow[] = project.assignments
      .filter((item) => item.status === 'active' || (item.readUntil && item.readUntil.getTime() > now))
      .map((item) => ({ ...item, stageKey: stages.find((stage) => stage.id === item.stageId)?.stageKey ?? '' }));
    const viewer: Viewer = member ? { kind: 'member', role: member.role } : { kind: 'specialist', assignments };
    if (viewer.kind === 'specialist' && assignments.length === 0) throw new NotFoundException('PROJECT_NOT_FOUND');
    const role = member?.role ?? 'specialist';
    const route = type.stages.filter((key) => stages.some((stage) => stage.stageKey === key));
    const statuses: StatusMap = Object.fromEntries(stages.map((stage) => [stage.stageKey, stage.status]));
    // What dependent stages see: a stage being changed again still provides its last accepted version.
    const dep = effectiveStatuses(statuses, (key) => Boolean(stages.find((stage) => stage.stageKey === key)?.approvedVersionId));
    // Undecided change notices pin the target stage to the source version it was built on.
    const openNotices = await this.prisma.changeNotice.findMany({ where: { projectId, status: { in: ['open', 'discussing'] } }, select: { id: true, sourceStageId: true, targetStageId: true, previousVersionId: true, status: true } });
    const keyById = new Map(stages.map((stage) => [stage.id, stage.stageKey as StageKey]));
    const pins = new Map<StageKey, Map<StageKey, string>>();
    for (const notice of openNotices) {
      const target = keyById.get(notice.targetStageId); const source = keyById.get(notice.sourceStageId);
      if (!target || !source) continue;
      if (!pins.has(target)) pins.set(target, new Map());
      pins.get(target)!.set(source, notice.previousVersionId);
    }
    const ctx = { project, type, role, viewer, stages, route, statuses, dep, pins, openNotices: openNotices.map((notice) => ({ ...notice, sourceKey: keyById.get(notice.sourceStageId)!, targetKey: keyById.get(notice.targetStageId)! })) };
    if (stageKey !== undefined && !this.canRead(ctx, stageKey)) throw new NotFoundException('STAGE_NOT_FOUND');
    if (access === 'write' && !(stageKey !== undefined ? this.canWrite(ctx, stageKey) : viewer.kind === 'member' && writeRoles.has(role))) throw new ForbiddenException('STAGE_WRITE_FORBIDDEN');
    if (access === 'accept' && !(viewer.kind === 'member' && acceptRoles.has(role))) throw new ForbiddenException('STAGE_ACCEPT_FORBIDDEN');
    if (access === 'members' && viewer.kind !== 'member') throw new NotFoundException('PROJECT_NOT_FOUND');
    if ((access === 'write' || access === 'accept') && !editableProject(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    return ctx;
  }

  private assignmentFor(ctx: { viewer: Viewer }, key: string): AssignmentRow | null {
    return ctx.viewer.kind === 'specialist' ? ctx.viewer.assignments.find((item) => item.stageKey === key) ?? null : null;
  }

  private canRead(ctx: { viewer: Viewer }, key: string): boolean {
    return ctx.viewer.kind === 'member' || Boolean(this.assignmentFor(ctx, key));
  }

  private viewerInfo(ctx: { viewer: Viewer; role: string }) {
    if (ctx.viewer.kind === 'member') return { kind: 'member' as const, role: ctx.role, assignments: [] };
    return {
      kind: 'specialist' as const, role: 'specialist',
      assignments: ctx.viewer.assignments.map((item) => ({
        stageKey: item.stageKey, role: item.role, status: item.status, aiBudget: item.aiBudget, aiUsed: item.aiUsed, readUntil: item.readUntil,
      })),
    };
  }

  private canWrite(ctx: { viewer: Viewer }, key: string): boolean {
    if (ctx.viewer.kind === 'member') return writeRoles.has(ctx.viewer.role);
    const assignment = this.assignmentFor(ctx, key);
    return assignment?.role === 'lead' && assignment.status === 'active';
  }

  private stageOf(ctx: { stages: StageRow[] }, key: string): StageRow {
    const stage = ctx.stages.find((item) => item.stageKey === key);
    if (!stage || !(key in stageDefinitions)) throw new NotFoundException('STAGE_NOT_FOUND');
    return stage;
  }

  private async versionContent(id: string | null): Promise<{ id: string; versionNumber: number; content: unknown } | null> {
    if (!id) return null;
    return this.prisma.stageArtifactVersion.findUnique({ where: { id }, select: { id: true, versionNumber: true, content: true } });
  }

  /**
   * A stage that brings branches together (two or more inputs) waits while any stage it is built on still has an undecided
   * change: otherwise the branches could be built on different versions of the same contract.
   */
  private waitingBranches(ctx: { route: StageKey[]; openNotices: Array<{ targetKey: StageKey; sourceKey: StageKey }> }, key: StageKey) {
    if (routeInputs(ctx.route, key).length < 2) return [];
    const ancestors = new Set(routeAncestors(ctx.route, key));
    return ctx.openNotices.filter((notice) => ancestors.has(notice.targetKey))
      .map((notice) => ({ stageKey: notice.targetKey, title: stageDefinitions[notice.targetKey].title, sourceKey: notice.sourceKey, sourceTitle: stageDefinitions[notice.sourceKey].title }));
  }

  /** Accepted version of a stage as seen by `forKey`: pinned by an undecided change notice, otherwise the latest accepted one. */
  private acceptedVersionId(ctx: { stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>> }, input: StageKey, forKey: StageKey): string | null {
    const pinned = ctx.pins.get(forKey)?.get(input);
    if (pinned) return pinned;
    const stage = this.stageOf(ctx, input);
    return isSatisfied(ctx.dep[input]) ? stage.approvedVersionId : null;
  }

  private async acceptedInputs(ctx: { route: StageKey[]; stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>> }, key: StageKey) {
    const result: Record<string, { versionId: string; versionNumber: number; content: unknown }> = {};
    for (const input of routeInputs(ctx.route, key)) {
      const version = await this.versionContent(this.acceptedVersionId(ctx, input, key));
      if (version) result[input] = { versionId: version.id, versionNumber: version.versionNumber, content: version.content };
    }
    return result;
  }

  private async remainingAiRuns(projectId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const used = await this.prisma.generationRun.count({ where: { projectId, provider: { not: 'template' }, createdAt: { gte: since } } });
    return Math.max(0, this.dailyLimit() - used);
  }

  private async writeStatuses(tx: Pick<PrismaService, 'projectStage'>, ctx: { project: { id: string }; statuses: StatusMap }, next: StatusMap) {
    for (const [key, status] of Object.entries(next)) {
      if (status && ctx.statuses[key as StageKey] !== status) {
        await tx.projectStage.update({ where: { projectId_stageKey: { projectId: ctx.project.id, stageKey: key } }, data: { status } });
      }
    }
  }

  async journey(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'read');
    const versionIds = ctx.stages.flatMap((stage) => [stage.currentVersionId, stage.approvedVersionId]).filter((id): id is string => Boolean(id));
    const versions = await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNumber: true } });
    const numberOf = (id: string | null) => versions.find((version) => version.id === id)?.versionNumber ?? null;
    const approved = ctx.route.filter((key) => isSatisfied(ctx.statuses[key])).length;
    const visible = ctx.route.filter((key) => this.canRead(ctx, key));
    const specialist = ctx.viewer.kind === 'specialist';
    const next = specialist ? visible.find((key) => !isSatisfied(ctx.statuses[key])) ?? null : nextStage(ctx.route, ctx.statuses);
    const nextStatus = next ? ctx.statuses[next] : null;
    const title = next ? stageDefinitions[next].title : '';
    const nextText = !next ? (specialist ? 'Ваш этап принят владельцем. Спасибо за работу!' : 'Все этапы приняты. Опубликуйте сайт или скачайте результат ниже. Вернуться к любому этапу можно в любой момент.')
      : next && ctx.openNotices.some((notice) => notice.targetKey === next) ? `Изменился этап, на котором построен «${title}». Посмотрите, что изменилось, и решите: принять, оставить как есть или обсудить.`
      : nextStatus === 'stale' ? `Изменился предыдущий этап. Проверьте «${title}» и подтвердите или обновите.`
        : nextStatus === 'in_review' ? (specialist ? `Этап «${title}» на приёмке у владельца. Пока он проверяет, вносить изменения нельзя.` : `Специалист отправил этап «${title}» на приёмку. Проверьте и примите или верните на доработку.`)
          : nextStatus === 'changes_requested' ? `Владелец попросил доработать этап «${title}».`
            : nextStatus === 'awaiting_lead' ? `Этап «${title}» ждёт, когда приглашённый специалист примет приглашение. Вы можете продолжить сами.`
              : nextStatus === 'in_progress' ? (specialist ? `Доработайте этап «${title}» и отправьте владельцу на приёмку.` : `Проверьте черновик этапа «${title}» и примите его, если всё устраивает.`)
                : `Начните этап «${title}». ${stageDefinitions[next].outcome}`;
    const ai = this.ai();
    // Who works on each stage, for the project map. Owners and managers see specialists; a specialist sees only themself.
    const leads = new Map<string, { kind: 'specialist' | 'invited'; name: string }>();
    const consultants = new Map<string, number>();
    if (!specialist) {
      const rows = await this.prisma.stageAssignment.findMany({
        where: { projectId, status: { in: ['invited', 'active'] } },
        select: { role: true, status: true, email: true, stage: { select: { stageKey: true } }, user: { select: { name: true, email: true } } },
      });
      for (const row of rows) {
        const key = row.stage.stageKey;
        if (row.role === 'lead') leads.set(key, { kind: row.status === 'invited' ? 'invited' : 'specialist', name: row.user?.name || row.user?.email || row.email });
        else consultants.set(key, (consultants.get(key) ?? 0) + 1);
      }
    }
    const canAccept = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const discussing = ctx.openNotices.filter((notice) => notice.status === 'discussing').map((notice) => notice.id);
    const lastSides = discussing.length ? await this.prisma.changeMessage.findMany({ where: { noticeId: { in: discussing } }, orderBy: { createdAt: 'desc' }, distinct: ['noticeId'], select: { noticeId: true, side: true } }) : [];
    const actsFor = (key: StageKey) => {
      if (specialist) { const mine = this.assignmentFor(ctx, key); return mine?.role === 'lead' && mine.status === 'active'; }
      // When a specialist leads the stage, they decide; the owner can step in from the stage page.
      return canAccept && !leads.has(key);
    };
    const needsYou = (key: StageKey): string | null => {
      const status = ctx.statuses[key];
      const incoming = ctx.openNotices.filter((notice) => notice.targetKey === key);
      if (incoming.some((notice) => notice.status === 'open') && actsFor(key)) return 'Изменился вход — решите';
      if (incoming.some((notice) => notice.status === 'discussing' && lastSides.find((row) => row.noticeId === notice.id)?.side === 'source') && actsFor(key)) return 'Есть ответ — решите';
      const waitingForSource = ctx.openNotices.some((notice) => notice.sourceKey === key && notice.status === 'discussing' && lastSides.find((row) => row.noticeId === notice.id)?.side !== 'source');
      if (waitingForSource && actsFor(key)) return 'Ответьте на вопрос по изменению';
      if (specialist) {
        const mine = this.assignmentFor(ctx, key);
        return mine?.role === 'lead' && mine.status === 'active' && (status === 'in_progress' || status === 'changes_requested' || status === 'ready') ? 'Ваш ход' : null;
      }
      if (!canAccept) return null;
      if (status === 'in_review') return 'Проверьте и примите';
      if (status === 'stale') return 'Изменился предыдущий этап';
      if (key === next && !leads.has(key) && (status === 'ready' || status === 'in_progress' || status === 'changes_requested')) return 'Ваш ход';
      return null;
    };
    return {
      data: {
        project: {
          id: ctx.project.id, name: ctx.project.name, status: ctx.project.status, locale: ctx.project.locale, role: ctx.role,
          projectType: ctx.type.key, typeTitle: ctx.type.title, resultExplanation: ctx.type.resultExplanation, startStageKey: ctx.project.startStageKey,
          routeVersion: ctx.project.routeVersion,
        },
        viewer: this.viewerInfo(ctx),
        progress: { accepted: approved, total: ctx.route.length, percent: Math.round((approved / ctx.route.length) * 100) },
        nextAction: next ? { stageKey: next, title: stageDefinitions[next].title, text: nextText } : { stageKey: null, title: 'Готово', text: nextText },
        stages: visible.map((key) => {
          const stage = this.stageOf(ctx, key);
          const definition = stageDefinitions[key];
          return {
            key, title: definition.title, purpose: definition.purpose, outcome: definition.outcome, aiLevel: definition.ai.level, contract: Boolean(definition.contract),
            status: stage.status, statusLabel: statusExplanations[stage.status].label, statusExplanation: statusExplanations[stage.status].explanation,
            inputs: routeInputs(ctx.route, key).map((input) => ({ key: input, title: stageDefinitions[input].title, satisfied: isSatisfied(ctx.dep[input]) })),
            currentVersionNumber: numberOf(stage.currentVersionId), acceptedVersionNumber: numberOf(stage.approvedVersionId),
            acceptedAt: stage.approvedAt, updatedAt: stage.updatedAt,
            people: {
              lead: specialist ? { kind: 'you' as const, name: null } : leads.get(key) ?? { kind: 'owner' as const, name: null },
              consultants: consultants.get(key) ?? 0,
            },
            needsYou: needsYou(key),
            changes: {
              incoming: ctx.openNotices.filter((notice) => notice.targetKey === key).map((notice) => ({ id: notice.id, sourceKey: notice.sourceKey, status: notice.status })),
              outgoing: ctx.openNotices.filter((notice) => notice.sourceKey === key).map((notice) => ({ id: notice.id, targetKey: notice.targetKey, status: notice.status })),
            },
          };
        }),
        ai: { configured: Boolean(ai), provider: ai?.name ?? null, remainingToday: ai ? await this.remainingAiRuns(projectId) : 0, month: ctx.viewer.kind === 'member' ? await this.billing.remainingAi(projectId) : null },
      },
    };
  }

  async stage(userId: string, projectId: string, key: string) {
    const ctx = await this.load(userId, projectId, 'read', key);
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    const changesPending = ctx.openNotices.some((notice) => notice.targetKey === stageKey);
    const waiting = this.waitingBranches(ctx, stageKey);
    // What accepting this stage will do to the stages built on it: start them, or notify those that already have work.
    const dependents = directDependents(ctx.route, stageKey).filter((item) => this.canRead(ctx, item)).map((item) => {
      const dependent = this.stageOf(ctx, item);
      const hasWork = Boolean(dependent.currentVersionId) || ['approved', 'imported', 'stale'].includes(dependent.status);
      return { key: item, title: stageDefinitions[item].title, status: dependent.status, hasWork, opens: dependent.status === 'locked' && inputsSatisfied(ctx.route, { ...ctx.dep, [stageKey]: 'approved' }, item) };
    });
    const inputs = await this.acceptedInputs(ctx, stageKey);
    const [current, versions, instructions] = await Promise.all([
      this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.currentVersionId ?? '00000000-0000-4000-8000-000000000000' }, select: { id: true, versionNumber: true, content: true, origin: true, note: true, createdAt: true, createdByUserId: true, generationRunId: true } }),
      this.prisma.stageArtifactVersion.findMany({ where: { stageId: stage.id }, orderBy: { versionNumber: 'desc' }, take: 30, select: { id: true, versionNumber: true, origin: true, note: true, createdAt: true, generationRunId: true } }),
      this.prisma.stageInstruction.findMany({
        where: { projectId, OR: [{ stageId: stage.id }, { kind: 'project_rule' }] },
        orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, kind: true, status: true, text: true, targetKey: true, createdAt: true, stageId: true },
      }),
    ]);
    const runIds = versions.map((version) => version.generationRunId).filter((id): id is string => Boolean(id));
    const runs = runIds.length ? await this.prisma.generationRun.findMany({ where: { id: { in: runIds } }, select: { id: true, provider: true, model: true, instructionId: true, targetKey: true, ruleIds: true } }) : [];
    const instructionText = (id: string | null) => instructions.find((item) => item.id === id)?.text ?? null;
    const ai = this.ai();
    const site = definition.artifactType === 'site' && current ? current.content as unknown as SiteArtifact : null;
    const assignment = this.assignmentFor(ctx, stageKey);
    // Schedule has no AI: the editor starts from the accepted services and a typical working day.
    const scheduleTemplate = definition.artifactType === 'schedule' && !current
      ? templateSchedule((await this.acceptedInputs(ctx, stageKey)).offer?.content as Offer | undefined ?? null) : null;
    const owner = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role) && editableProject(ctx.project.status);
    const writable = canEdit(stage.status) && this.canWrite(ctx, stageKey) && editableProject(ctx.project.status);
    const suggestions = await this.prisma.stageInstruction.findMany({
      where: { stageId: stage.id, kind: 'suggestion' }, orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, text: true, targetKey: true, status: true, authorUserId: true, createdAt: true },
    });
    const authorIds = [...new Set(suggestions.map((item) => item.authorUserId))];
    const authors = authorIds.length ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } }) : [];
    return {
      data: {
        viewer: this.viewerInfo(ctx),
        suggestions: suggestions.map((item) => {
          const author = authors.find((user) => user.id === item.authorUserId);
          return { id: item.id, text: item.text, targetKey: item.targetKey, status: item.status, createdAt: item.createdAt, author: author?.name ?? author?.email ?? null };
        }),
        stage: {
          key: stageKey, title: definition.title, purpose: definition.purpose, outcome: definition.outcome, artifactType: definition.artifactType,
          status: stage.status, statusLabel: statusExplanations[stage.status].label, statusExplanation: statusExplanations[stage.status].explanation,
          acceptance: definition.acceptance, acceptExplanation: definition.acceptExplanation, importHint: definition.importHint,
          fields: definition.fields ?? null, lockedKeys: stage.lockedKeys, acceptedVersionId: stage.approvedVersionId,
          canEdit: writable,
          canAccept: owner && Boolean(stage.currentVersionId) && !changesPending && waiting.length === 0
            && ['in_progress', 'stale', 'changes_requested', 'in_review'].includes(stage.status) && inputsSatisfied(ctx.route, ctx.dep, stageKey),
          changesPending,
          contract: definition.contract ?? null,
          waitingBranches: waiting,
          impact: {
            opens: dependents.filter((item) => item.opens).map(({ key: itemKey, title }) => ({ key: itemKey, title })),
            willNotify: stage.approvedVersionId ? dependents.filter((item) => item.hasWork).map(({ key: itemKey, title, status }) => ({ key: itemKey, title, status })) : [],
          },
          canReopen: owner && (stage.status === 'approved' || stage.status === 'imported'),
          canImport: Boolean(definition.importHint) && writable,
          canSubmit: Boolean(assignment) && writable && Boolean(stage.currentVersionId) && stage.status !== 'in_review' && !changesPending,
          canRequestChanges: owner && stage.status === 'in_review',
          canInvite: owner,
          canSuggest: assignment?.role === 'consultant' && assignment.status === 'active' && !['approved', 'imported'].includes(stage.status),
          reviewNote: stage.reviewNote,
          inputsReady: inputsSatisfied(ctx.route, ctx.dep, stageKey),
        },
        inputs: routeInputs(ctx.route, stageKey).map((input) => ({
          key: input, title: stageDefinitions[input].title, satisfied: isSatisfied(ctx.dep[input]),
          versionNumber: inputs[input]?.versionNumber ?? null, content: inputs[input]?.content ?? null,
        })),
        current: current ? {
          id: current.id, versionNumber: current.versionNumber, origin: current.origin, note: current.note, createdAt: current.createdAt,
          content: site ? { checks: site.checks, compiledAt: site.compiledAt, sourceVersionIds: site.sourceVersionIds } : current.content,
        } : null,
        issues: current && definition.artifactType !== 'site' ? completenessIssues(definition.artifactType, current.content) : [],
        versions: versions.map((version) => {
          const run = runs.find((item) => item.id === version.generationRunId);
          return {
            id: version.id, versionNumber: version.versionNumber, origin: version.origin, note: version.note, createdAt: version.createdAt,
            accepted: version.id === stage.approvedVersionId,
            provenance: run ? { provider: run.provider, model: run.model, instruction: instructionText(run.instructionId), targetKey: run.targetKey, rulesApplied: run.ruleIds.length } : null,
          };
        }),
        rules: instructions.filter((item) => item.kind === 'stage_rule' || item.kind === 'project_rule').map((item) => ({ id: item.id, kind: item.kind, status: item.status, text: item.text, createdAt: item.createdAt })),
        ai: {
          level: definition.ai.level, whatItDoes: definition.ai.whatItDoes, instructionExamples: definition.ai.instructionExamples, describeHint: definition.ai.describeHint ?? null,
          configured: Boolean(ai), remainingToday: ai ? await this.remainingAiRuns(projectId) : 0,
          budget: assignment ? { limit: assignment.aiBudget, used: assignment.aiUsed } : null,
          month: ctx.viewer.kind === 'member' ? await this.billing.remainingAi(projectId) : null,
          templateAvailable: !ai && (stageKey === 'content' || stageKey === 'design'),
        },
        options: {
          palettes, fonts, corners, heroLayouts, sectionTypes: sectionTypeLabels,
          ...(definition.artifactType === 'schedule' ? { schedule: { template: scheduleTemplate, timezones: TIMEZONES, weekdays: WEEKDAYS, slotSteps: SLOT_STEPS } } : {}),
        },
      },
    };
  }

  private async createVersion(tx: Pick<PrismaService, 'stageArtifactVersion' | 'projectStage'>, input: {
    projectId: string; stage: StageRow; artifactType: ArtifactType; content: unknown; origin: 'owner_edit' | 'ai_generated' | 'template' | 'imported' | 'compiled' | 'restored';
    note: string | null; userId: string; generationRunId?: string | null; lockedKeys?: string[]; status?: StageStatus; accept?: boolean;
  }) {
    const last = await tx.stageArtifactVersion.findFirst({ where: { stageId: input.stage.id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } });
    const version = await tx.stageArtifactVersion.create({
      data: {
        projectId: input.projectId, stageId: input.stage.id, versionNumber: (last?.versionNumber ?? 0) + 1, artifactType: input.artifactType,
        content: input.content as never, origin: input.origin, note: input.note?.slice(0, 300) ?? null, createdByUserId: input.userId, generationRunId: input.generationRunId ?? null,
      },
      select: { id: true, versionNumber: true },
    });
    await tx.projectStage.update({
      where: { id: input.stage.id },
      data: {
        currentVersionId: version.id,
        status: input.status ?? 'in_progress',
        ...(input.lockedKeys ? { lockedKeys: input.lockedKeys } : {}),
        ...(input.accept ? { approvedVersionId: version.id, approvedAt: new Date(), approvedByUserId: input.userId } : {}),
      },
    });
    return version;
  }

  private event(tx: Pick<PrismaService, 'projectEvent'>, projectId: string, userId: string, type: string, stageKey: string | null, details: Record<string, unknown> = {}) {
    return tx.projectEvent.create({ data: { projectId, actorUserId: userId, type, stageKey, details: details as never } });
  }

  async saveDraft(userId: string, projectId: string, key: string, input: { content: unknown; baseVersionId: string | null }) {
    const ctx = await this.load(userId, projectId, 'write', key);
    const stage = this.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if ((input.baseVersionId ?? null) !== (stage.currentVersionId ?? null)) throw new ConflictException('STAGE_VERSION_CONFLICT');
    let content: unknown;
    try { content = normalizeArtifact(definition.artifactType, input.content); } catch (error) { validationError(error); }
    const base = await this.versionContent(stage.currentVersionId);
    const changed = changedKeys(definition.artifactType, base?.content ?? null, content);
    // changedKeys ignores photo choices (they never lock text), so compare whole artifacts to decide whether anything changed.
    if (base && changed.length === 0 && stableStringify(normalizedOrRaw(definition.artifactType, base.content)) === stableStringify(content)) {
      return { data: { versionId: base.id, versionNumber: base.versionNumber, changed: [] } };
    }
    const valid = new Set(lockableKeys(definition.artifactType, content));
    const locked = [...new Set([...stage.lockedKeys, ...changed])].filter((item) => valid.has(item));
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content, origin: 'owner_edit', note: 'Изменено вручную', userId, lockedKeys: locked });
      await this.event(tx, projectId, userId, 'stage_draft_saved', key, { versionNumber: created.versionNumber, changed });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber, changed } };
  }

  async setLock(userId: string, projectId: string, key: string, lockKey: string, locked: boolean) {
    const ctx = await this.load(userId, projectId, 'write', key);
    const stage = this.stageOf(ctx, key);
    const current = await this.versionContent(stage.currentVersionId);
    const definition = stageDefinitions[key as StageKey];
    if (!current || !lockableKeys(definition.artifactType, current.content).includes(lockKey)) throw new NotFoundException('LOCK_KEY_NOT_FOUND');
    const next = locked ? [...new Set([...stage.lockedKeys, lockKey])] : stage.lockedKeys.filter((item) => item !== lockKey);
    await this.prisma.projectStage.update({ where: { id: stage.id }, data: { lockedKeys: next } });
    return { data: { lockedKeys: next } };
  }

  async addRule(userId: string, projectId: string, key: string, input: { text: string; scope: 'stage_rule' | 'project_rule' }) {
    const ctx = await this.load(userId, projectId, 'write', key);
    if (input.scope === 'project_rule' && ctx.viewer.kind !== 'member') throw new ForbiddenException('PROJECT_RULE_FORBIDDEN');
    const stage = this.stageOf(ctx, key);
    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stageInstruction.create({ data: { projectId, stageId: stage.id, authorUserId: userId, kind: input.scope, text: input.text }, select: { id: true, kind: true, status: true, text: true, createdAt: true } });
      await this.event(tx, projectId, userId, 'rule_added', key, { ruleId: created.id, scope: input.scope });
      return created;
    });
    return { data: rule };
  }

  async setRuleStatus(userId: string, projectId: string, ruleId: string, status: 'active' | 'disabled') {
    await this.load(userId, projectId, 'write');
    if (!isUuid(ruleId)) throw new NotFoundException('RULE_NOT_FOUND');
    const updated = await this.prisma.stageInstruction.updateMany({ where: { id: ruleId, projectId, kind: { in: ['stage_rule', 'project_rule'] } }, data: { status } });
    if (updated.count !== 1) throw new NotFoundException('RULE_NOT_FOUND');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'rule_status_changed', details: { ruleId, status } } });
    return { data: { id: ruleId, status } };
  }

  async generate(userId: string, projectId: string, key: string, input: { instruction: string | null; saveAs: 'one_off' | 'stage_rule' | 'project_rule'; targetKey: string | null; source?: 'app' | 'telegram' }) {
    const source = input.source ?? 'app';
    const ctx = await this.load(userId, projectId, 'write', key);
    const assignment = this.assignmentFor(ctx, key);
    if (input.saveAs === 'project_rule' && assignment) throw new ForbiddenException('PROJECT_RULE_FORBIDDEN');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (definition.ai.level === 'none') throw new BadRequestException('AI_NOT_USED_FOR_STAGE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const base = await this.versionContent(stage.currentVersionId);
    if (input.targetKey && (!base || !lockableKeys(definition.artifactType, base.content).includes(input.targetKey))) throw new NotFoundException('TARGET_NOT_FOUND');
    if (stageKey === 'goal' && !base && !input.instruction) throw new BadRequestException('DESCRIPTION_REQUIRED');
    const inputs = await this.acceptedInputs(ctx, stageKey);
    const provider = this.ai();
    const started = Date.now();

    if (!provider) {
      // Without AI the platform still offers a deterministic draft for stages that have one; instructions need AI.
      if (input.instruction || input.targetKey) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
      let draft: unknown;
      if (stageKey === 'content') draft = templateContent(inputs.goal?.content as Brief ?? emptyBrief(), (inputs.offer?.content as Offer | undefined) ?? null);
      else if (stageKey === 'design') draft = defaultDesign;
      else throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
      const merged = normalizeArtifact(definition.artifactType, mergeProposal(definition.artifactType, base?.content ?? null, draft, stage.lockedKeys, null));
      const version = await this.prisma.$transaction(async (tx) => {
        const run = await tx.generationRun.create({ data: {
          projectId, stageId: stage.id, requestedByUserId: userId, provider: 'template', model: null, playbookVersion: definition.playbook.version,
          inputVersionIds: Object.values(inputs).map((item) => item.versionId), baseVersionId: base?.id ?? null, status: 'succeeded', durationMs: Date.now() - started, source,
        }, select: { id: true } });
        const created = await this.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'template', note: 'Черновик по шаблону (ИИ не подключён)', userId, generationRunId: run.id });
        await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
        await this.event(tx, projectId, userId, 'stage_generated', key, { provider: 'template', versionNumber: created.versionNumber });
        return created;
      });
      return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: 'template' } };
    }

    await this.billing.assertCanGenerate(projectId);
    if (await this.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    if (assignment && assignment.aiBudget !== null && assignment.aiUsed >= assignment.aiBudget) throw new HttpException('AI_BUDGET_EXHAUSTED', HttpStatus.TOO_MANY_REQUESTS);
    const rules = await this.prisma.stageInstruction.findMany({
      where: { projectId, status: 'active', OR: [{ kind: 'project_rule' }, { kind: 'stage_rule', stageId: stage.id }] },
      orderBy: { createdAt: 'asc' }, take: 30, select: { id: true, text: true },
    });
    const instruction = input.instruction
      ? await this.prisma.stageInstruction.create({ data: { projectId, stageId: stage.id, authorUserId: userId, kind: input.saveAs, text: input.instruction, targetKey: input.targetKey }, select: { id: true, text: true } })
      : null;
    // A rule saved together with the request is already part of the instruction; do not send it twice.
    const ruleTexts = rules.map((rule) => rule.text);
    const prompt = buildStagePrompt({
      stage: definition, locale: ctx.project.locale, projectTypeTitle: ctx.type.title,
      inputs: Object.fromEntries(Object.entries(inputs).map(([inputKey, value]) => [inputKey, value.content])),
      current: base?.content ?? null, lockedKeys: stage.lockedKeys, targetKey: input.targetKey, rules: ruleTexts, instruction: instruction?.text ?? null,
    });
    // Tokens are spent even when the output is rejected, so failures record usage too.
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const recordFailure = async (code: string) => {
      await this.prisma.generationRun.create({ data: {
        projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
        targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
        baseVersionId: base?.id ?? null, status: 'failed', safeErrorCode: code, durationMs: Date.now() - started, source,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
      } });
    };
    let merged: unknown;
    try {
      const detailed = provider.generateDetailed ? await provider.generateDetailed(prompt) : { output: await provider.generate(prompt), usage: null };
      usage = detailed.usage;
      const raw = detailed.output;
      let proposal: unknown;
      if (definition.artifactType === 'content' && input.targetKey) {
        const section = (raw as { section?: unknown })?.section;
        const baseContent = base!.content as ContentArtifact;
        proposal = input.targetKey === 'seo' ? baseContent : normalizeContent({ sections: [{ ...(section as object), key: input.targetKey }], seo: baseContent.seo });
      } else {
        proposal = normalizeArtifact(definition.artifactType, raw);
      }
      merged = normalizeArtifact(definition.artifactType, mergeProposal(definition.artifactType, base?.content ?? null, proposal, stage.lockedKeys, input.targetKey));
    } catch (error) {
      const code = error instanceof StageAiError ? error.code : error instanceof ArtifactValidationError ? 'AI_OUTPUT_REJECTED' : 'AI_FAILED';
      await recordFailure(code);
      if (code === 'AI_OUTPUT_REJECTED') throw new BadGatewayException(code);
      throw new ServiceUnavailableException(code);
    }
    const version = await this.prisma.$transaction(async (tx) => {
      const run = await tx.generationRun.create({ data: {
        projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
        targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
        baseVersionId: base?.id ?? null, status: 'succeeded', durationMs: Date.now() - started, source,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
      }, select: { id: true } });
      const created = await this.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'ai_generated',
        note: instruction ? `ИИ: ${instruction.text}` : 'ИИ: черновик', userId, generationRunId: run.id,
      });
      await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
      await this.event(tx, projectId, userId, 'stage_generated', key, { provider: provider.name, versionNumber: created.versionNumber, targetKey: input.targetKey });
      if (assignment) await tx.stageAssignment.update({ where: { id: assignment.id }, data: { aiUsed: { increment: 1 } } });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: provider.name } };
  }

  /**
   * History of AI requests (and template drafts) with filters. Owners and managers see the whole project;
   * a specialist sees requests on the stages they are assigned to.
   */
  async aiHistory(userId: string, projectId: string, filter: { stageKey: string | null; authorId: string | null; query: string | null; before: Date | null; limit: number }) {
    const ctx = await this.load(userId, projectId, 'read');
    const readable = ctx.route.filter((key) => this.canRead(ctx, key));
    if (filter.stageKey && !readable.includes(filter.stageKey as StageKey)) throw new NotFoundException('STAGE_NOT_FOUND');
    const stageIds = (filter.stageKey ? [filter.stageKey] : readable).map((key) => this.stageOf(ctx, key).id);
    const keyOf = new Map(ctx.stages.map((stage) => [stage.id, stage.stageKey]));
    const where = {
      projectId, stageId: { in: stageIds },
      ...(filter.authorId ? { requestedByUserId: filter.authorId } : {}),
      ...(filter.before ? { createdAt: { lt: filter.before } } : {}),
    };
    const instructionMatch = filter.query
      ? (await this.prisma.stageInstruction.findMany({ where: { projectId, stageId: { in: stageIds }, text: { contains: filter.query, mode: 'insensitive' } }, select: { id: true }, take: 500 })).map((row) => row.id)
      : null;
    const runs = await this.prisma.generationRun.findMany({
      where: { ...where, ...(instructionMatch ? { instructionId: { in: instructionMatch } } : {}) },
      orderBy: { createdAt: 'desc' }, take: filter.limit + 1,
      select: { id: true, stageId: true, requestedByUserId: true, provider: true, model: true, targetKey: true, instructionId: true, ruleIds: true, resultVersionId: true, status: true, safeErrorCode: true, durationMs: true, source: true, inputTokens: true, outputTokens: true, costTiyn: true, createdAt: true },
    });
    const page = runs.slice(0, filter.limit);
    const instructionIds = [...new Set(page.map((run) => run.instructionId).filter((id): id is string => Boolean(id)))];
    const versionIds = [...new Set(page.map((run) => run.resultVersionId).filter((id): id is string => Boolean(id)))];
    const [instructions, versions, accepted] = await Promise.all([
      this.prisma.stageInstruction.findMany({ where: { id: { in: instructionIds } }, select: { id: true, text: true, kind: true } }),
      this.prisma.stageArtifactVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, stageId: true, versionNumber: true } }),
      this.prisma.projectEvent.findMany({ where: { projectId, type: 'stage_accepted', stageKey: { in: [...new Set(page.map((run) => keyOf.get(run.stageId) ?? ''))] } }, select: { stageKey: true, details: true } }),
    ]);
    const acceptedVersions = new Set(accepted.map((event) => `${event.stageKey}:${(event.details as { versionNumber?: number } | null)?.versionNumber}`));
    const people = await this.historyPeople(ctx, projectId, userId);
    const items = page.map((run) => {
      const key = keyOf.get(run.stageId) as StageKey;
      const stage = this.stageOf(ctx, key);
      const version = versions.find((item) => item.id === run.resultVersionId);
      const instruction = instructions.find((item) => item.id === run.instructionId);
      const outcome = run.status === 'failed' ? 'failed'
        : version && acceptedVersions.has(`${key}:${version.versionNumber}`) ? 'accepted'
          : version && stage.currentVersionId === version.id ? 'current'
            : 'replaced';
      return {
        id: run.id, createdAt: run.createdAt,
        stage: { key, title: stageDefinitions[key].title },
        author: people.get(run.requestedByUserId) ?? { id: run.requestedByUserId, name: 'Удалённый участник', kind: 'former' as const },
        text: instruction?.text ?? null,
        savedAs: instruction?.kind ?? null,
        targetKey: run.targetKey, rulesApplied: run.ruleIds.length,
        kind: run.provider === 'template' ? 'template' as const : 'ai' as const,
        model: run.model, source: run.source,
        tokens: run.inputTokens === null && run.outputTokens === null ? null : { input: run.inputTokens, output: run.outputTokens },
        durationMs: run.durationMs,
        cost: run.costTiyn === null ? null : run.costTiyn / 100,
        result: version ? { versionNumber: version.versionNumber } : null,
        outcome, errorCode: run.safeErrorCode,
      };
    });

    // Summaries over the same filter (without paging and text search).
    const grouped = await this.prisma.generationRun.groupBy({
      by: ['requestedByUserId', 'stageId', 'status'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true },
    });
    const sum = <K extends string>(keyFn: (row: (typeof grouped)[number]) => K) => {
      const totals = new Map<K, { requests: number; failed: number; tokens: number }>();
      for (const row of grouped) {
        const id = keyFn(row);
        const total = totals.get(id) ?? { requests: 0, failed: 0, tokens: 0 };
        total.requests += row._count._all;
        if (row.status === 'failed') total.failed += row._count._all;
        total.tokens += (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0);
        totals.set(id, total);
      }
      return totals;
    };
    const byAuthor = [...sum((row) => row.requestedByUserId)].map(([id, total]) => ({ author: people.get(id) ?? { id, name: 'Удалённый участник', kind: 'former' as const }, ...total }));
    const byStage = [...sum((row) => row.stageId)].map(([id, total]) => {
      const key = keyOf.get(id) as StageKey;
      return { stage: { key, title: stageDefinitions[key].title }, ...total };
    });
    return {
      data: {
        items,
        nextBefore: runs.length > filter.limit ? page[page.length - 1].createdAt : null,
        summary: { byAuthor, byStage, tokensReported: grouped.some((row) => row._sum.inputTokens !== null || row._sum.outputTokens !== null) },
        filters: {
          stages: readable.map((key) => ({ key, title: stageDefinitions[key].title })),
          authors: [...people.values()],
        },
      },
    };
  }

  /** Names for the history: owner and members by name, specialists by name or email. A specialist viewer sees others as roles only. */
  private async historyPeople(ctx: { viewer: Viewer; project: { ownerUserId: string } }, projectId: string, viewerId: string) {
    const people = new Map<string, { id: string; name: string; kind: 'you' | 'owner' | 'member' | 'specialist' | 'former' }>();
    const [members, specialists] = await Promise.all([
      this.prisma.projectMember.findMany({ where: { projectId }, select: { userId: true, user: { select: { name: true, email: true } } } }),
      this.prisma.stageAssignment.findMany({ where: { projectId, userId: { not: null } }, select: { userId: true, email: true, user: { select: { name: true, email: true } } } }),
    ]);
    const hide = ctx.viewer.kind === 'specialist';
    for (const row of members) {
      const owner = row.userId === ctx.project.ownerUserId;
      people.set(row.userId, { id: row.userId, kind: owner ? 'owner' : 'member', name: hide ? (owner ? 'Владелец' : 'Участник') : row.user.name || row.user.email });
    }
    for (const row of specialists) {
      if (!row.userId || people.has(row.userId)) continue;
      people.set(row.userId, { id: row.userId, kind: 'specialist', name: hide ? 'Специалист' : row.user?.name || row.user?.email || row.email });
    }
    const self = people.get(viewerId);
    if (self) people.set(viewerId, { ...self, kind: 'you', name: 'Вы' });
    return people;
  }

  async restore(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.load(userId, projectId, 'write', key);
    const stage = this.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!isUuid(versionId)) throw new NotFoundException('VERSION_NOT_FOUND');
    const source = await this.prisma.stageArtifactVersion.findFirst({ where: { id: versionId, stageId: stage.id }, select: { content: true, versionNumber: true } });
    if (!source) throw new NotFoundException('VERSION_NOT_FOUND');
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content: source.content, origin: 'restored', note: `Возврат к версии ${source.versionNumber}`, userId });
      await this.event(tx, projectId, userId, 'stage_version_restored', key, { from: source.versionNumber, versionNumber: created.versionNumber });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber } };
  }

  async importText(userId: string, projectId: string, key: string, text: string) {
    const ctx = await this.load(userId, projectId, 'write', key);
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!definition.importHint) throw new BadRequestException('IMPORT_NOT_SUPPORTED');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    let content: unknown;
    try {
      content = definition.artifactType === 'brief' ? importBriefText(text) : definition.artifactType === 'offer' ? importOfferText(text) : importContentText(text);
    } catch (error) { validationError(error); }
    const issues = completenessIssues(definition.artifactType, content);
    // Imported material counts as accepted only when it is complete, its own inputs are accepted and the person importing
    // may accept stages. A specialist's import is a draft like any other: the owner accepts it, and that is when they are paid.
    const complete = issues.length === 0 && inputsSatisfied(ctx.route, ctx.dep, stageKey) && ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content, origin: 'imported', note: 'Ваши материалы', userId,
        lockedKeys: changedKeys(definition.artifactType, null, content), status: complete ? 'imported' : 'in_progress', accept: complete,
      });
      if (complete) await this.writeStatuses(tx, ctx, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'imported' }));
      await this.event(tx, projectId, userId, 'stage_imported', key, { versionNumber: created.versionNumber, complete });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: result.id, versionNumber: result.versionNumber, status: complete ? 'imported' : 'in_progress', issues } };
  }

  async build(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'write', 'build');
    const stage = this.stageOf(ctx, 'build');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!inputsSatisfied(ctx.route, ctx.dep, 'build')) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (this.waitingBranches(ctx, 'build').length) throw new ConflictException('BRANCHES_NOT_ALIGNED');
    const sources = await this.renderSources(ctx, true);
    const renderInput = { ...sources.input, draft: false };
    const site: SiteArtifact = { html: renderSite(renderInput), meta: siteMeta(renderInput), checks: checkSite(renderInput), sourceVersionIds: sources.versionIds, compiledAt: new Date().toISOString() };
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, { projectId, stage, artifactType: 'site', content: site, origin: 'compiled', note: 'Сборка из принятых этапов', userId });
      await this.event(tx, projectId, userId, 'site_built', 'build', { versionNumber: created.versionNumber, failed: site.checks.filter((check) => check.status === 'failed').map((check) => check.id) });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber, checks: site.checks } };
  }

  /** Accepted versions for a build, or latest drafts for a preview. */
  /** Accepted versions for a build; for a preview, latest drafts (all of them for members, only the specialist's own stages otherwise). */
  private async imageInfo(projectId: string, ids: string[]): Promise<Record<string, ImageInfo>> {
    if (!ids.length) return {};
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, id: { in: ids } }, select: { id: true, alt: true, width: true, height: true } });
    return Object.fromEntries(rows.map((row) => [row.id, { alt: row.alt, width: row.width, height: row.height }]));
  }

  /** Replaces /img/<id>.webp references with inline data so the preview and the downloaded file work without the sites server. */
  private inline(projectId: string, html: string): Promise<string> {
    return inlineImages(html, async (ids) => {
      const rows = await this.prisma.projectImage.findMany({ where: { projectId, id: { in: ids } }, select: { id: true, data: true } });
      return new Map(rows.map((row) => [row.id, Buffer.from(row.data)]));
    });
  }

  /** Photos belong to the «Структура и тексты» stage: whoever may read or edit that stage may see or change the photo library. */
  async assertImageAccess(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.load(userId, projectId, access, 'content');
    return { projectId: ctx.project.id, ownerUserId: ctx.project.ownerUserId };
  }

  private async renderSources(ctx: { route: StageKey[]; stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>>; project: { id: string; locale: string } }, acceptedOnly: boolean, draftKeys?: string[]) {
    const pick = async (key: StageKey) => {
      if (!ctx.route.includes(key)) return null;
      const stage = this.stageOf(ctx, key);
      const accepted = this.acceptedVersionId(ctx, key, 'build');
      const useDraft = !acceptedOnly && (!draftKeys || draftKeys.includes(key));
      const id = useDraft ? stage.currentVersionId ?? stage.approvedVersionId : accepted;
      return this.versionContent(id);
    };
    const [goal, offer, content, design, schedule] = await Promise.all([pick('goal'), pick('offer'), pick('content'), pick('design'), pick('schedule')]);
    if (acceptedOnly && ctx.route.includes('schedule') && !schedule) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (!goal || !content) throw new ConflictException(acceptedOnly ? 'STAGE_INPUTS_NOT_ACCEPTED' : 'PREVIEW_NOT_READY');
    if (acceptedOnly && !design) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const versionIds: Record<string, string> = { goal: goal.id, content: content.id };
    if (offer) versionIds.offer = offer.id;
    if (design) versionIds.design = design.id;
    if (schedule) versionIds.schedule = schedule.id;
    const offerContent = (offer?.content as Offer | undefined) ?? null;
    const booking: BookingConfig | null = schedule ? {
      schedule: schedule.content as Schedule,
      prices: Object.fromEntries((schedule.content as Schedule).services.map((service) => [service.name, offerContent?.services.find((item) => item.name === service.name)?.price ?? null])),
    } : null;
    return {
      versionIds,
      input: {
        brief: goal.content as Brief, offer: (offer?.content as Offer | undefined) ?? null, content: content.content as ContentArtifact,
        design: (design?.content as DesignArtifact | undefined) ?? defaultDesign, locale: ctx.project.locale, draft: !acceptedOnly,
        images: await this.imageInfo(ctx.project.id, contentImageIds(content.content)),
        booking,
      },
    };
  }

  async preview(userId: string, projectId: string, versionId: string | null) {
    const ctx = await this.load(userId, projectId, 'read');
    const own = ctx.viewer.kind === 'specialist' ? ctx.viewer.assignments.map((item) => item.stageKey) : undefined;
    // A preview shows the page texts, so specialists see it only when their stage works with them.
    if (own && !own.some((key) => ['content', 'design', 'build'].includes(key))) throw new NotFoundException('PREVIEW_NOT_AVAILABLE');
    if (versionId) {
      if (own && !own.includes('build')) throw new NotFoundException('VERSION_NOT_FOUND');
      const build = this.stageOf(ctx, 'build');
      if (!isUuid(versionId)) throw new NotFoundException('VERSION_NOT_FOUND');
      const version = await this.prisma.stageArtifactVersion.findFirst({ where: { id: versionId, stageId: build.id }, select: { content: true, versionNumber: true } });
      if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
      return { data: { html: await this.inline(projectId, (version.content as unknown as SiteArtifact).html), draft: false, versionNumber: version.versionNumber } };
    }
    const sources = await this.renderSources(ctx, false, own);
    return { data: { html: await this.inline(projectId, renderSite(sources.input)), draft: true, versionNumber: null } };
  }

  async accept(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.load(userId, projectId, 'accept', key);
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!['in_progress', 'stale', 'changes_requested', 'in_review'].includes(stage.status)) throw new ConflictException('STAGE_NOT_ACCEPTABLE');
    if (stage.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    if (ctx.openNotices.some((notice) => notice.targetKey === stageKey)) throw new ConflictException('CHANGE_NOTICE_OPEN');
    if (this.waitingBranches(ctx, stageKey).length) throw new ConflictException('BRANCHES_NOT_ALIGNED');
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const version = await this.versionContent(versionId);
    if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
    const notices: Array<{ targetKey: StageKey }> = [];
    if (definition.artifactType === 'site') {
      const site = version.content as unknown as SiteArtifact;
      if (site.checks.some((check) => check.required && check.status === 'failed')) throw new UnprocessableEntityException('REQUIRED_CHECKS_FAILED');
      const sources = await this.renderSources(ctx, true);
      if (stableStringify(sources.versionIds) !== stableStringify(site.sourceVersionIds)) throw new ConflictException('BUILD_OUTDATED');
    } else {
      const issues = completenessIssues(definition.artifactType, version.content);
      if (issues.length) throw new UnprocessableEntityException(`STAGE_INCOMPLETE:${issues.map((issue) => issue.key).join(',')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'approved', approvedVersionId: versionId, approvedAt: new Date(), approvedByUserId: userId, reviewNote: null } });
      // What paid specialists are owed is fixed at acceptance: the fixed price, or approved minutes × rate within the limit.
      await this.worktime.paymentsOnAccept(tx, stage.id, version.versionNumber);
      // Specialists keep read access for a grace period after acceptance; writing and AI use stop now.
      const completed = await tx.stageAssignment.updateMany({
        where: { stageId: stage.id, status: 'active' },
        data: { status: 'completed', completedAt: new Date(), readUntil: new Date(Date.now() + SPECIALIST_READ_GRACE_MS) },
      });
      if (completed.count) await this.event(tx, projectId, userId, 'assignments_completed', key, { count: completed.count });
      await this.writeStatuses(tx, { project: ctx.project, statuses: { ...ctx.statuses, [stageKey]: 'approved' } }, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'approved' }));
      await this.event(tx, projectId, userId, 'stage_accepted', key, { versionNumber: version.versionNumber });
      notices.push(...await this.createChangeNotices(tx, ctx, stageKey, stage.approvedVersionId, version, userId));
    });
    for (const notice of notices) await this.notifyChange(ctx, notice.targetKey, `В проекте «${ctx.project.name}» изменился этап «${definition.title}», на котором построен этап «${stageDefinitions[notice.targetKey].title}». Посмотрите, что изменилось, и решите: принять или обсудить. ${this.stageLink(projectId, notice.targetKey)}`.trim(), 'target');
    return this.journey(userId, projectId);
  }

  /**
   * A new accepted version of `key` creates a change notice for every stage built directly on it that already has work.
   * The notice pins that stage to the version it was built on until its lead decides (section 11 of the stage model).
   */
  private async createChangeNotices(
    tx: Pick<PrismaService, 'changeNotice' | 'projectStage' | 'projectEvent'>,
    ctx: { project: { id: string }; route: StageKey[]; stages: StageRow[]; statuses: StatusMap },
    key: StageKey, previousApprovedId: string | null, accepted: { id: string; content: unknown }, userId: string,
  ): Promise<Array<{ targetKey: StageKey }>> {
    const created: Array<{ targetKey: StageKey }> = [];
    const source = this.stageOf(ctx, key);
    for (const dependent of directDependents(ctx.route, key)) {
      const target = this.stageOf(ctx, dependent);
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
      await tx.changeNotice.create({ data: { projectId: ctx.project.id, sourceStageId: source.id, targetStageId: target.id, previousVersionId: builtOn, newVersionId: accepted.id, changes, createdByUserId: userId } });
      if (target.status === 'approved' || target.status === 'imported') await tx.projectStage.update({ where: { id: target.id }, data: { status: 'stale' } });
      await this.event(tx, ctx.project.id, userId, 'change_notice_created', dependent, { sourceStageKey: key, changes: changes.length });
      created.push({ targetKey: dependent });
    }
    return created;
  }

  /** Who acts for a stage: its active lead specialist, otherwise owners and managers. */
  private async stageSide(ctx: { viewer: Viewer; role: string; stages: StageRow[] }, key: StageKey, userId: string): Promise<{ allowed: boolean; asOwner: boolean; leadUserId: string | null }> {
    const stage = this.stageOf(ctx, key);
    const lead = await this.prisma.stageAssignment.findFirst({ where: { stageId: stage.id, role: 'lead', status: 'active' }, select: { userId: true } });
    const owner = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    return { allowed: owner || (lead?.userId === userId), asOwner: owner, leadUserId: lead?.userId ?? null };
  }

  private async notifyChange(ctx: { project: { ownerUserId: string }; stages: StageRow[] }, key: StageKey, text: string, _side: 'target' | 'source'): Promise<void> {
    const stage = this.stageOf(ctx, key);
    const lead = await this.prisma.stageAssignment.findFirst({ where: { stageId: stage.id, role: 'lead', status: 'active' }, select: { userId: true } });
    const recipients = new Set([ctx.project.ownerUserId, ...(lead?.userId ? [lead.userId] : [])]);
    for (const recipient of recipients) await this.notifyUser(recipient, text).catch(() => undefined);
  }

  /** Change notices where the stage is the one that changed (outgoing) or the one built on it (incoming). */
  async changeNotices(userId: string, projectId: string, key: string) {
    const ctx = await this.load(userId, projectId, 'read', key);
    const stage = this.stageOf(ctx, key);
    const rows = await this.prisma.changeNotice.findMany({
      where: { projectId, OR: [{ targetStageId: stage.id }, { sourceStageId: stage.id }], status: { not: 'superseded' } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: {
        id: true, status: true, changes: true, createdAt: true, decidedAt: true, decidedByOwner: true, createdByUserId: true, decidedByUserId: true,
        sourceStageId: true, targetStageId: true, previousVersionId: true, newVersionId: true,
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, authorUserId: true, side: true, resolution: true, text: true, createdAt: true } },
      },
    });
    const keyById = new Map(ctx.stages.map((item) => [item.id, item.stageKey as StageKey]));
    const versionIds = rows.flatMap((row) => [row.previousVersionId, row.newVersionId]);
    const versions = await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNumber: true } });
    const number = (id: string) => versions.find((version) => version.id === id)?.versionNumber ?? null;
    const people = await this.historyPeople(ctx, projectId, userId);
    const person = (id: string | null) => (id ? people.get(id) ?? { id, name: 'Удалённый участник', kind: 'former' as const } : null);
    const sides = new Map<StageKey, Awaited<ReturnType<JourneyService['stageSide']>>>();
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
        messages: row.messages.map((message) => ({ ...message, author: person(message.authorUserId) })),
        can: {
          decide: open && (await side(targetKey)).allowed,
          discuss: open && (await side(targetKey)).allowed,
          reply: row.status === 'discussing' && (await side(sourceKey)).allowed,
        },
      });
    }
    return { data: { items } };
  }

  async actOnChange(userId: string, projectId: string, noticeId: string, input: { action: 'accept' | 'accept_no_change' | 'discuss' | 'reply'; text: string | null; resolution: 'kept' | 'will_revise' | 'escalate' | null }) {
    const notice = await this.prisma.changeNotice.findFirst({ where: { id: noticeId, projectId }, select: { id: true, status: true, sourceStageId: true, targetStageId: true } });
    if (!notice) throw new NotFoundException('CHANGE_NOTICE_NOT_FOUND');
    const ctx = await this.load(userId, projectId, 'read');
    const sourceKey = ctx.stages.find((item) => item.id === notice.sourceStageId)!.stageKey as StageKey;
    const targetKey = ctx.stages.find((item) => item.id === notice.targetStageId)!.stageKey as StageKey;
    if (!this.canRead(ctx, sourceKey) && !this.canRead(ctx, targetKey)) throw new NotFoundException('CHANGE_NOTICE_NOT_FOUND');
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    if (notice.status !== 'open' && notice.status !== 'discussing') throw new ConflictException('CHANGE_NOTICE_CLOSED');
    const targetSide = await this.stageSide(ctx, targetKey, userId);
    const sourceSide = await this.stageSide(ctx, sourceKey, userId);
    const target = this.stageOf(ctx, targetKey);
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
        await this.event(tx, projectId, userId, input.action === 'accept' ? 'change_accepted' : 'change_accepted_no_change', targetKey, { sourceStageKey: sourceKey, byOwner: byOwnerOverLead });
      });
      if (byOwnerOverLead && targetSide.leadUserId) await this.notifyUser(targetSide.leadUserId, `Владелец проекта «${ctx.project.name}» решил по изменению этапа «${sourceTitle}»: ${input.action === 'accept' ? 'обновить' : 'оставить без изменений'} этап «${targetTitle}». ${this.stageLink(projectId, targetKey)}`.trim()).catch(() => undefined);
    } else if (input.action === 'discuss') {
      if (!targetSide.allowed) throw new ForbiddenException('CHANGE_DECISION_FORBIDDEN');
      if (!input.text) throw new BadRequestException('TEXT_REQUIRED');
      await this.prisma.$transaction(async (tx) => {
        await tx.changeMessage.create({ data: { noticeId: notice.id, authorUserId: userId, side: 'target', text: input.text! } });
        await tx.changeNotice.update({ where: { id: notice.id }, data: { status: 'discussing' } });
        await this.event(tx, projectId, userId, 'change_discussed', targetKey, { sourceStageKey: sourceKey });
      });
      await this.notifyChange(ctx, sourceKey, `По изменению этапа «${sourceTitle}» в проекте «${ctx.project.name}» есть вопрос от этапа «${targetTitle}»: ${input.text} ${this.stageLink(projectId, sourceKey)}`.trim(), 'source');
    } else {
      if (!sourceSide.allowed) throw new ForbiddenException('CHANGE_REPLY_FORBIDDEN');
      if (notice.status !== 'discussing') throw new ConflictException('CHANGE_NOT_DISCUSSED');
      if (!input.text || !input.resolution) throw new BadRequestException('TEXT_REQUIRED');
      await this.prisma.$transaction(async (tx) => {
        await tx.changeMessage.create({ data: { noticeId: notice.id, authorUserId: userId, side: 'source', resolution: input.resolution, text: input.text! } });
        await this.event(tx, projectId, userId, 'change_replied', sourceKey, { targetStageKey: targetKey, resolution: input.resolution });
      });
      const what = input.resolution === 'will_revise' ? 'выпустит исправленную версию' : input.resolution === 'kept' ? 'оставляет изменение как есть' : 'просит решить владельца';
      await this.notifyChange(ctx, targetKey, `Ответ по изменению этапа «${sourceTitle}» в проекте «${ctx.project.name}»: ${what}. ${input.text} ${this.stageLink(projectId, targetKey)}`.trim(), 'target');
    }
    return this.changeNotices(userId, projectId, targetSide.allowed || this.canRead(ctx, targetKey) ? targetKey : sourceKey);
  }

  async reopen(userId: string, projectId: string, key: string) {
    const ctx = await this.load(userId, projectId, 'accept', key);
    const stage = this.stageOf(ctx, key);
    if (stage.status !== 'approved' && stage.status !== 'imported') throw new ConflictException('STAGE_NOT_ACCEPTED');
    const next = reopenStage(ctx.statuses, key as StageKey);
    await this.prisma.$transaction(async (tx) => {
      await this.writeStatuses(tx, ctx, next);
      await this.event(tx, projectId, userId, 'stage_reopened', key, {});
    });
    return this.journey(userId, projectId);
  }

  /** Best-effort Telegram notice to a linked account; the workflow never depends on it. */
  private async notifyUser(userId: string, text: string): Promise<void> {
    const config = telegramConfig();
    if (!config) return;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { chatId: true } });
    if (identity) await sendTelegramMessage(config, identity.chatId, text);
  }

  private stageLink(projectId: string, key: string): string {
    return process.env.PUBLIC_APP_URL ? new URL(`/projects/${projectId}/stages/${key}`, process.env.PUBLIC_APP_URL).toString() : '';
  }

  async submit(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.load(userId, projectId, 'write', key);
    if (ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role)) throw new ConflictException('OWNER_ACCEPTS_DIRECTLY');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    if (!['in_progress', 'stale', 'changes_requested'].includes(stage.status)) throw new ConflictException('STAGE_NOT_SUBMITTABLE');
    if (stage.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    if (ctx.openNotices.some((notice) => notice.targetKey === stageKey)) throw new ConflictException('CHANGE_NOTICE_OPEN');
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const version = await this.versionContent(versionId);
    const definition = stageDefinitions[stageKey];
    if (version && definition.artifactType !== 'site') {
      const issues = completenessIssues(definition.artifactType, version.content);
      if (issues.length) throw new UnprocessableEntityException(`STAGE_INCOMPLETE:${issues.map((issue) => issue.key).join(',')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'in_review' } });
      await this.event(tx, projectId, userId, 'stage_submitted', key, { versionNumber: version?.versionNumber ?? null });
    });
    await this.notifyUser(ctx.project.ownerUserId, `Этап «${definition.title}» в проекте «${ctx.project.name}» отправлен вам на приёмку. ${this.stageLink(projectId, key)}`.trim()).catch(() => undefined);
    await this.worktime.recordAction(userId, projectId, key);
    return this.journey(userId, projectId);
  }

  async requestChanges(userId: string, projectId: string, key: string, note: string) {
    const ctx = await this.load(userId, projectId, 'accept', key);
    const stage = this.stageOf(ctx, key);
    if (stage.status !== 'in_review') throw new ConflictException('STAGE_NOT_IN_REVIEW');
    await this.prisma.$transaction(async (tx) => {
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'changes_requested', reviewNote: note } });
      await this.event(tx, projectId, userId, 'stage_changes_requested', key, {});
    });
    const leads = await this.prisma.stageAssignment.findMany({ where: { stageId: stage.id, status: 'active', role: 'lead' }, select: { userId: true } });
    for (const lead of leads) {
      if (lead.userId) await this.notifyUser(lead.userId, `Владелец проекта «${ctx.project.name}» просит доработать этап «${stageDefinitions[key as StageKey].title}»: ${note} ${this.stageLink(projectId, key)}`.trim()).catch(() => undefined);
    }
    return this.journey(userId, projectId);
  }

  async suggest(userId: string, projectId: string, key: string, input: { text: string; targetKey: string | null }) {
    const ctx = await this.load(userId, projectId, 'read', key);
    const assignment = this.assignmentFor(ctx, key);
    if (assignment?.role !== 'consultant' || assignment.status !== 'active') throw new ForbiddenException('SUGGEST_FORBIDDEN');
    const stage = this.stageOf(ctx, key);
    if (stage.status === 'approved' || stage.status === 'imported') throw new ConflictException('STAGE_ACCEPTED_REOPEN_FIRST');
    const created = await this.prisma.$transaction(async (tx) => {
      const suggestion = await tx.stageInstruction.create({
        data: { projectId, stageId: stage.id, authorUserId: userId, kind: 'suggestion', status: 'proposed', text: input.text, targetKey: input.targetKey },
        select: { id: true, text: true, targetKey: true, status: true, createdAt: true },
      });
      await this.event(tx, projectId, userId, 'suggestion_added', key, { suggestionId: suggestion.id });
      return suggestion;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: created };
  }

  async resolveSuggestion(userId: string, projectId: string, key: string, suggestionId: string, action: 'apply' | 'dismiss') {
    const ctx = await this.load(userId, projectId, 'write', key);
    const stage = this.stageOf(ctx, key);
    if (!isUuid(suggestionId)) throw new NotFoundException('SUGGESTION_NOT_FOUND');
    const suggestion = await this.prisma.stageInstruction.findFirst({ where: { id: suggestionId, stageId: stage.id, kind: 'suggestion', status: 'proposed' }, select: { id: true, text: true, targetKey: true } });
    if (!suggestion) throw new NotFoundException('SUGGESTION_NOT_FOUND');
    let result: unknown = null;
    if (action === 'apply') {
      // The suggestion becomes an AI instruction from the person who accepted it; failures leave it proposed.
      const current = await this.versionContent(stage.currentVersionId);
      const definition = stageDefinitions[key as StageKey];
      const target = suggestion.targetKey && current && lockableKeys(definition.artifactType, current.content).includes(suggestion.targetKey) ? suggestion.targetKey : null;
      result = (await this.generate(userId, projectId, key, { instruction: suggestion.text, saveAs: 'one_off', targetKey: target })).data;
    }
    await this.prisma.stageInstruction.update({ where: { id: suggestion.id }, data: { status: action === 'apply' ? 'applied' : 'dismissed' } });
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: action === 'apply' ? 'suggestion_applied' : 'suggestion_dismissed', stageKey: key, details: { suggestionId } } });
    return { data: { id: suggestion.id, status: action === 'apply' ? 'applied' : 'dismissed', generation: result } };
  }

  async setProjectStatus(userId: string, projectId: string, action: 'complete' | 'resume' | 'archive' | 'unarchive') {
    const ctx = await this.load(userId, projectId, 'members');
    // Archiving and restoring change plan usage, so only the owner may do them.
    const ownerOnly = action === 'archive' || action === 'unarchive';
    if (ownerOnly ? ctx.role !== 'owner' : !acceptRoles.has(ctx.role)) throw new ForbiddenException('PROJECT_STATUS_FORBIDDEN');
    const from: Record<typeof action, string[]> = {
      complete: ['active', 'paused'], resume: ['completed', 'paused'], archive: ['active', 'paused', 'completed', 'draft'], unarchive: ['archived'],
    };
    if (action === 'archive' && ctx.project.status === 'live') throw new ConflictException('UNPUBLISH_BEFORE_ARCHIVE');
    if (!from[action].includes(ctx.project.status)) throw new ConflictException('PROJECT_STATUS_CONFLICT');
    if (action === 'unarchive') await this.billing.assertCanCreateProject(ctx.project.ownerUserId);
    const status = action === 'complete' ? 'completed' : action === 'archive' ? 'archived' : 'active';
    const eventType = { complete: 'project_completed', resume: 'project_resumed', archive: 'project_archived', unarchive: 'project_unarchived' }[action];
    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status } });
      // Specialists stop working on an archived project.
      if (action === 'archive') await tx.stageAssignment.updateMany({ where: { projectId, status: { in: ['invited', 'active'] } }, data: { status: 'revoked', revokedAt: new Date() } });
      await this.event(tx, projectId, userId, eventType, null, {});
    });
    return this.journey(userId, projectId);
  }

  /** Project membership for other modules: role, whether the viewer may decide for the project, name and status. */
  async projectAccess(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'members');
    return { role: ctx.role, canDecide: acceptRoles.has(ctx.role), name: ctx.project.name, status: ctx.project.status, hasSpecialists: (await this.prisma.stageAssignment.count({ where: { projectId, status: { in: ['invited', 'active', 'completed'] } } })) > 0 };
  }

  async result(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'members');
    const stages = await Promise.all(ctx.route.map(async (key) => {
      const stage = this.stageOf(ctx, key);
      const accepted = isSatisfied(ctx.dep[key]) ? await this.versionContent(stage.approvedVersionId) : null;
      return { key, title: stageDefinitions[key].title, status: stage.status, statusLabel: statusExplanations[stage.status].label, accepted };
    }));
    const get = <T>(key: StageKey) => stages.find((stage) => stage.key === key)?.accepted?.content as T | undefined;
    const brief = get<Brief>('goal');
    const offer = get<Offer>('offer');
    const content = get<ContentArtifact>('content');
    const site = get<SiteArtifact>('build');
    const openItems = stages.filter((stage) => !stage.accepted).map((stage) => `Этап «${stage.title}» не принят (${stage.statusLabel.toLowerCase()}).`);
    const lines: string[] = [`# ${ctx.project.name}`, '', `Тип проекта: ${ctx.type.title}`, `Сформировано: ${new Date().toISOString()}`, ''];
    for (const stage of stages) lines.push(`- ${stage.title}: ${stage.accepted ? `принят, версия ${stage.accepted.versionNumber}` : stage.statusLabel.toLowerCase()}`);
    if (brief) {
      lines.push('', '## Паспорт проекта', '', `- Название: ${brief.businessName}`, `- Чем занимаемся: ${brief.whatYouDo}`, `- Клиенты: ${brief.audience}`);
      if (brief.city) lines.push(`- Город: ${brief.city}`);
      for (const [label, value] of [['Телефон', brief.phone], ['Мессенджер', brief.messenger], ['Email', brief.email], ['Адрес', brief.address]] as const) if (value) lines.push(`- ${label}: ${value}`);
    }
    if (offer) {
      lines.push('', '## Услуги', '');
      for (const service of offer.services) lines.push(`- ${service.name}${service.price ? ` — ${service.price}` : ''}${service.description ? `. ${service.description}` : ''}`);
      if (offer.hours) lines.push('', `Часы работы: ${offer.hours}`);
    }
    const schedule = get<Schedule>('schedule');
    if (schedule) {
      lines.push('', '## Расписание и запись', '', `Часовой пояс: ${schedule.timezone}. Шаг времени: ${schedule.rules.slotStep} мин. Запись не позже чем за ${schedule.rules.minNoticeHours} ч, на ${schedule.rules.horizonDays} дн. вперёд; отмена клиентом — не позже чем за ${schedule.rules.cancelHours} ч.`, '');
      for (const service of schedule.services) lines.push(`- ${service.name}: ${service.minutes} мин`);
      for (const master of schedule.masters) {
        const days = master.week.map((day, index) => (day ? `${WEEKDAYS[index]} ${day.from}–${day.to}` : null)).filter(Boolean).join(', ');
        lines.push(`- Мастер ${master.name}: ${master.services.length ? master.services.join(', ') : 'все услуги'}; ${days || 'нет рабочих дней'}`);
      }
    }
    if (content) {
      lines.push('', '## Тексты сайта', '', `Заголовок для поиска: ${content.seo.title}`, `Описание для поиска: ${content.seo.description}`);
      for (const section of content.sections) {
        lines.push('', `### ${section.title || sectionTypeLabels[section.type]}`, '');
        if (section.text) lines.push(section.text);
        for (const item of section.items) lines.push(`- ${item.title}${item.text ? ` — ${item.text}` : ''}`);
        if (section.buttonLabel) lines.push(`[Кнопка: ${section.buttonLabel}]`);
      }
    }
    if (openItems.length) lines.push('', '## Что ещё не сделано', '', ...openItems.map((item) => `- ${item}`));
    if (site?.meta?.hasForm) lines.push('', '> Форма заявки работает, когда сайт опубликован на BuildPath. На другом хостинге форму нужно подключить к своему обработчику.');
    const files = [{ name: 'project.md', mimeType: 'text/markdown', content: `${lines.join('\n')}\n` }];
    if (site) files.push({ name: 'site.html', mimeType: 'text/html', content: await this.inline(projectId, site.html) });
    files.push({
      name: 'project.json', mimeType: 'application/json',
      content: JSON.stringify({
        catalogVersion: ROUTE_CATALOG_VERSION, project: { name: ctx.project.name, type: ctx.type.key },
        stages: stages.map((stage) => ({ key: stage.key, status: stage.status, acceptedVersion: stage.accepted?.versionNumber ?? null, content: stage.key === 'build' ? undefined : stage.accepted?.content ?? null })),
        openItems,
      }, null, 2),
    });
    await this.event(this.prisma, projectId, userId, 'result_downloaded', null, { stages: stages.map((stage) => ({ key: stage.key, version: stage.accepted?.versionNumber ?? null })) });
    return { data: { generatedAt: new Date().toISOString(), complete: openItems.length === 0, openItems, siteReady: Boolean(site), files } };
  }
}
