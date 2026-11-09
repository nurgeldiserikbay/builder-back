import {
  BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus,
  Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  ROUTE_CATALOG_VERSION, projectTypeOf, projectTypes, routeInputs, stageDefinitions, statusExplanations,
  type ArtifactType, type StageKey,
} from './catalog.js';
import {
  ArtifactValidationError, changedKeys, completenessIssues, defaultDesign, emptyBrief, importBriefText, importContentText,
  importOfferText, lockableKeys, stableStringify, mergeProposal, normalizeArtifact, normalizeContent, sectionTypeLabels, templateContent,
  type Brief, type ContentArtifact, type DesignArtifact, type Offer, type SiteArtifact,
} from './artifacts.js';
import { checkSite, corners, fonts, heroLayouts, palettes, renderSite } from './site-renderer.js';
import { StageAiError, buildStagePrompt, configuredStageProvider, type StageAiProvider } from './stage-ai.js';
import {
  canEdit, inputsSatisfied, isSatisfied, nextStage, reopenStage, unlockDependents, type StageStatus, type StatusMap,
} from './stage-state.js';

const writeRoles = new Set(['owner', 'manager', 'contributor']);
const acceptRoles = new Set(['owner', 'manager']);
type Access = 'read' | 'write' | 'accept';

type StageRow = {
  id: string; stageKey: string; position: number; status: StageStatus; currentVersionId: string | null; approvedVersionId: string | null;
  lockedKeys: string[]; approvedAt: Date | null; updatedAt: Date; definitionVersion: string;
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

  constructor(private readonly prisma: PrismaService) {}

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

  private async load(userId: string, projectId: string, access: Access) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: {
        id: true, name: true, status: true, locale: true, projectType: true, startStageKey: true, routeVersion: true,
        members: { where: { userId, status: 'active' }, select: { role: true } },
        stages: { orderBy: { position: 'asc' }, select: { id: true, stageKey: true, position: true, status: true, currentVersionId: true, approvedVersionId: true, lockedKeys: true, approvedAt: true, updatedAt: true, definitionVersion: true } },
      },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const type = projectTypeOf(project.projectType);
    if (!type) throw new ConflictException('PROJECT_HAS_NO_ROUTE');
    const role = project.members[0]?.role ?? 'viewer';
    if (access === 'write' && !writeRoles.has(role)) throw new ForbiddenException('STAGE_WRITE_FORBIDDEN');
    if (access === 'accept' && !acceptRoles.has(role)) throw new ForbiddenException('STAGE_ACCEPT_FORBIDDEN');
    if (access !== 'read' && (project.status === 'archived' || project.status === 'completed')) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const stages = project.stages as StageRow[];
    const route = type.stages.filter((key) => stages.some((stage) => stage.stageKey === key));
    const statuses: StatusMap = Object.fromEntries(stages.map((stage) => [stage.stageKey, stage.status]));
    return { project, type, role, stages, route, statuses };
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

  private async acceptedInputs(ctx: { route: StageKey[]; stages: StageRow[] }, key: StageKey) {
    const result: Record<string, { versionId: string; versionNumber: number; content: unknown }> = {};
    for (const input of routeInputs(ctx.route, key)) {
      const stage = this.stageOf(ctx, input);
      const version = isSatisfied(stage.status) ? await this.versionContent(stage.approvedVersionId) : null;
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
    const next = nextStage(ctx.route, ctx.statuses);
    const nextStatus = next ? ctx.statuses[next] : null;
    const nextText = !next ? 'Все этапы приняты. Скачайте результат или вернитесь к любому этапу, чтобы что-то изменить.'
      : nextStatus === 'stale' ? `Изменился предыдущий этап. Проверьте «${stageDefinitions[next].title}» и подтвердите или обновите.`
        : nextStatus === 'in_progress' ? `Проверьте черновик этапа «${stageDefinitions[next].title}» и примите его, если всё устраивает.`
          : `Начните этап «${stageDefinitions[next].title}». ${stageDefinitions[next].outcome}`;
    const ai = this.ai();
    return {
      data: {
        project: {
          id: ctx.project.id, name: ctx.project.name, status: ctx.project.status, locale: ctx.project.locale, role: ctx.role,
          projectType: ctx.type.key, typeTitle: ctx.type.title, resultExplanation: ctx.type.resultExplanation, startStageKey: ctx.project.startStageKey,
          routeVersion: ctx.project.routeVersion,
        },
        progress: { accepted: approved, total: ctx.route.length, percent: Math.round((approved / ctx.route.length) * 100) },
        nextAction: next ? { stageKey: next, title: stageDefinitions[next].title, text: nextText } : { stageKey: null, title: 'Готово', text: nextText },
        stages: ctx.route.map((key) => {
          const stage = this.stageOf(ctx, key);
          const definition = stageDefinitions[key];
          return {
            key, title: definition.title, purpose: definition.purpose, outcome: definition.outcome, aiLevel: definition.ai.level,
            status: stage.status, statusLabel: statusExplanations[stage.status].label, statusExplanation: statusExplanations[stage.status].explanation,
            inputs: routeInputs(ctx.route, key).map((input) => ({ key: input, title: stageDefinitions[input].title, satisfied: isSatisfied(ctx.statuses[input]) })),
            currentVersionNumber: numberOf(stage.currentVersionId), acceptedVersionNumber: numberOf(stage.approvedVersionId),
            acceptedAt: stage.approvedAt, updatedAt: stage.updatedAt,
          };
        }),
        ai: { configured: Boolean(ai), provider: ai?.name ?? null, remainingToday: ai ? await this.remainingAiRuns(projectId) : 0 },
      },
    };
  }

  async stage(userId: string, projectId: string, key: string) {
    const ctx = await this.load(userId, projectId, 'read');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
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
    return {
      data: {
        stage: {
          key: stageKey, title: definition.title, purpose: definition.purpose, outcome: definition.outcome, artifactType: definition.artifactType,
          status: stage.status, statusLabel: statusExplanations[stage.status].label, statusExplanation: statusExplanations[stage.status].explanation,
          acceptance: definition.acceptance, acceptExplanation: definition.acceptExplanation, importHint: definition.importHint,
          fields: definition.fields ?? null, lockedKeys: stage.lockedKeys, acceptedVersionId: stage.approvedVersionId,
          canEdit: canEdit(stage.status) && writeRoles.has(ctx.role) && ctx.project.status === 'active',
          canAccept: acceptRoles.has(ctx.role) && ctx.project.status === 'active' && Boolean(stage.currentVersionId)
            && (stage.status === 'in_progress' || stage.status === 'stale' || stage.status === 'changes_requested') && inputsSatisfied(ctx.route, ctx.statuses, stageKey),
          canReopen: acceptRoles.has(ctx.role) && ctx.project.status === 'active' && (stage.status === 'approved' || stage.status === 'imported'),
          canImport: Boolean(definition.importHint) && canEdit(stage.status) && writeRoles.has(ctx.role) && ctx.project.status === 'active',
          inputsReady: inputsSatisfied(ctx.route, ctx.statuses, stageKey),
        },
        inputs: routeInputs(ctx.route, stageKey).map((input) => ({
          key: input, title: stageDefinitions[input].title, satisfied: isSatisfied(ctx.statuses[input]),
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
        rules: instructions.filter((item) => item.kind !== 'one_off').map((item) => ({ id: item.id, kind: item.kind, status: item.status, text: item.text, createdAt: item.createdAt })),
        ai: {
          level: definition.ai.level, whatItDoes: definition.ai.whatItDoes, instructionExamples: definition.ai.instructionExamples, describeHint: definition.ai.describeHint ?? null,
          configured: Boolean(ai), remainingToday: ai ? await this.remainingAiRuns(projectId) : 0,
          templateAvailable: !ai && (stageKey === 'content' || stageKey === 'design'),
        },
        options: {
          palettes, fonts, corners, heroLayouts, sectionTypes: sectionTypeLabels,
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
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException(stage.status === 'locked' ? 'STAGE_LOCKED' : 'STAGE_ACCEPTED_REOPEN_FIRST');
    if ((input.baseVersionId ?? null) !== (stage.currentVersionId ?? null)) throw new ConflictException('STAGE_VERSION_CONFLICT');
    let content: unknown;
    try { content = normalizeArtifact(definition.artifactType, input.content); } catch (error) { validationError(error); }
    const base = await this.versionContent(stage.currentVersionId);
    const changed = changedKeys(definition.artifactType, base?.content ?? null, content);
    if (base && changed.length === 0) return { data: { versionId: base.id, versionNumber: base.versionNumber, changed: [] } };
    const valid = new Set(lockableKeys(definition.artifactType, content));
    const locked = [...new Set([...stage.lockedKeys, ...changed])].filter((item) => valid.has(item));
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content, origin: 'owner_edit', note: 'Изменено вручную', userId, lockedKeys: locked });
      await this.event(tx, projectId, userId, 'stage_draft_saved', key, { versionNumber: created.versionNumber, changed });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber, changed } };
  }

  async setLock(userId: string, projectId: string, key: string, lockKey: string, locked: boolean) {
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, key);
    const current = await this.versionContent(stage.currentVersionId);
    const definition = stageDefinitions[key as StageKey];
    if (!current || !lockableKeys(definition.artifactType, current.content).includes(lockKey)) throw new NotFoundException('LOCK_KEY_NOT_FOUND');
    const next = locked ? [...new Set([...stage.lockedKeys, lockKey])] : stage.lockedKeys.filter((item) => item !== lockKey);
    await this.prisma.projectStage.update({ where: { id: stage.id }, data: { lockedKeys: next } });
    return { data: { lockedKeys: next } };
  }

  async addRule(userId: string, projectId: string, key: string, input: { text: string; scope: 'stage_rule' | 'project_rule' }) {
    const ctx = await this.load(userId, projectId, 'write');
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

  async generate(userId: string, projectId: string, key: string, input: { instruction: string | null; saveAs: 'one_off' | 'stage_rule' | 'project_rule'; targetKey: string | null }) {
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (definition.ai.level === 'none') throw new BadRequestException('AI_NOT_USED_FOR_STAGE');
    if (!canEdit(stage.status)) throw new ConflictException(stage.status === 'locked' ? 'STAGE_LOCKED' : 'STAGE_ACCEPTED_REOPEN_FIRST');
    if (!inputsSatisfied(ctx.route, ctx.statuses, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
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
          inputVersionIds: Object.values(inputs).map((item) => item.versionId), baseVersionId: base?.id ?? null, status: 'succeeded', durationMs: Date.now() - started,
        }, select: { id: true } });
        const created = await this.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'template', note: 'Черновик по шаблону (ИИ не подключён)', userId, generationRunId: run.id });
        await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
        await this.event(tx, projectId, userId, 'stage_generated', key, { provider: 'template', versionNumber: created.versionNumber });
        return created;
      });
      return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: 'template' } };
    }

    if (await this.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
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
    const recordFailure = async (code: string) => {
      await this.prisma.generationRun.create({ data: {
        projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
        targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
        baseVersionId: base?.id ?? null, status: 'failed', safeErrorCode: code, durationMs: Date.now() - started,
      } });
    };
    let merged: unknown;
    try {
      const raw = await provider.generate(prompt);
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
        baseVersionId: base?.id ?? null, status: 'succeeded', durationMs: Date.now() - started,
      }, select: { id: true } });
      const created = await this.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'ai_generated',
        note: instruction ? `ИИ: ${instruction.text}` : 'ИИ: черновик', userId, generationRunId: run.id,
      });
      await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
      await this.event(tx, projectId, userId, 'stage_generated', key, { provider: provider.name, versionNumber: created.versionNumber, targetKey: input.targetKey });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: provider.name } };
  }

  async restore(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException('STAGE_ACCEPTED_REOPEN_FIRST');
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
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!definition.importHint) throw new BadRequestException('IMPORT_NOT_SUPPORTED');
    if (!canEdit(stage.status)) throw new ConflictException(stage.status === 'locked' ? 'STAGE_LOCKED' : 'STAGE_ACCEPTED_REOPEN_FIRST');
    let content: unknown;
    try {
      content = definition.artifactType === 'brief' ? importBriefText(text) : definition.artifactType === 'offer' ? importOfferText(text) : importContentText(text);
    } catch (error) { validationError(error); }
    const issues = completenessIssues(definition.artifactType, content);
    // Imported material counts as accepted only when it is complete and its own inputs are accepted.
    const complete = issues.length === 0 && inputsSatisfied(ctx.route, ctx.statuses, stageKey);
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content, origin: 'imported', note: 'Ваши материалы', userId,
        lockedKeys: changedKeys(definition.artifactType, null, content), status: complete ? 'imported' : 'in_progress', accept: complete,
      });
      if (complete) await this.writeStatuses(tx, ctx, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'imported' }));
      await this.event(tx, projectId, userId, 'stage_imported', key, { versionNumber: created.versionNumber, complete });
      return created;
    });
    return { data: { versionId: result.id, versionNumber: result.versionNumber, status: complete ? 'imported' : 'in_progress', issues } };
  }

  async build(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'write');
    const stage = this.stageOf(ctx, 'build');
    if (!canEdit(stage.status)) throw new ConflictException(stage.status === 'locked' ? 'STAGE_LOCKED' : 'STAGE_ACCEPTED_REOPEN_FIRST');
    if (!inputsSatisfied(ctx.route, ctx.statuses, 'build')) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const sources = await this.renderSources(ctx, true);
    const renderInput = { ...sources.input, draft: false };
    const site: SiteArtifact = { html: renderSite(renderInput), checks: checkSite(renderInput), sourceVersionIds: sources.versionIds, compiledAt: new Date().toISOString() };
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.createVersion(tx, { projectId, stage, artifactType: 'site', content: site, origin: 'compiled', note: 'Сборка из принятых этапов', userId });
      await this.event(tx, projectId, userId, 'site_built', 'build', { versionNumber: created.versionNumber, failed: site.checks.filter((check) => check.status === 'failed').map((check) => check.id) });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber, checks: site.checks } };
  }

  /** Accepted versions for a build, or latest drafts for a preview. */
  private async renderSources(ctx: { route: StageKey[]; stages: StageRow[]; project: { locale: string } }, acceptedOnly: boolean) {
    const pick = async (key: StageKey) => {
      if (!ctx.route.includes(key)) return null;
      const stage = this.stageOf(ctx, key);
      const id = acceptedOnly ? (isSatisfied(stage.status) ? stage.approvedVersionId : null) : stage.currentVersionId ?? stage.approvedVersionId;
      return this.versionContent(id);
    };
    const [goal, offer, content, design] = await Promise.all([pick('goal'), pick('offer'), pick('content'), pick('design')]);
    if (!goal || !content) throw new ConflictException(acceptedOnly ? 'STAGE_INPUTS_NOT_ACCEPTED' : 'PREVIEW_NOT_READY');
    if (acceptedOnly && !design) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const versionIds: Record<string, string> = { goal: goal.id, content: content.id };
    if (offer) versionIds.offer = offer.id;
    if (design) versionIds.design = design.id;
    return {
      versionIds,
      input: {
        brief: goal.content as Brief, offer: (offer?.content as Offer | undefined) ?? null, content: content.content as ContentArtifact,
        design: (design?.content as DesignArtifact | undefined) ?? defaultDesign, locale: ctx.project.locale, draft: !acceptedOnly,
      },
    };
  }

  async preview(userId: string, projectId: string, versionId: string | null) {
    const ctx = await this.load(userId, projectId, 'read');
    if (versionId) {
      const build = this.stageOf(ctx, 'build');
      if (!isUuid(versionId)) throw new NotFoundException('VERSION_NOT_FOUND');
      const version = await this.prisma.stageArtifactVersion.findFirst({ where: { id: versionId, stageId: build.id }, select: { content: true, versionNumber: true } });
      if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
      return { data: { html: (version.content as unknown as SiteArtifact).html, draft: false, versionNumber: version.versionNumber } };
    }
    const sources = await this.renderSources(ctx, false);
    return { data: { html: renderSite(sources.input), draft: true, versionNumber: null } };
  }

  async accept(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.load(userId, projectId, 'accept');
    const stage = this.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!['in_progress', 'stale', 'changes_requested'].includes(stage.status)) throw new ConflictException('STAGE_NOT_ACCEPTABLE');
    if (stage.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    if (!inputsSatisfied(ctx.route, ctx.statuses, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const version = await this.versionContent(versionId);
    if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
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
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'approved', approvedVersionId: versionId, approvedAt: new Date(), approvedByUserId: userId } });
      await this.writeStatuses(tx, { project: ctx.project, statuses: { ...ctx.statuses, [stageKey]: 'approved' } }, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'approved' }));
      await this.event(tx, projectId, userId, 'stage_accepted', key, { versionNumber: version.versionNumber });
    });
    return this.journey(userId, projectId);
  }

  async reopen(userId: string, projectId: string, key: string) {
    const ctx = await this.load(userId, projectId, 'accept');
    const stage = this.stageOf(ctx, key);
    if (stage.status !== 'approved' && stage.status !== 'imported') throw new ConflictException('STAGE_NOT_ACCEPTED');
    const next = reopenStage(ctx.route, ctx.statuses, key as StageKey, (dependent) => Boolean(this.stageOf(ctx, dependent).currentVersionId));
    await this.prisma.$transaction(async (tx) => {
      await this.writeStatuses(tx, ctx, next);
      await this.event(tx, projectId, userId, 'stage_reopened', key, { staleStages: Object.entries(next).filter(([, status]) => status === 'stale').map(([item]) => item) });
    });
    return this.journey(userId, projectId);
  }

  async setProjectStatus(userId: string, projectId: string, action: 'complete' | 'resume') {
    const ctx = await this.load(userId, projectId, 'read');
    if (!acceptRoles.has(ctx.role)) throw new ForbiddenException('PROJECT_STATUS_FORBIDDEN');
    const from = action === 'complete' ? ['active', 'paused'] : ['completed', 'paused'];
    if (!from.includes(ctx.project.status)) throw new ConflictException('PROJECT_STATUS_CONFLICT');
    const status = action === 'complete' ? 'completed' : 'active';
    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status } });
      await this.event(tx, projectId, userId, action === 'complete' ? 'project_completed' : 'project_resumed', null, {});
    });
    return this.journey(userId, projectId);
  }

  async result(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId, 'read');
    const stages = await Promise.all(ctx.route.map(async (key) => {
      const stage = this.stageOf(ctx, key);
      const accepted = isSatisfied(stage.status) ? await this.versionContent(stage.approvedVersionId) : null;
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
    const files = [{ name: 'project.md', mimeType: 'text/markdown', content: `${lines.join('\n')}\n` }];
    if (site) files.push({ name: 'site.html', mimeType: 'text/html', content: site.html });
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
