import { tr } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WorktimeService } from './worktime.service.js';
import { SLOT_STEPS, TIMEZONES, WEEKDAYS, templateSchedule, weekdayShort, type Schedule } from './schedule.js';
import { CAPABILITIES, PROCESS_LIMITS } from './process.js';
import { bookingApiContract, sameTechPlan, techPlanMarkdown, techPlanNotes, type TechPlan } from './techplan.js';
import { PrismaService } from '../database/prisma.service.js';
import { ROUTE_CATALOG_VERSION, projectTypes, routeInputs, stageDefinitions, statusExplanations, type StageKey } from './catalog.js';
import { changedKeys, completenessIssues, importBriefText, importContentText, importOfferText, lockableKeys, stableStringify, normalizeArtifact, sectionTypeLabels, importCatalogText, type Brief, type ContentArtifact, type Offer, type SiteArtifact } from './artifacts.js';
import { checkSite, corners, fonts, heroLayouts, palettes, renderPages, renderSite, siteMeta } from './site-renderer.js';
import { RESERVED_PATHS, SITEMAP_LIMITS, templateSitemap, type Sitemap } from './sitemap.js';
import { CATALOG_LIMITS, templateCatalog, tenge, type Catalog } from './products.js';
import { type StageAiProvider } from './stage-ai.js';
import { BillingService } from '../billing/billing.service.js';
import { canEdit, directDependents, inputsSatisfied, isSatisfied, nextStage, reopenStage, unlockDependents } from './stage-state.js';
import { JourneyCore } from './journey-core.js';
import { StageAiService } from './stage-ai.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { APPROVER_ROLES, approvalState, approveBlocker, checkPolicy, policyText, readPolicy, type ApprovalPolicy } from '../team/team-rules.js';
import { inProject, acceptRoles, editableProject, notEditableCode, normalizedOrRaw, SPECIALIST_READ_GRACE_MS, isUuid, validationError } from './journey-core.js';

@Injectable()
export class JourneyService {
  constructor(
    private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly worktime: WorktimeService,
    private readonly core: JourneyCore, private readonly stageAi: StageAiService, private readonly changes: ChangeNoticesService,
  ) {}

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

  async journey(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const versionIds = ctx.stages.flatMap((stage) => [stage.currentVersionId, stage.approvedVersionId]).filter((id): id is string => Boolean(id));
    const versions = await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNumber: true } });
    const numberOf = (id: string | null) => versions.find((version) => version.id === id)?.versionNumber ?? null;
    const approved = ctx.route.filter((key) => isSatisfied(ctx.statuses[key])).length;
    const visible = ctx.route.filter((key) => this.core.canRead(ctx, key));
    const specialist = ctx.viewer.kind === 'specialist';
    const next = specialist ? visible.find((key) => !isSatisfied(ctx.statuses[key])) ?? null : nextStage(ctx.route, ctx.statuses);
    const nextStatus = next ? ctx.statuses[next] : null;
    const title = next ? stageDefinitions[next].title : '';
    const nextText = !next ? (specialist ? 'Ваш этап принят владельцем. Спасибо за работу!' : 'Все этапы приняты. Опубликуйте сайт или скачайте результат ниже. Вернуться к любому этапу можно в любой момент.')
      : next && ctx.openNotices.some((notice) => notice.targetKey === next) ? tr("Изменился этап, на котором построен «{0}». Посмотрите, что изменилось, и решите: принять, оставить как есть или обсудить.", [title])
      : nextStatus === 'stale' ? tr("Изменился предыдущий этап. Проверьте «{0}» и подтвердите или обновите.", [title])
        : nextStatus === 'in_review' ? (specialist ? tr("Этап «{0}» на приёмке у владельца. Пока он проверяет, вносить изменения нельзя.", [title]) : tr("Специалист отправил этап «{0}» на приёмку. Проверьте и примите или верните на доработку.", [title]))
          : nextStatus === 'changes_requested' ? tr("Владелец попросил доработать этап «{0}».", [title])
            : nextStatus === 'awaiting_lead' ? tr("Этап «{0}» ждёт, когда приглашённый специалист примет приглашение. Вы можете продолжить сами.", [title])
              : nextStatus === 'in_progress' ? (specialist ? tr("Доработайте этап «{0}» и отправьте владельцу на приёмку.", [title]) : tr("Проверьте черновик этапа «{0}» и примите его, если всё устраивает.", [title]))
                : tr("Начните этап «{0}». {1}", [title, stageDefinitions[next].outcome]);
    const ai = this.core.ai();
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
    const technology = (await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'technologies' } }, select: { optionKey: true } }))?.optionKey ?? null;
    const discussing = ctx.openNotices.filter((notice) => notice.status === 'discussing').map((notice) => notice.id);
    const lastSides = discussing.length ? await this.prisma.changeMessage.findMany({ where: { noticeId: { in: discussing } }, orderBy: { createdAt: 'desc' }, distinct: ['noticeId'], select: { noticeId: true, side: true } }) : [];
    const actsFor = (key: StageKey) => {
      if (specialist) { const mine = this.core.assignmentFor(ctx, key); return mine?.role === 'lead' && mine.status === 'active'; }
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
        const mine = this.core.assignmentFor(ctx, key);
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
          routeVersion: ctx.project.routeVersion, changeResponseDays: ctx.project.changeResponseDays, technology,
        },
        viewer: this.core.viewerInfo(ctx),
        progress: { accepted: approved, total: ctx.route.length, percent: Math.round((approved / ctx.route.length) * 100) },
        nextAction: next ? { stageKey: next, title: stageDefinitions[next].title, text: nextText } : { stageKey: null, title: 'Готово', text: nextText },
        stages: visible.map((key) => {
          const stage = this.core.stageOf(ctx, key);
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
        ai: { configured: Boolean(ai), provider: ai?.name ?? null, remainingToday: ai ? await this.core.remainingAiRuns(projectId) : 0, month: ctx.viewer.kind === 'member' ? await this.billing.remainingAi(projectId) : null },
      },
    };
  }

  async stage(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    const changesPending = ctx.openNotices.some((notice) => notice.targetKey === stageKey);
    const waiting = this.core.waitingBranches(ctx, stageKey);
    // What accepting this stage will do to the stages built on it: start them, or notify those that already have work.
    const dependents = directDependents(ctx.route, stageKey).filter((item) => this.core.canRead(ctx, item)).map((item) => {
      const dependent = this.core.stageOf(ctx, item);
      const hasWork = Boolean(dependent.currentVersionId) || ['approved', 'imported', 'stale'].includes(dependent.status);
      return { key: item, title: stageDefinitions[item].title, status: dependent.status, hasWork, opens: dependent.status === 'locked' && inputsSatisfied(ctx.route, { ...ctx.dep, [stageKey]: 'approved' }, item) };
    });
    const inputs = await this.core.acceptedInputs(ctx, stageKey);
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
    const ai = this.core.ai();
    const site = definition.artifactType === 'site' && current ? current.content as unknown as SiteArtifact : null;
    const assignment = this.core.assignmentFor(ctx, stageKey);
    // Schedule has no AI: the editor starts from the accepted services and a typical working day.
    const techPlanPreview = definition.artifactType === 'techplan' && inputsSatisfied(ctx.route, ctx.dep, stageKey)
      ? await this.core.techPlanFor(ctx, stageKey, (current?.content as unknown as TechPlan | undefined)?.ownerNotes ?? null) : null;
    const techPlanOutdated = Boolean(techPlanPreview && current && !sameTechPlan(techPlanPreview, current.content as unknown as TechPlan));
    const scheduleTemplate = definition.artifactType === 'schedule' && !current
      ? await this.core.acceptedInputs(ctx, stageKey).then((inputs) => inProject(ctx, () => templateSchedule(inputs.offer?.content as Offer | undefined ?? null))) : null;
    const owner = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role) && editableProject(ctx.project.status);
    const writable = canEdit(stage.status) && this.core.canWrite(ctx, stageKey) && editableProject(ctx.project.status);
    const approval = await this.approvalView(ctx, userId, key, current);
    const policyActive = Boolean(approval.policy);
    const suggestions = await this.prisma.stageInstruction.findMany({
      where: { stageId: stage.id, kind: 'suggestion' }, orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, text: true, targetKey: true, status: true, authorUserId: true, createdAt: true },
    });
    const authorIds = [...new Set(suggestions.map((item) => item.authorUserId))];
    const authors = authorIds.length ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } }) : [];
    return {
      data: {
        viewer: this.core.viewerInfo(ctx),
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
          canAccept: owner && !policyActive && Boolean(stage.currentVersionId) && !changesPending && waiting.length === 0 && !techPlanOutdated
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
          canSubmit: (Boolean(assignment) || (policyActive && ctx.viewer.kind === 'member')) && writable && Boolean(stage.currentVersionId) && stage.status !== 'in_review' && !changesPending,
          canRequestChanges: (owner || Boolean(approval.isReviewer)) && stage.status === 'in_review' && editableProject(ctx.project.status),
          approval,
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
        issues: current && definition.artifactType !== 'site' ? completenessIssues(definition.artifactType, current.content, await this.core.checkContext(ctx, stageKey)) : [],
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
          configured: Boolean(ai), remainingToday: ai ? await this.core.remainingAiRuns(projectId) : 0,
          budget: assignment ? { limit: assignment.aiBudget, used: assignment.aiUsed } : null,
          month: ctx.viewer.kind === 'member' ? await this.billing.remainingAi(projectId) : null,
          templateAvailable: !ai && (stageKey === 'content' || stageKey === 'design' || stageKey === 'process' || stageKey === 'sitemap'),
        },
        options: {
          palettes, fonts, corners, heroLayouts, sectionTypes: sectionTypeLabels,
          ...(definition.artifactType === 'techplan' ? { techplan: { preview: techPlanPreview, outdated: techPlanOutdated } } : {}),
          ...(definition.artifactType === 'process' ? { process: { capabilities: CAPABILITIES, actorKinds: { client: 'Клиент', business: 'Бизнес', staff: 'Сотрудник', system: 'Сайт или система', external: 'Внешний сервис' }, limits: PROCESS_LIMITS } } : {}),
          ...(definition.artifactType === 'catalog' ? { catalog: { limits: CATALOG_LIMITS, template: await this.core.acceptedInputs(ctx, stageKey).then(() => inProject(ctx, () => templateCatalog(null))) } } : {}),
          ...(definition.artifactType === 'sitemap' ? { sitemap: { limits: SITEMAP_LIMITS, reservedPaths: RESERVED_PATHS, template: await this.core.acceptedInputs(ctx, stageKey).then((inputs) => inProject(ctx, () => templateSitemap((inputs.goal?.content as Brief | undefined) ?? null, (inputs.offer?.content as Offer | undefined) ?? null))) } } : {}),
          ...(stageKey === 'content' && ctx.route.includes('sitemap') ? { pages: (await this.core.checkContext(ctx, stageKey)).sitemap?.pages ?? null } : {}),
          ...(definition.artifactType === 'schedule' ? { schedule: { template: scheduleTemplate, timezones: TIMEZONES, weekdays: WEEKDAYS, slotSteps: SLOT_STEPS } } : {}),
          ...(stageKey === 'build' ? { technology: (await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'technologies' } }, select: { optionKey: true } }))?.optionKey ?? null } : {}),
        },
      },
    };
  }

  async saveDraft(userId: string, projectId: string, key: string, input: { content: unknown; baseVersionId: string | null }) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if ((input.baseVersionId ?? null) !== (stage.currentVersionId ?? null)) throw new ConflictException('STAGE_VERSION_CONFLICT');
    let content: unknown;
    if (definition.artifactType === 'techplan') {
      // The plan itself is always computed from the accepted inputs; the owner contributes only notes.
      let notes: string | null = null;
      try { notes = techPlanNotes(input.content); } catch (error) { validationError(error); }
      if (!inputsSatisfied(ctx.route, ctx.dep, key as StageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
      content = await this.core.techPlanFor(ctx, key as StageKey, notes);
    } else {
      try { content = normalizeArtifact(definition.artifactType, input.content); } catch (error) { validationError(error); }
    }
    const base = await this.core.versionContent(stage.currentVersionId);
    const changed = changedKeys(definition.artifactType, base?.content ?? null, content);
    // changedKeys ignores photo choices (they never lock text), so compare whole artifacts to decide whether anything changed.
    if (base && changed.length === 0 && stableStringify(normalizedOrRaw(definition.artifactType, base.content)) === stableStringify(content)) {
      return { data: { versionId: base.id, versionNumber: base.versionNumber, changed: [] } };
    }
    const valid = new Set(lockableKeys(definition.artifactType, content));
    const locked = [...new Set([...stage.lockedKeys, ...changed])].filter((item) => valid.has(item));
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.core.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content, origin: 'owner_edit', note: 'Изменено вручную', userId, lockedKeys: locked });
      await this.core.event(tx, projectId, userId, 'stage_draft_saved', key, { versionNumber: created.versionNumber, changed });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber, changed } };
  }

  async setLock(userId: string, projectId: string, key: string, lockKey: string, locked: boolean) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const current = await this.core.versionContent(stage.currentVersionId);
    const definition = stageDefinitions[key as StageKey];
    if (!current || !lockableKeys(definition.artifactType, current.content).includes(lockKey)) throw new NotFoundException('LOCK_KEY_NOT_FOUND');
    const next = locked ? [...new Set([...stage.lockedKeys, lockKey])] : stage.lockedKeys.filter((item) => item !== lockKey);
    await this.prisma.projectStage.update({ where: { id: stage.id }, data: { lockedKeys: next } });
    return { data: { lockedKeys: next } };
  }

  async addRule(userId: string, projectId: string, key: string, input: { text: string; scope: 'stage_rule' | 'project_rule' }) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    if (input.scope === 'project_rule' && ctx.viewer.kind !== 'member') throw new ForbiddenException('PROJECT_RULE_FORBIDDEN');
    const stage = this.core.stageOf(ctx, key);
    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stageInstruction.create({ data: { projectId, stageId: stage.id, authorUserId: userId, kind: input.scope, text: input.text }, select: { id: true, kind: true, status: true, text: true, createdAt: true } });
      await this.core.event(tx, projectId, userId, 'rule_added', key, { ruleId: created.id, scope: input.scope });
      return created;
    });
    return { data: rule };
  }

  async setRuleStatus(userId: string, projectId: string, ruleId: string, status: 'active' | 'disabled') {
    await this.core.load(userId, projectId, 'write');
    if (!isUuid(ruleId)) throw new NotFoundException('RULE_NOT_FOUND');
    const updated = await this.prisma.stageInstruction.updateMany({ where: { id: ruleId, projectId, kind: { in: ['stage_rule', 'project_rule'] } }, data: { status } });
    if (updated.count !== 1) throw new NotFoundException('RULE_NOT_FOUND');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'rule_status_changed', details: { ruleId, status } } });
    return { data: { id: ruleId, status } };
  }

  async restore(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const definition = stageDefinitions[key as StageKey];
    if (definition.artifactType === 'site') throw new BadRequestException('STAGE_NOT_EDITABLE');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!isUuid(versionId)) throw new NotFoundException('VERSION_NOT_FOUND');
    const source = await this.prisma.stageArtifactVersion.findFirst({ where: { id: versionId, stageId: stage.id }, select: { content: true, versionNumber: true } });
    if (!source) throw new NotFoundException('VERSION_NOT_FOUND');
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.core.createVersion(tx, { projectId, stage, artifactType: definition.artifactType, content: source.content, origin: 'restored', note: tr("Возврат к версии {0}", [source.versionNumber]), userId });
      await this.core.event(tx, projectId, userId, 'stage_version_restored', key, { from: source.versionNumber, versionNumber: created.versionNumber });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber } };
  }

  async importText(userId: string, projectId: string, key: string, text: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!definition.importHint) throw new BadRequestException('IMPORT_NOT_SUPPORTED');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    let content: unknown;
    try {
      const { sitemap } = await this.core.checkContext(ctx, stageKey);
      content = inProject(ctx, () => (definition.artifactType === 'brief' ? importBriefText(text) : definition.artifactType === 'offer' ? importOfferText(text) : definition.artifactType === 'catalog' ? importCatalogText(text) : importContentText(text, sitemap)));
    } catch (error) { validationError(error); }
    const issues = completenessIssues(definition.artifactType, content, await this.core.checkContext(ctx, stageKey));
    // Imported material counts as accepted only when it is complete, its own inputs are accepted and the person importing
    // may accept stages. A specialist's import is a draft like any other: the owner accepts it, and that is when they are paid.
    const complete = issues.length === 0 && inputsSatisfied(ctx.route, ctx.dep, stageKey) && ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await this.core.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content, origin: 'imported', note: 'Ваши материалы', userId,
        lockedKeys: changedKeys(definition.artifactType, null, content), status: complete ? 'imported' : 'in_progress', accept: complete,
      });
      if (complete) await this.core.writeStatuses(tx, ctx, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'imported' }));
      await this.core.event(tx, projectId, userId, 'stage_imported', key, { versionNumber: created.versionNumber, complete });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: result.id, versionNumber: result.versionNumber, status: complete ? 'imported' : 'in_progress', issues } };
  }

  async build(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', 'build');
    const stage = this.core.stageOf(ctx, 'build');
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    if (!inputsSatisfied(ctx.route, ctx.dep, 'build')) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    if (this.core.waitingBranches(ctx, 'build').length) throw new ConflictException('BRANCHES_NOT_ALIGNED');
    const sources = await this.core.renderSources(ctx, true);
    const renderInput = { ...sources.input, draft: false };
    const pages = renderPages(renderInput);
    const site: SiteArtifact = {
      html: pages[0]!.html, ...(renderInput.sitemap ? { pages } : {}), meta: siteMeta(renderInput), checks: checkSite(renderInput),
      sourceVersionIds: sources.versionIds, compiledAt: new Date().toISOString(),
    };
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.core.createVersion(tx, { projectId, stage, artifactType: 'site', content: site, origin: 'compiled', note: 'Сборка из принятых этапов', userId });
      await this.core.event(tx, projectId, userId, 'site_built', 'build', { versionNumber: created.versionNumber, failed: site.checks.filter((check) => check.status === 'failed').map((check) => check.id) });
      return created;
    });
    return { data: { versionId: version.id, versionNumber: version.versionNumber, checks: site.checks } };
  }

  /** Photos belong to the «Структура и тексты» stage: whoever may read or edit that stage may see or change the photo library. */
  async assertImageAccess(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access, 'content');
    return { projectId: ctx.project.id, ownerUserId: ctx.project.ownerUserId };
  }

  async preview(userId: string, projectId: string, versionId: string | null, pagePath: string | null = null) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const own = ctx.viewer.kind === 'specialist' ? ctx.viewer.assignments.map((item) => item.stageKey) : undefined;
    // A preview shows the page texts, so specialists see it only when their stage works with them.
    if (own && !own.some((key) => ['content', 'design', 'build'].includes(key))) throw new NotFoundException('PREVIEW_NOT_AVAILABLE');
    if (versionId) {
      if (own && !own.includes('build')) throw new NotFoundException('VERSION_NOT_FOUND');
      const build = this.core.stageOf(ctx, 'build');
      if (!isUuid(versionId)) throw new NotFoundException('VERSION_NOT_FOUND');
      const version = await this.prisma.stageArtifactVersion.findFirst({ where: { id: versionId, stageId: build.id }, select: { content: true, versionNumber: true } });
      if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
      const built = version.content as unknown as SiteArtifact;
      const page = built.pages?.find((item) => item.path === pagePath) ?? null;
      return { data: { html: await this.core.inline(projectId, page?.html ?? built.html), draft: false, versionNumber: version.versionNumber, pages: (built.pages ?? []).map(({ path, title }) => ({ path, title })) } };
    }
    const sources = await this.core.renderSources(ctx, false, own);
    const map = sources.input.sitemap;
    const page = map?.pages.find((item) => item.path === pagePath) ?? null;
    return { data: { html: await this.core.inline(projectId, renderSite(sources.input, page?.key ?? null)), draft: true, versionNumber: null, pages: (map?.pages ?? []).map(({ path, title }) => ({ path, title })) } };
  }

  async accept(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.core.load(userId, projectId, 'accept', key);
    const stage = this.core.stageOf(ctx, key);
    // With an approval policy the stage is accepted by the reviewers' approvals, not by one person.
    if (readPolicy((await this.approvalRow(stage.id)).approvalPolicy)) throw new ConflictException('APPROVAL_POLICY_ACTIVE');
    const version = await this.acceptChecks(ctx, key, versionId);
    const notices = await this.prisma.$transaction((tx) => this.applyAccept(tx, ctx, key, versionId, version, userId, null));
    await this.afterAccept(ctx, key, notices);
    return this.journey(userId, projectId);
  }

  /** Everything that must hold before a version becomes the accepted result; shared by «accept» and the last approval. */
  private async acceptChecks(ctx: Awaited<ReturnType<JourneyCore['load']>>, key: string, versionId: string) {
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (!['in_progress', 'stale', 'changes_requested', 'in_review'].includes(stage.status)) throw new ConflictException('STAGE_NOT_ACCEPTABLE');
    if (stage.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    if (ctx.openNotices.some((notice) => notice.targetKey === stageKey)) throw new ConflictException('CHANGE_NOTICE_OPEN');
    if (this.core.waitingBranches(ctx, stageKey).length) throw new ConflictException('BRANCHES_NOT_ALIGNED');
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const version = await this.core.versionContent(versionId);
    if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
    if (definition.artifactType === 'techplan' && !sameTechPlan(await this.core.techPlanFor(ctx, stageKey, null), version.content as unknown as TechPlan)) throw new ConflictException('TECHPLAN_OUTDATED');
    if (definition.artifactType === 'site') {
      const site = version.content as unknown as SiteArtifact;
      if (site.checks.some((check) => check.required && check.status === 'failed')) throw new UnprocessableEntityException('REQUIRED_CHECKS_FAILED');
      const sources = await this.core.renderSources(ctx, true);
      if (stableStringify(sources.versionIds) !== stableStringify(site.sourceVersionIds)) throw new ConflictException('BUILD_OUTDATED');
    } else {
      const issues = completenessIssues(definition.artifactType, version.content, await this.core.checkContext(ctx, key as StageKey));
      if (issues.length) throw new UnprocessableEntityException(`STAGE_INCOMPLETE:${issues.map((issue) => issue.key).join(',')}`);
    }
    return version;
  }

  private async applyAccept(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], ctx: Awaited<ReturnType<JourneyCore['load']>>, key: string, versionId: string,
    version: { versionNumber: number; content: unknown; id: string }, userId: string, approvals: { count: number; policy: ApprovalPolicy } | null,
  ) {
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    // The guarded update locks the stage row: a second «accept» (double click, two tabs) waits and then finds nothing to
    // change, so payments and change notices are created once.
    const moved = await tx.projectStage.updateMany({
      where: { id: stage.id, status: { in: ['in_progress', 'stale', 'changes_requested', 'in_review'] }, currentVersionId: versionId },
      data: { status: 'approved', approvedVersionId: versionId, approvedAt: new Date(), approvedByUserId: userId, reviewNote: null },
    });
    if (moved.count !== 1) throw new ConflictException('STAGE_VERSION_CONFLICT');
    // What paid specialists are owed is fixed at acceptance: the fixed price, or approved minutes × rate within the limit.
    await this.worktime.paymentsOnAccept(tx, stage.id, version.versionNumber);
    // Specialists keep read access for a grace period after acceptance; writing and AI use stop now.
    const completed = await tx.stageAssignment.updateMany({
      where: { stageId: stage.id, status: 'active' },
      data: { status: 'completed', completedAt: new Date(), readUntil: new Date(Date.now() + SPECIALIST_READ_GRACE_MS) },
    });
    if (completed.count) await this.core.event(tx, ctx.project.id, userId, 'assignments_completed', key, { count: completed.count });
    await this.core.writeStatuses(tx, { project: ctx.project, statuses: { ...ctx.statuses, [stageKey]: 'approved' } }, unlockDependents(ctx.route, { ...ctx.statuses, [stageKey]: 'approved' }));
    await this.core.event(tx, ctx.project.id, userId, 'stage_accepted', key, { versionNumber: version.versionNumber, ...(approvals ? { approvals: approvals.count, policy: approvals.policy } : {}) });
    return this.changes.createChangeNotices(tx, ctx, stageKey, stage.approvedVersionId, version as never, userId);
  }

  private async afterAccept(ctx: Awaited<ReturnType<JourneyCore['load']>>, key: string, notices: Array<{ targetKey: StageKey }>) {
    const definition = stageDefinitions[key as StageKey];
    for (const notice of notices) await this.changes.notifyChange(ctx, notice.targetKey, () => tr("В проекте «{0}» изменился этап «{1}», на котором построен этап «{2}». Посмотрите, что изменилось, и решите: принять или обсудить. {3}", [ctx.project.name, tr(definition.title), tr(stageDefinitions[notice.targetKey].title), this.core.stageLink(ctx.project.id, notice.targetKey)]).trim(), 'target');
  }

  private approvalRow(stageId: string) {
    return this.prisma.projectStage.findUniqueOrThrow({ where: { id: stageId }, select: { approvalPolicy: true, approvalRound: true } });
  }

  private async teamRoles(projectId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.projectMember.findMany({ where: { projectId, status: 'active' }, select: { userId: true, role: true } });
    return new Map(rows.map((row) => [row.userId, row.role]));
  }

  /** The approval picture of the current version for the stage screen. */
  async approvalView(ctx: Awaited<ReturnType<JourneyCore['load']>>, userId: string, key: string, current: { id: string; createdByUserId: string } | null) {
    const stage = this.core.stageOf(ctx, key);
    const row = await this.approvalRow(stage.id);
    const policy = readPolicy(row.approvalPolicy);
    const members = await this.teamRoles(ctx.project.id);
    const people = await this.prisma.user.findMany({ where: { id: { in: [...members.keys()] } }, select: { id: true, name: true, email: true } });
    const managing = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const nameOf = (id: string) => { const person = people.find((item) => item.id === id); return person?.name || (managing ? person?.email : null) || tr('Участник'); };
    const candidates = managing ? [...members.entries()].filter(([, role]) => APPROVER_ROLES.has(role)).map(([id, role]) => ({ userId: id, name: nameOf(id), role })) : [];
    if (!policy) return { policy: null, policyText: null, candidates, canEditPolicy: managing && editableProject(ctx.project.status) };
    const approvals = current ? await this.prisma.stageApproval.findMany({ where: { stageId: stage.id, versionId: current.id, round: row.approvalRound }, orderBy: { createdAt: 'asc' }, select: { userId: true, comment: true, createdAt: true } }) : [];
    const state = approvalState(policy, members, approvals.map((item) => item.userId), current?.createdByUserId ?? null);
    const blocker = current ? approveBlocker(policy, members, userId, current.createdByUserId, approvals.some((item) => item.userId === userId)) : 'NO_VERSION';
    const open = ['in_review'].includes(stage.status) && editableProject(ctx.project.status);
    return {
      policy, policyText: policyText(policy, nameOf), candidates, canEditPolicy: managing && editableProject(ctx.project.status),
      reviewers: policy.reviewers.map((id) => ({ userId: id, name: nameOf(id), approved: state.approvedBy.includes(id), active: state.eligible.includes(id), author: id === current?.createdByUserId })),
      approvals: approvals.filter((item) => state.approvedBy.includes(item.userId)).map((item) => ({ name: nameOf(item.userId), comment: item.comment, createdAt: item.createdAt })),
      approved: state.approvedBy.length, required: state.required, broken: state.broken,
      canApprove: open && !blocker && !state.broken, approveBlocker: open ? blocker : 'STAGE_NOT_IN_REVIEW',
      isReviewer: policy.reviewers.includes(userId),
    };
  }

  /** Owner or manager sets who approves this stage; any earlier approvals stop counting. Null — back to «I accept myself». */
  async setApprovalPolicy(userId: string, projectId: string, key: string, input: { mode: unknown; reviewers: unknown; quorum: unknown; authorMayApprove: unknown } | null) {
    const ctx = await this.core.load(userId, projectId, 'accept', key);
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const stage = this.core.stageOf(ctx, key);
    let policy: ApprovalPolicy | null = null;
    if (input) {
      const checked = checkPolicy(input, await this.teamRoles(projectId));
      if (typeof checked === 'string') throw new BadRequestException(checked);
      policy = checked;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.projectStage.update({ where: { id: stage.id }, data: { approvalPolicy: policy ?? Prisma.DbNull, approvalRound: { increment: 1 } } });
      await this.core.event(tx, projectId, userId, 'approval_policy_changed', key, { policy });
    });
    if (policy && stage.status === 'in_review') await this.notifyReviewers(ctx, key, policy, userId);
    return this.stage(userId, projectId, key);
  }

  /** A reviewer approves the current version. When the policy is met, the stage is accepted in the same step. */
  async approve(userId: string, projectId: string, key: string, versionId: string, comment: string | null) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    if (ctx.viewer.kind !== 'member') throw new ForbiddenException('NOT_A_REVIEWER');
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const stage = this.core.stageOf(ctx, key);
    if (stage.status !== 'in_review') throw new ConflictException('STAGE_NOT_IN_REVIEW');
    const version = await this.acceptChecks(ctx, key, versionId);
    const author = await this.prisma.stageArtifactVersion.findUniqueOrThrow({ where: { id: versionId }, select: { createdByUserId: true } });
    let accepted = false;
    const notices = await this.prisma.$transaction(async (tx) => {
      // One reviewer at a time per stage: the count after this approval is exact, so the stage is accepted exactly once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stage.id}))`;
      const row = await tx.projectStage.findUniqueOrThrow({ where: { id: stage.id }, select: { approvalPolicy: true, approvalRound: true, status: true, currentVersionId: true } });
      const policy = readPolicy(row.approvalPolicy);
      if (!policy) throw new ConflictException('NO_APPROVAL_POLICY');
      if (row.status !== 'in_review' || row.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
      const members = await this.teamRoles(projectId);
      const given = await tx.stageApproval.findMany({ where: { stageId: stage.id, versionId, round: row.approvalRound }, select: { userId: true } });
      const blocker = approveBlocker(policy, members, userId, author.createdByUserId, given.some((item) => item.userId === userId));
      if (blocker) throw new ConflictException(blocker);
      await tx.stageApproval.create({ data: { projectId, stageId: stage.id, versionId, round: row.approvalRound, userId, comment, policy } });
      await this.core.event(tx, projectId, userId, 'stage_approval_given', key, { versionNumber: version.versionNumber });
      const state = approvalState(policy, members, [...given.map((item) => item.userId), userId], author.createdByUserId);
      if (state.broken) throw new ConflictException('APPROVAL_POLICY_BROKEN');
      if (!state.met) return [];
      accepted = true;
      return this.applyAccept(tx, ctx, key, versionId, version, userId, { count: state.approvedBy.length, policy });
    });
    const title = stageDefinitions[key as StageKey].title;
    const approver = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const who = approver?.name || approver?.email || '';
    if (accepted) {
      await this.afterAccept(ctx, key, notices);
      await this.core.notifyUser(ctx.project.ownerUserId, () => tr("Этап «{0}» в проекте «{1}» принят: набраны все нужные одобрения. {2}", [tr(title), ctx.project.name, this.core.stageLink(projectId, key)]).trim()).catch(() => undefined);
    } else if (ctx.project.ownerUserId !== userId) {
      await this.core.notifyUser(ctx.project.ownerUserId, () => tr("{0} одобрил(а) этап «{1}» в проекте «{2}». {3}", [who, tr(title), ctx.project.name, this.core.stageLink(projectId, key)]).trim()).catch(() => undefined);
    }
    return this.stage(userId, projectId, key);
  }

  private async notifyReviewers(ctx: Awaited<ReturnType<JourneyCore['load']>>, key: string, policy: ApprovalPolicy, exceptUserId: string) {
    const title = stageDefinitions[key as StageKey].title;
    for (const id of policy.reviewers) {
      if (id === exceptUserId) continue;
      await this.core.notifyUser(id, () => tr("Этап «{0}» в проекте «{1}» ждёт вашей проверки. {2}", [tr(title), ctx.project.name, this.core.stageLink(ctx.project.id, key)]).trim()).catch(() => undefined);
    }
  }

  async reopen(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'accept', key);
    const stage = this.core.stageOf(ctx, key);
    if (stage.status !== 'approved' && stage.status !== 'imported') throw new ConflictException('STAGE_NOT_ACCEPTED');
    const next = reopenStage(ctx.statuses, key as StageKey);
    await this.prisma.$transaction(async (tx) => {
      await this.core.writeStatuses(tx, ctx, next);
      await this.core.event(tx, projectId, userId, 'stage_reopened', key, {});
    });
    return this.journey(userId, projectId);
  }

  async submit(userId: string, projectId: string, key: string, versionId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const policy = readPolicy((await this.approvalRow(stage.id)).approvalPolicy);
    // Without a policy the owner or a manager accepts directly; with one, anyone who works on the stage sends it to the reviewers.
    if (!policy && ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role)) throw new ConflictException('OWNER_ACCEPTS_DIRECTLY');
    const stageKey = key as StageKey;
    if (!['in_progress', 'stale', 'changes_requested'].includes(stage.status)) throw new ConflictException('STAGE_NOT_SUBMITTABLE');
    if (stage.currentVersionId !== versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    if (ctx.openNotices.some((notice) => notice.targetKey === stageKey)) throw new ConflictException('CHANGE_NOTICE_OPEN');
    if (!inputsSatisfied(ctx.route, ctx.dep, stageKey)) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const version = await this.core.versionContent(versionId);
    const definition = stageDefinitions[stageKey];
    if (version && definition.artifactType !== 'site') {
      const issues = completenessIssues(definition.artifactType, version.content, await this.core.checkContext(ctx, key as StageKey));
      if (issues.length) throw new UnprocessableEntityException(`STAGE_INCOMPLETE:${issues.map((issue) => issue.key).join(',')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'in_review' } });
      await this.core.event(tx, projectId, userId, 'stage_submitted', key, { versionNumber: version?.versionNumber ?? null });
    });
    if (policy) await this.notifyReviewers(ctx, key, policy, userId);
    else await this.core.notifyUser(ctx.project.ownerUserId, () => tr("Этап «{0}» в проекте «{1}» отправлен вам на приёмку. {2}", [tr(definition.title), ctx.project.name, this.core.stageLink(projectId, key)]).trim()).catch(() => undefined);
    await this.worktime.recordAction(userId, projectId, key);
    return this.journey(userId, projectId);
  }

  async requestChanges(userId: string, projectId: string, key: string, note: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const policy = readPolicy((await this.approvalRow(stage.id)).approvalPolicy);
    // The owner and managers may always return a stage; a reviewer named in the policy may too.
    const managing = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const reviewer = ctx.viewer.kind === 'member' && Boolean(policy?.reviewers.includes(userId)) && APPROVER_ROLES.has(ctx.role);
    if (!managing && !reviewer) throw new ForbiddenException('STAGE_ACCEPT_FORBIDDEN');
    if (stage.status !== 'in_review') throw new ConflictException('STAGE_NOT_IN_REVIEW');
    await this.prisma.$transaction(async (tx) => {
      // A request for changes starts a new round: approvals already given were for the version as it was.
      await tx.projectStage.update({ where: { id: stage.id }, data: { status: 'changes_requested', reviewNote: note, approvalRound: { increment: 1 } } });
      await this.core.event(tx, projectId, userId, 'stage_changes_requested', key, {});
    });
    const leads = await this.prisma.stageAssignment.findMany({ where: { stageId: stage.id, status: 'active', role: 'lead' }, select: { userId: true } });
    const author = stage.currentVersionId ? await this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.currentVersionId }, select: { createdByUserId: true } }) : null;
    // The leads, and a team member who made the version; the person asking does not get their own message.
    const recipients = new Set([...leads.map((lead) => lead.userId), author?.createdByUserId].filter((id): id is string => Boolean(id) && id !== userId));
    for (const id of recipients) {
      await this.core.notifyUser(id, () => (managing ? tr("Владелец проекта «{0}» просит доработать этап «{1}»: {2} {3}", [ctx.project.name, tr(stageDefinitions[key as StageKey].title), note, this.core.stageLink(projectId, key)])
        : tr("Проверяющий в проекте «{0}» просит доработать этап «{1}»: {2} {3}", [ctx.project.name, tr(stageDefinitions[key as StageKey].title), note, this.core.stageLink(projectId, key)])).trim()).catch(() => undefined);
    }
    return this.journey(userId, projectId);
  }

  async suggest(userId: string, projectId: string, key: string, input: { text: string; targetKey: string | null }) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const assignment = this.core.assignmentFor(ctx, key);
    if (assignment?.role !== 'consultant' || assignment.status !== 'active') throw new ForbiddenException('SUGGEST_FORBIDDEN');
    const stage = this.core.stageOf(ctx, key);
    if (stage.status === 'approved' || stage.status === 'imported') throw new ConflictException('STAGE_ACCEPTED_REOPEN_FIRST');
    const created = await this.prisma.$transaction(async (tx) => {
      const suggestion = await tx.stageInstruction.create({
        data: { projectId, stageId: stage.id, authorUserId: userId, kind: 'suggestion', status: 'proposed', text: input.text, targetKey: input.targetKey },
        select: { id: true, text: true, targetKey: true, status: true, createdAt: true },
      });
      await this.core.event(tx, projectId, userId, 'suggestion_added', key, { suggestionId: suggestion.id });
      return suggestion;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: created };
  }

  async resolveSuggestion(userId: string, projectId: string, key: string, suggestionId: string, action: 'apply' | 'dismiss') {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!isUuid(suggestionId)) throw new NotFoundException('SUGGESTION_NOT_FOUND');
    const suggestion = await this.prisma.stageInstruction.findFirst({ where: { id: suggestionId, stageId: stage.id, kind: 'suggestion', status: 'proposed' }, select: { id: true, text: true, targetKey: true } });
    if (!suggestion) throw new NotFoundException('SUGGESTION_NOT_FOUND');
    let result: unknown = null;
    if (action === 'apply') {
      // The suggestion becomes an AI instruction from the person who accepted it; failures leave it proposed.
      const current = await this.core.versionContent(stage.currentVersionId);
      const definition = stageDefinitions[key as StageKey];
      const target = suggestion.targetKey && current && lockableKeys(definition.artifactType, current.content).includes(suggestion.targetKey) ? suggestion.targetKey : null;
      result = (await this.stageAi.generate(userId, projectId, key, { instruction: suggestion.text, saveAs: 'one_off', targetKey: target })).data;
    }
    await this.prisma.stageInstruction.update({ where: { id: suggestion.id }, data: { status: action === 'apply' ? 'applied' : 'dismissed' } });
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: action === 'apply' ? 'suggestion_applied' : 'suggestion_dismissed', stageKey: key, details: { suggestionId } } });
    return { data: { id: suggestion.id, status: action === 'apply' ? 'applied' : 'dismissed', generation: result } };
  }

  async setProjectStatus(userId: string, projectId: string, action: 'complete' | 'resume' | 'archive' | 'unarchive') {
    const ctx = await this.core.load(userId, projectId, 'members');
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
      await this.core.event(tx, projectId, userId, eventType, null, {});
    });
    return this.journey(userId, projectId);
  }

  /** Project membership for other modules: role, whether the viewer may decide for the project, name and status. */
  async projectAccess(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'members');
    return { role: ctx.role, canDecide: acceptRoles.has(ctx.role), name: ctx.project.name, status: ctx.project.status, projectType: ctx.type.key as string | null, hasSpecialists: (await this.prisma.stageAssignment.count({ where: { projectId, status: { in: ['invited', 'active', 'completed'] } } })) > 0 };
  }

  async result(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'members');
    const stages = await Promise.all(ctx.route.map(async (key) => {
      const stage = this.core.stageOf(ctx, key);
      const accepted = isSatisfied(ctx.dep[key]) ? await this.core.versionContent(stage.approvedVersionId) : null;
      return { key, title: stageDefinitions[key].title, status: stage.status, statusLabel: statusExplanations[stage.status].label, accepted };
    }));
    const get = <T>(key: StageKey) => stages.find((stage) => stage.key === key)?.accepted?.content as T | undefined;
    const brief = get<Brief>('goal');
    const offer = get<Offer>('offer');
    const content = get<ContentArtifact>('content');
    const site = get<SiteArtifact>('build');
    const openItems = stages.filter((stage) => !stage.accepted).map((stage) => `Этап «${stage.title}» не принят (${stage.statusLabel.toLowerCase()}).`);
    const technology = (await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'technologies' } }, select: { optionKey: true, reason: true } }));
    const stagesInfo = stages;
    // project.md is a project file: written in the project's language, with stage names translated.
    const projectMarkdown = (): string => {
      const stages = stagesInfo.map((stage) => ({ ...stage, title: tr(stage.title), statusLabel: tr(stage.statusLabel) }));
      const openItems = stages.filter((stage) => !stage.accepted).map((stage) => tr('Этап «{0}» не принят ({1}).', [stage.title, stage.statusLabel.toLowerCase()]));
      const technologyLabel: Record<string, string> = { buildpath: tr("технологии BuildPath"), developer: tr("свой стек у разработчика"), constructor: tr("конструктор сайтов") };
      const lines: string[] = [`# ${ctx.project.name}`, '', tr("Тип проекта: {0}", [tr(ctx.type.title)]), tr("Сформировано: {0}", [new Date().toISOString()])];
      if (technology) lines.push(tr("Технологии: {0}{1}", [technologyLabel[technology.optionKey] ?? technology.optionKey, technology.reason ? ` — ${technology.reason}` : '']));
      lines.push('');
      for (const stage of stages) lines.push(`- ${stage.title}: ${stage.accepted ? tr("принят, версия {0}", [stage.accepted.versionNumber]) : stage.statusLabel.toLowerCase()}`);
      if (brief) {
        lines.push('', tr("## Паспорт проекта"), '', tr("- Название: {0}", [brief.businessName]), tr("- Чем занимаемся: {0}", [brief.whatYouDo]), tr("- Клиенты: {0}", [brief.audience]));
        if (brief.city) lines.push(tr("- Город: {0}", [brief.city]));
        for (const [label, value] of [[tr("Телефон"), brief.phone], [tr("Мессенджер"), brief.messenger], ['Email', brief.email], [tr("Адрес"), brief.address]] as const) if (value) lines.push(`- ${label}: ${value}`);
      }
      if (offer) {
        lines.push('', tr("## Услуги"), '');
        for (const service of offer.services) lines.push(`- ${service.name}${service.price ? ` — ${service.price}` : ''}${service.description ? `. ${service.description}` : ''}`);
        if (offer.hours) lines.push('', tr("Часы работы: {0}", [offer.hours]));
      }
      const schedule = get<Schedule>('schedule');
      if (schedule) {
        lines.push('', tr("## Расписание и запись"), '', tr("Часовой пояс: {0}. Шаг времени: {1} мин. Запись не позже чем за {2} ч, на {3} дн. вперёд; отмена клиентом — не позже чем за {4} ч.", [schedule.timezone, schedule.rules.slotStep, schedule.rules.minNoticeHours, schedule.rules.horizonDays, schedule.rules.cancelHours]), '');
        for (const service of schedule.services) lines.push(tr("- {0}: {1} мин", [service.name, service.minutes]));
        for (const master of schedule.masters) {
          const days = master.week.map((day, index) => (day ? `${weekdayShort(index)} ${day.from}–${day.to}` : null)).filter(Boolean).join(', ');
          lines.push(tr("- Мастер {0}: {1}; {2}", [master.name, master.services.length ? master.services.join(', ') : tr("все услуги"), days || tr("нет рабочих дней")]));
        }
      }
      const map = get<Sitemap>('sitemap');
      if (map) {
        lines.push('', tr('## Карта сайта'), '');
        for (const page of map.pages) lines.push(`- \`${page.path}\` — ${page.title}${page.purpose ? `: ${page.purpose}` : ''}`);
      }
      const store = get<Catalog>('products');
      if (store) {
        lines.push('', tr('## Каталог товаров'), '');
        for (const product of store.products) lines.push(`- ${product.name} — ${tenge(product.price)}${product.unit ? ` / ${product.unit}` : ''}${product.available ? '' : ` (${tr('нет в наличии')})`}`);
        lines.push('', tr('Получение: {0}', [store.delivery.map((option) => `${option.title} — ${option.price ? tenge(option.price) : tr('бесплатно')}`).join('; ')]));
      }
      if (content) {
        lines.push('', tr("## Тексты сайта"), '', tr("Заголовок для поиска: {0}", [content.seo.title]), tr("Описание для поиска: {0}", [content.seo.description]));
        for (const section of content.sections) {
          lines.push('', `### ${section.title || tr(sectionTypeLabels[section.type])}`, '');
          if (section.text) lines.push(section.text);
          for (const item of section.items) lines.push(`- ${item.title}${item.text ? ` — ${item.text}` : ''}`);
          if (section.buttonLabel) lines.push(tr("[Кнопка: {0}]", [section.buttonLabel]));
        }
      }
      if (openItems.length) lines.push('', tr("## Что ещё не сделано"), '', ...openItems.map((item) => `- ${item}`));
      if (site?.meta?.hasForm) lines.push('', tr("> Форма заявки работает, когда сайт опубликован на BuildPath. На другом хостинге форму нужно подключить к своему обработчику."));
      return `${lines.join('\n')}\n`;
    };
    const files = [{ name: 'project.md', mimeType: 'text/markdown', content: inProject(ctx, projectMarkdown) }];
    if (site) files.push({ name: 'site.html', mimeType: 'text/html', content: await this.core.inline(projectId, site.html) });
    // Other pages of a multi-page site, laid out as on a static host: /services → pages/services/index.html.
    for (const page of site?.pages ?? []) if (page.path !== '/') files.push({ name: `pages${page.path}/index.html`, mimeType: 'text/html', content: await this.core.inline(projectId, page.html) });
    const plan = get<TechPlan>('techplan');
    if (plan) {
      files.push({ name: 'architecture.md', mimeType: 'text/markdown', content: inProject(ctx, () => techPlanMarkdown(plan)) });
      if (plan.api || plan.kind === 'booking') files.push({ name: plan.kind === 'site' ? 'lead-api.yaml' : 'booking-api.yaml', mimeType: 'text/yaml', content: plan.api || inProject(ctx, () => bookingApiContract()) });
    }
    files.push({
      name: 'project.json', mimeType: 'application/json',
      content: JSON.stringify({
        catalogVersion: ROUTE_CATALOG_VERSION, project: { name: ctx.project.name, type: ctx.type.key },
        stages: stages.map((stage) => ({ key: stage.key, status: stage.status, acceptedVersion: stage.accepted?.versionNumber ?? null, content: stage.key === 'build' ? undefined : stage.accepted?.content ?? null })),
        openItems,
      }, null, 2),
    });
    await this.core.event(this.prisma, projectId, userId, 'result_downloaded', null, { stages: stages.map((stage) => ({ key: stage.key, version: stage.accepted?.versionNumber ?? null })) });
    return { data: { generatedAt: new Date().toISOString(), complete: openItems.length === 0, openItems, siteReady: Boolean(site), files } };
  }

  // --- Delegated to the split services (public API kept for controllers, the bot and other modules) ---

  setProvider(provider: StageAiProvider | null): void { this.core.setProvider(provider); }
  aiConfigured(): boolean { return Boolean(this.core.ai()); }
  generate(...args: Parameters<StageAiService['generate']>) { return this.stageAi.generate(...args); }
  aiHistory(...args: Parameters<StageAiService['aiHistory']>) { return this.stageAi.aiHistory(...args); }
  changeNotices(...args: Parameters<ChangeNoticesService['changeNotices']>) { return this.changes.changeNotices(...args); }
  explainChange(...args: Parameters<ChangeNoticesService['explainChange']>) { return this.changes.explainChange(...args); }
  actOnChange(...args: Parameters<ChangeNoticesService['actOnChange']>) { return this.changes.actOnChange(...args); }
  setChangeResponseDays(...args: Parameters<ChangeNoticesService['setChangeResponseDays']>) { return this.changes.setChangeResponseDays(...args); }
  processChangeDeadlines(...args: Parameters<ChangeNoticesService['processChangeDeadlines']>) { return this.changes.processChangeDeadlines(...args); }
}
