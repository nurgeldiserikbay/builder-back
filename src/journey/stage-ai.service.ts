// AI requests on a stage (drafts, targeted rewrites) and their history.
import { templatePaths } from './paths.js';
import { templateConcept } from './concept.js';
import { tr } from '../i18n/i18n.js';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WorktimeService } from './worktime.service.js';
import { templateProcess } from './process.js';
import { templateIdea, type IdeaReview } from './idea.js';
import { templateSuggestions, type Suggestions } from './suggestions.js';
import { PrismaService } from '../database/prisma.service.js';
import { stageFor, type StageKey, definitionOf } from './catalog.js';
import { ArtifactValidationError, changedKeys, completenessIssues, defaultDesign, emptyBrief, emptyStory, briefFromStory, briefOf, lockableKeys, mergeProposal, normalizeArtifact, normalizeContent, templateContent, type Brief, type Story, type ContentArtifact, type Offer, aiLocksFor } from './artifacts.js';
import { templateSitemap, type Sitemap } from './sitemap.js';
import type { BusinessProcess } from './process.js';
import { templateFeatures, templateScreens, type AppFeatures } from './webapp.js';
import { costOf } from '../budget/budget.js';
import { StageAiError, buildStagePrompt } from './stage-ai.js';
import { normalizeAiOutput } from './ai-normalize.js';
import { techPlanDesign, techPlanNotes, type TechPlan } from './techplan.js';
import { markAiCases, type TestPlan } from './testplan.js';
import { normalizeDesign, type ArchitectureDesign } from './architecture.js';
import { reviewStage, type ReviewFinding } from './stage-review.js';
import { canEdit, inputsSatisfied } from './stage-state.js';
import { JourneyCore } from './journey-core.js';
import { inProject, Access, notEditableCode, normalizeFor } from './journey-core.js';

type GenerateInput = { instruction: string | null; saveAs: 'one_off' | 'stage_rule' | 'project_rule'; targetKey: string | null; source?: 'app' | 'telegram'; conversation?: Record<string, string> | null };
export type AiProposal = { proposalId: string; baseVersionId: string | null; content: unknown; changed: string[]; issues: Array<{ key: string; message: string }>; findings: ReviewFinding[]; blockedByLocks: string[] };

@Injectable()
export class StageAiService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly worktime: WorktimeService) {}

  generate(userId: string, projectId: string, key: string, input: GenerateInput) {
    // Drafts by template (no AI connected) cost nothing and need no hold.
    if (!this.core.ai()) return this.generateNow(userId, projectId, key, input);
    // Access first: the hold reports the balance and whether AI is busy, which only project people may learn.
    return this.core.load(userId, projectId, 'write', key).then((ctx) => this.core.assertEditWay(ctx, key, 'ai')).then(() => this.core.oneAiRequest(projectId, () => this.generateNow(userId, projectId, key, input)));
  }

  generateNow(userId: string, projectId: string, key: string, input: GenerateInput & { preview: true }): Promise<{ data: AiProposal }>;
  generateNow(userId: string, projectId: string, key: string, input: GenerateInput & { preview?: false }): Promise<{ data: { versionId: string; versionNumber: number; provider: string } }>;
  async generateNow(userId: string, projectId: string, key: string, input: GenerateInput & { preview?: boolean }): Promise<{ data: AiProposal | { versionId: string; versionNumber: number; provider: string } }> {
    const source = input.source ?? 'app';
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const assignment = this.core.assignmentFor(ctx, key);
    if (input.saveAs === 'project_rule' && assignment) throw new ForbiddenException('PROJECT_RULE_FORBIDDEN');
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageFor(stageKey, ctx.type.key);
    if (definition.ai.level === 'none') throw new BadRequestException('AI_NOT_USED_FOR_STAGE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const base = await this.core.versionContent(stage.currentVersionId);
    // An application's architecture: the AI edits the design people own (schema, components, decisions, threats,
    // environments) and the notes; everything else in the plan is computed from them by the platform, as on a save.
    const appPlan = definition.artifactType === 'techplan' && ctx.type.key === 'web_app';
    const planFrom = async (notes: string | null, design: ArchitectureDesign | null) => this.core.techPlanFor(ctx, stageKey, notes, design);
    if (input.targetKey && (!base || !lockableKeys(definition.artifactType, base.content).includes(input.targetKey))) throw new NotFoundException('TARGET_NOT_FOUND');
    // The AI a specialist directs sees what the specialist sees: hidden parts replaced, extra results the owner opened added.
    const inputs = await this.core.viewInputs(ctx, stageKey);
    const extras = await this.core.extraReads(ctx, stageKey);
    const provider = this.core.ai();
    // The AI's first draft needs words to start from: the owner's description, or (for «Цель сайта») the accepted idea
    // passport. Without AI the template starts from the project name and the wizard story.
    if (((stageKey === 'goal' && !inputs.story) || (stageKey === 'story' && provider)) && !base && !input.instruction) throw new BadRequestException('DESCRIPTION_REQUIRED');
    const started = Date.now();
    // A draft by template is not the AI: it is open in every mode. Requests to the AI follow the owner's choice.
    if (provider) this.core.assertEditWay(ctx, key, 'ai');

    if (input.preview && (!provider || !input.instruction)) throw provider ? new BadRequestException('INSTRUCTION_REQUIRED') : new ServiceUnavailableException('AI_NOT_CONFIGURED');
    if (!provider) {
      // Without AI the platform still offers a deterministic draft for stages that have one; instructions need AI.
      if (input.instruction || input.targetKey) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
      let draft: unknown;
      if (stageKey === 'story') draft = { ...emptyStory(), name: ctx.project.name.slice(0, 80), story: (await this.prisma.project.findUnique({ where: { id: projectId }, select: { summary: true } }))?.summary?.slice(0, 3000) ?? null };
      else if (stageKey === 'goal' && inputs.story) draft = briefFromStory(inputs.story.content as Story);
      else if (stageKey === 'content') draft = inProject(ctx, () => templateContent(inputs.goal?.content as Brief ?? emptyBrief(), (inputs.offer?.content as Offer | undefined) ?? null, (inputs.sitemap?.content as Sitemap | undefined) ?? null));
      else if (stageKey === 'sitemap') draft = inProject(ctx, () => templateSitemap(briefOf(inputs), (inputs.offer?.content as Offer | undefined) ?? null));
      else if (stageKey === 'paths') draft = inProject(ctx, () => templatePaths({ brief: briefOf(inputs), idea: (inputs.idea?.content as IdeaReview | undefined) ?? null, sitemap: (inputs.sitemap?.content as Sitemap | undefined) ?? null, offer: (inputs.offer?.content as Offer | undefined) ?? null, projectType: ctx.type.key }));
      else if (stageKey === 'design') draft = defaultDesign;
      else if (stageKey === 'idea') draft = templateIdea(briefOf(inputs), (inputs.story?.content as Story | undefined) ?? null);
      else if (stageKey === 'process') draft = inProject(ctx, () => templateProcess(ctx.type.key, briefOf(inputs)));
      else if (stageKey === 'features') draft = inProject(ctx, () => templateFeatures(briefOf(inputs), (inputs.process?.content as BusinessProcess | undefined) ?? null, ctx.type.key === 'web_app' ? 'app' : 'site', (inputs.suggestions?.content as Suggestions | undefined) ?? null));
      else if (stageKey === 'concept') {
        // From what this viewer sees: a specialist's draft must not carry parts hidden from them.
        const seen = <T>(stage: string) => (inputs[stage]?.content as T | undefined) ?? null;
        const conceptInputs = { brief: briefOf(inputs), idea: seen<IdeaReview>('idea'), process: seen<BusinessProcess>('process'), suggestions: seen<Suggestions>('suggestions'), skipped: ctx.stages.filter((row) => row.status === 'skipped').map((row) => row.stageKey) };
        draft = inProject(ctx, () => templateConcept(conceptInputs, ctx.project.name));
      }
      else if (stageKey === 'suggestions') draft = inProject(ctx, () => templateSuggestions(ctx.type.key, (inputs.idea?.content as IdeaReview | undefined) ?? null, (inputs.process?.content as BusinessProcess | undefined) ?? null));
      else if (stageKey === 'screens') draft = inProject(ctx, () => templateScreens((inputs.features?.content as AppFeatures | undefined) ?? null));
      else throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
      const merged = inProject(ctx, () => normalizeFor(ctx, definition.artifactType, mergeProposal(definition.artifactType, base?.content ?? null, draft, aiLocksFor(definition.artifactType, stage.lockedKeys), null)));
      const version = await this.prisma.$transaction(async (tx) => {
        const run = await tx.generationRun.create({ data: {
          projectId, stageId: stage.id, requestedByUserId: userId, provider: 'template', model: null, playbookVersion: definition.playbook.version,
          inputVersionIds: Object.values(inputs).map((item) => item.versionId), baseVersionId: base?.id ?? null, status: 'succeeded', durationMs: Date.now() - started, source,
        }, select: { id: true } });
        const created = await this.core.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'template', note: 'Черновик по шаблону (ИИ не подключён)', userId, generationRunId: run.id });
        await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
        await this.core.event(tx, projectId, userId, 'stage_generated', key, { provider: 'template', versionNumber: created.versionNumber });
        return created;
      });
      return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: 'template' } };
    }

    if (await this.core.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
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
    const playbook = await this.core.activePlaybook(stage.id);
    const prompt = buildStagePrompt({
      specialistPlaybook: playbook ? { instructions: playbook.instructions, checklist: playbook.checklist } : null,
      stage: definition, locale: ctx.project.locale, projectTypeTitle: ctx.type.title,
      inputs: Object.fromEntries([...Object.entries(inputs), ...Object.entries(extras)].map(([inputKey, value]) => [inputKey, value.content])),
      current: appPlan && base ? { ownerNotes: (base.content as TechPlan).ownerNotes ?? null, design: techPlanDesign(base.content) } : base?.content ?? null, lockedKeys: aiLocksFor(definition.artifactType, stage.lockedKeys), targetKey: input.targetKey, rules: ruleTexts, instruction: instruction?.text ?? null,
      ownerConversation: input.conversation ?? null,
    });
    // Tokens are spent even when the output is rejected, so failures record usage too.
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const recordFailure = async (code: string) => {
      // A rule asked for together with a failed request is not switched on; it stays in the history as a one-off request.
      if (instruction && input.saveAs !== 'one_off') await this.prisma.stageInstruction.update({ where: { id: instruction.id }, data: { kind: 'one_off' } });
      await this.prisma.generationRun.create({ data: {
        projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
        targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
        baseVersionId: base?.id ?? null, status: 'failed', safeErrorCode: code, durationMs: Date.now() - started, source, specialistPlaybook: playbook?.ref ?? null,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
      } });
    };
    let merged: unknown;
    let proposal: unknown;
    let proposedDesign: ArchitectureDesign | null = null;
    // The plan from a merged answer: the notes as merged (they may be protected), the design as the AI proposed it.
    const appPlanOf = async (content: unknown, from: unknown = base?.content ?? null) => (appPlan ? planFrom(techPlanNotes(content), proposedDesign)
      : definition.artifactType === 'testplan' ? markAiCases(from as TestPlan | null, content as TestPlan) : content);
    try {
      const detailed = provider.generateDetailed ? await provider.generateDetailed(prompt) : { output: await provider.generate(prompt), usage: null };
      usage = detailed.usage;
      const raw = detailed.output;
      if (definition.artifactType === 'content' && input.targetKey) {
        const section = (raw as { section?: unknown })?.section;
        const baseContent = base!.content as ContentArtifact;
        proposal = input.targetKey === 'seo' ? baseContent : normalizeContent({ sections: [{ ...(section as object), key: input.targetKey }], seo: baseContent.seo });
      } else if (appPlan) {
        const answer = (raw && typeof raw === 'object' ? raw : {}) as { ownerNotes?: unknown; design?: unknown };
        // A request about the notes only leaves the design as it is.
        proposedDesign = input.targetKey && base ? techPlanDesign(base.content) : normalizeDesign(answer.design);
        proposal = await planFrom(techPlanNotes({ ownerNotes: answer.ownerNotes ?? null }), proposedDesign);
      } else {
        proposal = inProject(ctx, () => normalizeAiOutput(raw, (value) => normalizeFor(ctx, definition.artifactType, value)));
      }
      merged = inProject(ctx, () => normalizeFor(ctx, definition.artifactType, mergeProposal(definition.artifactType, base?.content ?? null, proposal, aiLocksFor(definition.artifactType, stage.lockedKeys), input.targetKey)));
      merged = await appPlanOf(merged);
    } catch (error) {
      const code = error instanceof StageAiError ? error.code : error instanceof ArtifactValidationError ? 'AI_OUTPUT_REJECTED' : 'AI_FAILED';
      await recordFailure(code);
      if (code === 'AI_OUTPUT_REJECTED') throw new BadGatewayException(code);
      throw new ServiceUnavailableException(code);
    }
    // The request takes seconds; if someone saved the stage meanwhile, the answer goes on top of that newer version
    // (with its locks) instead of silently replacing it.
    const fresh = await this.prisma.projectStage.findUnique({ where: { id: stage.id }, select: { currentVersionId: true, lockedKeys: true } });
    let baseId = base?.id ?? null;
    if (fresh && fresh.currentVersionId !== baseId) {
      const latest = await this.core.versionContent(fresh.currentVersionId);
      try {
        merged = await appPlanOf(inProject(ctx, () => normalizeFor(ctx, definition.artifactType, mergeProposal(definition.artifactType, latest?.content ?? null, proposal, aiLocksFor(definition.artifactType, fresh.lockedKeys), input.targetKey))), latest?.content ?? null);
        baseId = latest?.id ?? null;
      } catch { /* keep the answer merged on the version it was asked for */ }
    }
    const runData = {
      projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
      targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
      baseVersionId: baseId, status: 'succeeded' as const, durationMs: Date.now() - started, source, specialistPlaybook: playbook?.ref ?? null,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
    };
    if (input.preview) {
      // Nothing changes yet: the person sees the proposal on the stage and applies or dismisses it.
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.generationRun.create({ data: { ...runData, proposal: merged as object, proposalState: 'open' }, select: { id: true } });
        if (assignment) await tx.stageAssignment.update({ where: { id: assignment.id }, data: { aiUsed: { increment: 1 } } });
        return created;
      });
      const baseContent = baseId ? (await this.core.versionContent(baseId))?.content ?? null : null;
      const context = await this.core.checkContext(ctx, stageKey);
      // Parts the person protected from the AI stay as they were; say which ones the AI wanted to change, so the
      // preview does not quietly look smaller than the answer.
      let blockedByLocks: string[] = [];
      try {
        const unlocked = inProject(ctx, () => normalizeFor(ctx, definition.artifactType, mergeProposal(definition.artifactType, baseContent, proposal, [], input.targetKey)));
        const locked = new Set(aiLocksFor(definition.artifactType, stage.lockedKeys));
        blockedByLocks = changedKeys(definition.artifactType, merged, unlocked).filter((key) => locked.has(key));
      } catch { /* the answer does not fit without locks either: nothing to report */ }
      // The proposal goes through the same checks as a saved version, so the person sees what it would break before applying.
      const findings = reviewStage(definition.artifactType, merged, { ...context, projectType: ctx.type.key }).findings;
      return { data: { proposalId: run.id, baseVersionId: baseId, content: merged, changed: changedKeys(definition.artifactType, baseContent, merged), issues: completenessIssues(definition.artifactType, merged, context), findings, blockedByLocks } };
    }
    const version = await this.prisma.$transaction(async (tx) => {
      const run = await tx.generationRun.create({ data: {
        projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
        targetKey: input.targetKey, instructionId: instruction?.id ?? null, ruleIds: rules.map((rule) => rule.id), inputVersionIds: Object.values(inputs).map((item) => item.versionId),
        baseVersionId: baseId, status: 'succeeded', durationMs: Date.now() - started, source, specialistPlaybook: playbook?.ref ?? null,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
      }, select: { id: true } });
      const created = await this.core.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content: merged, origin: 'ai_generated',
        note: instruction ? tr("ИИ: {0}", [instruction.text]) : 'ИИ: черновик', userId, generationRunId: run.id,
      });
      await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
      await this.core.event(tx, projectId, userId, 'stage_generated', key, { provider: provider.name, versionNumber: created.versionNumber, targetKey: input.targetKey });
      if (assignment) await tx.stageAssignment.update({ where: { id: assignment.id }, data: { aiUsed: { increment: 1 } } });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber, provider: provider.name } };
  }

  /** «Изменить через ИИ» with a preview: the AI answer comes back as a proposal; the stage stays as it is. */
  async propose(userId: string, projectId: string, key: string, input: { instruction: string; targetKey: string | null }) {
    if (!this.core.ai()) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
    return this.core.load(userId, projectId, 'write', key).then((ctx) => this.core.assertEditWay(ctx, key, 'ai'))
      .then(() => this.core.oneAiRequest(projectId, () => this.generateNow(userId, projectId, key, { instruction: input.instruction, saveAs: 'one_off', targetKey: input.targetKey, preview: true })));
  }

  private async openProposal(userId: string, projectId: string, key: string, proposalId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    this.core.assertEditWay(ctx, key, 'ai');
    const stage = this.core.stageOf(ctx, key);
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const run = await this.prisma.generationRun.findFirst({ where: { id: proposalId, stageId: stage.id, requestedByUserId: userId }, select: { id: true, proposal: true, proposalState: true, baseVersionId: true, instructionId: true, provider: true, targetKey: true } });
    if (!run || run.proposal === null) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    if (run.proposalState !== 'open') throw new ConflictException('PROPOSAL_CLOSED');
    return { ctx, stage, run };
  }

  /** Saves the proposal as a new version, if nobody changed the stage since it was made. */
  async applyProposal(userId: string, projectId: string, key: string, proposalId: string) {
    const { ctx, stage, run } = await this.openProposal(userId, projectId, key, proposalId);
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if ((stage.currentVersionId ?? null) !== (run.baseVersionId ?? null)) throw new ConflictException('PROPOSAL_STALE');
    const definition = stageFor(key as StageKey, ctx.type.key);
    const instruction = run.instructionId ? await this.prisma.stageInstruction.findUnique({ where: { id: run.instructionId }, select: { text: true } }) : null;
    const version = await this.prisma.$transaction(async (tx) => {
      // Claimed first, so a double tap cannot save it twice.
      const claimed = await tx.generationRun.updateMany({ where: { id: run.id, proposalState: 'open' }, data: { proposalState: 'applied' } });
      if (claimed.count !== 1) throw new ConflictException('PROPOSAL_CLOSED');
      const created = await this.core.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content: run.proposal, origin: 'ai_generated',
        note: instruction ? tr("ИИ: {0}", [instruction.text]) : 'ИИ: черновик', userId, generationRunId: run.id,
      });
      await tx.generationRun.update({ where: { id: run.id }, data: { resultVersionId: created.id } });
      await this.core.event(tx, projectId, userId, 'stage_generated', key, { provider: run.provider, versionNumber: created.versionNumber, targetKey: run.targetKey });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber } };
  }

  async dismissProposal(userId: string, projectId: string, key: string, proposalId: string) {
    const { run } = await this.openProposal(userId, projectId, key, proposalId);
    await this.prisma.generationRun.updateMany({ where: { id: run.id, proposalState: 'open' }, data: { proposalState: 'dismissed' } });
    return { data: { dismissed: true } };
  }

  /**
   * History of AI requests (and template drafts) with filters. Owners and managers see the whole project;
   * a specialist sees requests on the stages they are assigned to.
   */
  async aiHistory(userId: string, projectId: string, filter: { stageKey: string | null; authorId: string | null; query: string | null; before: Date | null; limit: number }) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const readable = ctx.route.filter((key) => this.core.canRead(ctx, key));
    if (filter.stageKey && !readable.includes(filter.stageKey as StageKey)) throw new NotFoundException('STAGE_NOT_FOUND');
    const stageIds = (filter.stageKey ? [filter.stageKey] : readable).map((key) => this.core.stageOf(ctx, key).id);
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
    const people = await this.core.historyPeople(ctx, projectId, userId);
    const items = page.map((run) => {
      const key = keyOf.get(run.stageId) as StageKey;
      const stage = this.core.stageOf(ctx, key);
      const version = versions.find((item) => item.id === run.resultVersionId);
      const instruction = instructions.find((item) => item.id === run.instructionId);
      const review = run.targetKey === '_review';
      const outcome = run.status === 'failed' ? 'failed' : review ? 'review'
        : version && acceptedVersions.has(`${key}:${version.versionNumber}`) ? 'accepted'
          : version && stage.currentVersionId === version.id ? 'current'
            : 'replaced';
      return {
        id: run.id, createdAt: run.createdAt,
        stage: { key, title: definitionOf(key).title },
        author: people.get(run.requestedByUserId) ?? { id: run.requestedByUserId, name: 'Удалённый участник', kind: 'former' as const },
        text: review ? tr('ИИ-проверка качества') : instruction?.text ?? null,
        savedAs: instruction?.kind ?? null,
        targetKey: review ? null : run.targetKey, rulesApplied: run.ruleIds.length,
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
      return { stage: { key, title: definitionOf(key).title }, ...total };
    });
    return {
      data: {
        items,
        nextBefore: runs.length > filter.limit ? page[page.length - 1].createdAt : null,
        summary: { byAuthor, byStage, tokensReported: grouped.some((row) => row._sum.inputTokens !== null || row._sum.outputTokens !== null) },
        filters: {
          stages: readable.map((key) => ({ key, title: definitionOf(key).title })),
          authors: [...people.values()],
        },
      },
    };
  }
}
