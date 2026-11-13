import { buildAppPlan, type AppFeatures, type AppScreens } from './webapp.js';
// Shared ground of the stage workflow: loading a project with the viewer's access, stage and version helpers,
// events, notifications and the AI provider with its per-project hold. Used by JourneyService, StageAiService and
// ChangeNoticesService.
import { contentLocale, inLocale, runWithLocale, type Message } from '../i18n/i18n.js';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { type BookingConfig, type Schedule } from './schedule.js';
import { type BusinessProcess } from './process.js';
import { TECHPLAN_VERSION, buildTechPlan, type TechPlan } from './techplan.js';
import { PrismaService } from '../database/prisma.service.js';
import { projectTypeOf, routeAncestors, routeInputs, stageDefinitions, type ArtifactType, type StageKey } from './catalog.js';
import { ArtifactValidationError, defaultDesign, normalizeArtifact, contentImageIds, type Brief, type ContentArtifact, type DesignArtifact, type Offer } from './artifacts.js';
import { inlineImages } from '../images/image-processing.js';
import { type ImageInfo } from './site-renderer.js';
import { type Sitemap } from './sitemap.js';
import { type Catalog } from './products.js';
import { configuredStageProvider, type StageAiProvider } from './stage-ai.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { BillingService } from '../billing/billing.service.js';
import { effectiveStatuses, isSatisfied, type StageStatus, type StatusMap } from './stage-state.js';

/** Templates, imports and the architecture are project content: written in the project's language. */
export const inProject = <T>(ctx: { project: { locale: string } }, work: () => T): T => runWithLocale(contentLocale(ctx.project.locale), work);

export const writeRoles = new Set(['owner', 'manager', 'contributor']);
export const acceptRoles = new Set(['owner', 'manager']);
export type Access = 'read' | 'write' | 'accept' | 'members';
export type AssignmentRow = { id: string; stageId: string; stageKey: string; role: 'lead' | 'consultant'; status: string; aiBudget: number | null; aiUsed: number; readUntil: Date | null };
export type Viewer = { kind: 'member'; role: string } | { kind: 'specialist'; assignments: AssignmentRow[] };
export const editableProject = (status: string) => status === 'active' || status === 'live';
export const notEditableCode = (status: string) => (status === 'locked' ? 'STAGE_LOCKED' : status === 'in_review' ? 'STAGE_IN_REVIEW' : 'STAGE_ACCEPTED_REOPEN_FIRST');
export const normalizedOrRaw = (type: ArtifactType, value: unknown) => { try { return normalizeArtifact(type, value); } catch { return value; } };
export const SPECIALIST_READ_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type StageRow = {
  id: string; stageKey: string; position: number; status: StageStatus; currentVersionId: string | null; approvedVersionId: string | null;
  lockedKeys: string[]; approvedAt: Date | null; updatedAt: Date; definitionVersion: string; reviewNote: string | null;
};

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validationError(error: unknown): never {
  if (error instanceof ArtifactValidationError) throw new UnprocessableEntityException(error.code);
  throw error;
}

@Injectable()
export class JourneyCore {
  constructor(readonly prisma: PrismaService, readonly billing: BillingService) {}

  provider: StageAiProvider | null | undefined;

  /**
   * Runs a paid AI request under a hold in the database (BillingService.reserveAi): one request per project at a time,
   * so a double click or a second tab cannot pay twice, and parallel requests cannot spend the same balance.
   * The request records its actual cost before the hold is released.
   */
  async oneAiRequest<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const hold = await this.billing.reserveAi(projectId);
    try { return await run(); } finally { await this.billing.releaseAi(hold).catch(() => undefined); }
  }

  /** Tests may inject a provider; production reads environment configuration. */
  setProvider(provider: StageAiProvider | null): void { this.provider = provider; }
  ai(): StageAiProvider | null {
    if (this.provider === undefined) this.provider = configuredStageProvider();
    return this.provider;
  }
  dailyLimit(): number {
    const value = Number(process.env.BUILDER_AI_DAILY_RUNS_PER_PROJECT ?? 40);
    return Number.isInteger(value) && value > 0 ? value : 40;
  }

  /**
   * Loads a project with the caller's access. Project members act on the whole route; specialists are not members
   * and reach only the stages they are assigned to (STAGE_WORK_MODEL.md, section 7).
   */
  async load(userId: string, projectId: string, access: Access, stageKey?: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, OR: [{ members: { some: { userId, status: 'active' } } }, { assignments: { some: { userId, status: { in: ['active', 'completed'] } } } }] },
      select: {
        id: true, name: true, status: true, locale: true, projectType: true, startStageKey: true, routeVersion: true, ownerUserId: true, changeResponseDays: true,
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

  assignmentFor(ctx: { viewer: Viewer }, key: string): AssignmentRow | null {
    return ctx.viewer.kind === 'specialist' ? ctx.viewer.assignments.find((item) => item.stageKey === key) ?? null : null;
  }

  canRead(ctx: { viewer: Viewer }, key: string): boolean {
    return ctx.viewer.kind === 'member' || Boolean(this.assignmentFor(ctx, key));
  }

  viewerInfo(ctx: { viewer: Viewer; role: string }) {
    if (ctx.viewer.kind === 'member') return { kind: 'member' as const, role: ctx.role, assignments: [] };
    return {
      kind: 'specialist' as const, role: 'specialist',
      assignments: ctx.viewer.assignments.map((item) => ({
        stageKey: item.stageKey, role: item.role, status: item.status, aiBudget: item.aiBudget, aiUsed: item.aiUsed, readUntil: item.readUntil,
      })),
    };
  }

  canWrite(ctx: { viewer: Viewer }, key: string): boolean {
    if (ctx.viewer.kind === 'member') return writeRoles.has(ctx.viewer.role);
    const assignment = this.assignmentFor(ctx, key);
    return assignment?.role === 'lead' && assignment.status === 'active';
  }

  stageOf(ctx: { stages: StageRow[] }, key: string): StageRow {
    const stage = ctx.stages.find((item) => item.stageKey === key);
    if (!stage || !(key in stageDefinitions)) throw new NotFoundException('STAGE_NOT_FOUND');
    return stage;
  }

  async versionContent(id: string | null): Promise<{ id: string; versionNumber: number; content: unknown } | null> {
    if (!id) return null;
    return this.prisma.stageArtifactVersion.findUnique({ where: { id }, select: { id: true, versionNumber: true, content: true } });
  }

  /**
   * A stage that brings branches together (two or more inputs) waits while any stage it is built on still has an undecided
   * change: otherwise the branches could be built on different versions of the same contract.
   */
  waitingBranches(ctx: { route: StageKey[]; openNotices: Array<{ targetKey: StageKey; sourceKey: StageKey }> }, key: StageKey) {
    if (routeInputs(ctx.route, key).length < 2) return [];
    const ancestors = new Set(routeAncestors(ctx.route, key));
    return ctx.openNotices.filter((notice) => ancestors.has(notice.targetKey))
      .map((notice) => ({ stageKey: notice.targetKey, title: stageDefinitions[notice.targetKey].title, sourceKey: notice.sourceKey, sourceTitle: stageDefinitions[notice.sourceKey].title }));
  }

  /** Accepted version of a stage as seen by `forKey`: pinned by an undecided change notice, otherwise the latest accepted one. */
  acceptedVersionId(ctx: { stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>> }, input: StageKey, forKey: StageKey): string | null {
    const pinned = ctx.pins.get(forKey)?.get(input);
    if (pinned) return pinned;
    const stage = this.stageOf(ctx, input);
    return isSatisfied(ctx.dep[input]) ? stage.approvedVersionId : null;
  }

  /** Accepted inputs a completeness check needs: texts of a multi-page site are checked against the accepted map. */
  async checkContext(ctx: Parameters<JourneyCore['acceptedInputs']>[0], key: StageKey): Promise<{ sitemap: Sitemap | null; features?: AppFeatures | null }> {
    // Screens are checked against the accepted functions: every role has screens, every must function is shown.
    if (key === 'screens') return { sitemap: null, features: ((await this.acceptedInputs(ctx, key)).features?.content as AppFeatures | undefined) ?? null };
    if (key !== 'content' || !ctx.route.includes('sitemap')) return { sitemap: null };
    return { sitemap: ((await this.acceptedInputs(ctx, key)).sitemap?.content as Sitemap | undefined) ?? null };
  }

  async acceptedInputs(ctx: { route: StageKey[]; stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>> }, key: StageKey) {
    const result: Record<string, { versionId: string; versionNumber: number; content: unknown }> = {};
    for (const input of routeInputs(ctx.route, key)) {
      const version = await this.versionContent(this.acceptedVersionId(ctx, input, key));
      if (version) result[input] = { versionId: version.id, versionNumber: version.versionNumber, content: version.content };
    }
    return result;
  }

  async remainingAiRuns(projectId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const used = await this.prisma.generationRun.count({ where: { projectId, provider: { not: 'template' }, createdAt: { gte: since } } });
    return Math.max(0, this.dailyLimit() - used);
  }

  async writeStatuses(tx: Pick<PrismaService, 'projectStage'>, ctx: { project: { id: string }; statuses: StatusMap }, next: StatusMap) {
    for (const [key, status] of Object.entries(next)) {
      if (status && ctx.statuses[key as StageKey] !== status) {
        await tx.projectStage.update({ where: { projectId_stageKey: { projectId: ctx.project.id, stageKey: key } }, data: { status } });
      }
    }
  }

  async createVersion(tx: Pick<PrismaService, 'stageArtifactVersion' | 'projectStage'>, input: {
    projectId: string; stage: StageRow; artifactType: ArtifactType; content: unknown; origin: 'owner_edit' | 'ai_generated' | 'template' | 'imported' | 'compiled' | 'restored';
    note: string | null; userId: string; generationRunId?: string | null; lockedKeys?: string[]; status?: StageStatus; accept?: boolean;
  }) {
    // Lock the stage row first: two versions saved at the same moment (an edit and an AI answer) then get consecutive
    // numbers instead of failing on the unique (stage, number) pair.
    await tx.projectStage.update({ where: { id: input.stage.id }, data: { updatedAt: new Date() } });
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

  event(tx: Pick<PrismaService, 'projectEvent'>, projectId: string, userId: string, type: string, stageKey: string | null, details: Record<string, unknown> = {}) {
    return tx.projectEvent.create({ data: { projectId, actorUserId: userId, type, stageKey, details: details as never } });
  }

  async techPlanFor(ctx: Parameters<JourneyCore['acceptedInputs']>[0] & { type: { key: string }; project: { locale: string } }, key: StageKey, notes: string | null): Promise<TechPlan> {
    const inputs = await this.acceptedInputs(ctx, key);
    const schedule = inputs.schedule?.content as Schedule | undefined;
    if (ctx.route.includes('schedule') && !schedule) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    // Built in the project's language, so every viewer gets the same plan whatever their interface language.
    if (ctx.type.key === 'web_app') {
      return inProject(ctx, () => buildAppPlan({
        brief: (inputs.goal?.content as Brief | undefined) ?? null, process: (inputs.process?.content as BusinessProcess | undefined) ?? null,
        features: (inputs.features?.content as AppFeatures | undefined) ?? null, screens: (inputs.screens?.content as AppScreens | undefined) ?? null,
      }, notes));
    }
    return inProject(ctx, () => buildTechPlan({
      projectType: ctx.type.key, brief: (inputs.goal?.content as Brief | undefined) ?? null, schedule: schedule ?? null,
      process: (inputs.process?.content as BusinessProcess | undefined) ?? null, sitemap: (inputs.sitemap?.content as Sitemap | undefined) ?? null,
      store: (inputs.products?.content as Catalog | undefined) ?? null,
    }, notes));
  }

  /** Names for the history: owner and members by name, specialists by name or email. A specialist viewer sees others as roles only. */
  async historyPeople(ctx: { viewer: Viewer; project: { ownerUserId: string } }, projectId: string, viewerId: string) {
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

  /** Accepted versions for a build, or latest drafts for a preview. */
  /** Accepted versions for a build; for a preview, latest drafts (all of them for members, only the specialist's own stages otherwise). */
  async imageInfo(projectId: string, ids: string[]): Promise<Record<string, ImageInfo>> {
    if (!ids.length) return {};
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, id: { in: ids } }, select: { id: true, alt: true, width: true, height: true } });
    return Object.fromEntries(rows.map((row) => [row.id, { alt: row.alt, width: row.width, height: row.height }]));
  }

  /** Replaces /img/<id>.webp references with inline data so the preview and the downloaded file work without the sites server. */
  inline(projectId: string, html: string): Promise<string> {
    return inlineImages(html, async (ids) => {
      const rows = await this.prisma.projectImage.findMany({ where: { projectId, id: { in: ids } }, select: { id: true, data: true } });
      return new Map(rows.map((row) => [row.id, Buffer.from(row.data)]));
    });
  }

  async renderSources(ctx: { route: StageKey[]; stages: StageRow[]; dep: StatusMap; pins: Map<StageKey, Map<StageKey, string>>; project: { id: string; locale: string } }, acceptedOnly: boolean, draftKeys?: string[]) {
    const pick = async (key: StageKey) => {
      if (!ctx.route.includes(key)) return null;
      const stage = this.stageOf(ctx, key);
      const accepted = this.acceptedVersionId(ctx, key, 'build');
      const useDraft = !acceptedOnly && (!draftKeys || draftKeys.includes(key));
      const id = useDraft ? stage.currentVersionId ?? stage.approvedVersionId : accepted;
      return this.versionContent(id);
    };
    const [goal, offer, content, design, schedule, techplan, sitemap, products] = await Promise.all([pick('goal'), pick('offer'), pick('content'), pick('design'), pick('schedule'), pick('techplan'), pick('sitemap'), pick('products')]);
    if (acceptedOnly && ctx.route.includes('products') && !products) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (acceptedOnly && ctx.route.includes('sitemap') && !sitemap) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (acceptedOnly && ctx.route.includes('schedule') && !schedule) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (!goal || !content) throw new ConflictException(acceptedOnly ? 'STAGE_INPUTS_NOT_ACCEPTED' : 'PREVIEW_NOT_READY');
    if (acceptedOnly && !design) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const versionIds: Record<string, string> = { goal: goal.id, content: content.id };
    if (offer) versionIds.offer = offer.id;
    if (design) versionIds.design = design.id;
    if (schedule) versionIds.schedule = schedule.id;
    if (techplan) versionIds.techplan = techplan.id;
    if (sitemap) versionIds.sitemap = sitemap.id;
    if (products) versionIds.products = products.id;
    const store = (products?.content as Catalog | undefined) ?? null;
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
        images: await this.imageInfo(ctx.project.id, [...contentImageIds(content.content), ...(store?.products.map((product) => product.imageId).filter((id): id is string => Boolean(id)) ?? [])]),
        booking,
        contractVersion: (techplan?.content as TechPlan | undefined)?.planVersion ?? null,
        expectedContractVersion: ctx.route.includes('techplan') ? TECHPLAN_VERSION : null,
        sitemap: (sitemap?.content as Sitemap | undefined) ?? null,
        store,
      },
    };
  }

  /** Best-effort Telegram notice to a linked account, in that account's language; the workflow never depends on it. */
  async notifyUser(userId: string, text: Message): Promise<void> {
    const config = telegramConfig();
    if (!config) return;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { chatId: true, user: { select: { locale: true } } } });
    if (identity) await sendTelegramMessage(config, identity.chatId, inLocale(identity.user.locale, text));
  }


  stageLink(projectId: string, key: string): string {
    return process.env.PUBLIC_APP_URL ? new URL(`/projects/${projectId}/stages/${key}`, process.env.PUBLIC_APP_URL).toString() : '';
  }
}
