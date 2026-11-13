import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { describeChanges } from '../journey/change-summary.js';
import { PublishingService } from './publishing.service.js';
import { QUICK_EDIT_STAGES, checkContacts, checkRequest, contactChanges, instructionFor, targetFor, type Contacts } from './quick-edit.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * «Изменить сайт» for a live site. It only chains the ordinary stage actions — reopen, AI draft, accept, the change
 * notice to the build, build, accept the build, update the site — so versions, checks, notices, AI limits and the
 * project history work exactly as when the owner does it by hand. Nothing reaches the live site before the owner
 * confirms; cancelling returns the stage to its accepted version and keeps the draft in the version history.
 */
@Injectable()
export class QuickEditService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService, private readonly publishing: PublishingService) {}

  private async load(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        status: true, projectType: true,
        publication: { select: { status: true, slug: true } },
        stages: { select: { id: true, stageKey: true, status: true, currentVersionId: true, approvedVersionId: true, lockedKeys: true } },
      },
    });
    const route = (projectTypeOf(project.projectType)?.stages ?? []) as StageKey[];
    const stage = (key: StageKey) => project.stages.find((item) => item.stageKey === key);
    return { member, project, route, stage, canChange: member.role === 'owner' || member.role === 'manager' };
  }

  /** The draft waiting for confirmation, if any: the last quick edit whose version is still the stage's current one. */
  private async pending(projectId: string, stage: (key: StageKey) => { id: string; status: string; currentVersionId: string | null; approvedVersionId: string | null } | undefined) {
    const last = await this.prisma.projectEvent.findFirst({ where: { projectId, type: { in: ['quick_edit_drafted', 'quick_edit_published', 'quick_edit_cancelled'] } }, orderBy: { createdAt: 'desc' }, select: { type: true, details: true, createdAt: true } });
    if (last?.type !== 'quick_edit_drafted') return null;
    const details = last.details as { stageKey: StageKey; versionId: string; request: string };
    const row = stage(details.stageKey);
    if (!row || row.status !== 'in_progress' || row.currentVersionId !== details.versionId || !row.approvedVersionId) return null;
    const [before, after] = await Promise.all([
      this.prisma.stageArtifactVersion.findUnique({ where: { id: row.approvedVersionId }, select: { content: true } }),
      this.prisma.stageArtifactVersion.findUnique({ where: { id: details.versionId }, select: { content: true, versionNumber: true } }),
    ]);
    return {
      stageKey: details.stageKey, stageTitle: stageDefinitions[details.stageKey].title, versionId: details.versionId, versionNumber: after?.versionNumber ?? null,
      request: details.request, createdAt: last.createdAt, changes: describeChanges(details.stageKey, before?.content ?? null, after?.content ?? null),
    };
  }

  /** Why the button can or cannot be used now, in the owner's terms. */
  private blocker(ctx: Awaited<ReturnType<QuickEditService['load']>>): string | null {
    if (!ctx.canChange) return 'QUICK_EDIT_FORBIDDEN';
    if (ctx.project.publication?.status !== 'live') return 'QUICK_EDIT_NOT_LIVE';
    if (ctx.stage('build')?.status !== 'approved') return 'QUICK_EDIT_BUILD_IN_WORK';
    return null;
  }

  async status(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId);
    const pending = await this.pending(projectId, ctx.stage);
    const targets = QUICK_EDIT_STAGES.filter((key) => ctx.route.includes(key)).map((key) => ({ key, title: stageDefinitions[key].title, status: ctx.stage(key)?.status ?? null }));
    const blocked = pending ? null : this.blocker(ctx);
    const goal = ctx.stage('goal');
    const brief = goal?.approvedVersionId ? (await this.prisma.stageArtifactVersion.findUnique({ where: { id: goal.approvedVersionId }, select: { content: true } }))?.content as Partial<Contacts> | undefined : undefined;
    return {
      data: {
        available: !blocked && targets.length > 0, reason: blocked, targets, pending, aiConfigured: this.journey.aiConfigured(),
        contacts: brief ? { phone: brief.phone ?? null, messenger: brief.messenger ?? null, email: brief.email ?? null, address: brief.address ?? null } : null,
        // Parts the owner edited by hand: the AI leaves them as they are unless the owner allows it.
        locked: Object.fromEntries(targets.map((target) => [target.key, ctx.stage(target.key)?.lockedKeys ?? []])),
      },
    };
  }

  async start(userId: string, projectId: string, input: { request: unknown; target: unknown; allowLocked: unknown }) {
    const checked = checkRequest(input.request);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const ctx = await this.load(userId, projectId);
    const blocked = this.blocker(ctx);
    if (blocked) throw blocked === 'QUICK_EDIT_FORBIDDEN' ? new ForbiddenException(blocked) : new ConflictException(blocked);
    if (await this.pending(projectId, ctx.stage)) throw new ConflictException('QUICK_EDIT_PENDING');
    if (!this.journey.aiConfigured()) throw new ConflictException('AI_NOT_CONFIGURED');
    const key = targetFor(checked.request, ctx.route, typeof input.target === 'string' ? input.target : null);
    if (!key) throw new BadRequestException('QUICK_EDIT_TARGET_INVALID');
    const stage = ctx.stage(key);
    // Someone is already working on this stage (the owner by hand or a specialist): a quick edit would cut across.
    if (stage?.status !== 'approved') throw new ConflictException('QUICK_EDIT_STAGE_IN_WORK');
    const lead = await this.prisma.stageAssignment.count({ where: { stageId: stage.id, role: 'lead', status: { in: ['invited', 'active'] } } });
    if (lead) throw new ConflictException('QUICK_EDIT_STAGE_HAS_LEAD');

    await this.journey.reopen(userId, projectId, key);
    // The owner allowed the AI to change parts they had edited by hand: lift that protection on this stage.
    if (input.allowLocked === true) for (const lockKey of stage.lockedKeys) await this.journey.setLock(userId, projectId, key, lockKey, false);
    let versionId: string;
    try {
      versionId = (await this.journey.generate(userId, projectId, key, { instruction: instructionFor(checked.request), saveAs: 'one_off', targetKey: null })).data.versionId;
    } catch (error) {
      // AI refused or failed (limits, balance, provider): leave the stage as it was, the site is untouched.
      await this.backToAccepted(userId, projectId, key, 'ai_failed');
      throw error;
    }
    const [before, after] = await Promise.all([
      this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.approvedVersionId! }, select: { content: true } }),
      this.prisma.stageArtifactVersion.findUnique({ where: { id: versionId }, select: { content: true } }),
    ]);
    if (!describeChanges(key, before?.content ?? null, after?.content ?? null).length) {
      // Nothing to show: say why instead of an empty confirmation. Hand-edited parts are the usual reason.
      await this.backToAccepted(userId, projectId, key, 'no_changes');
      const locked = input.allowLocked === true ? [] : stage.lockedKeys;
      throw new UnprocessableEntityException({ statusCode: 422, message: locked.length ? 'QUICK_EDIT_LOCKED' : 'QUICK_EDIT_NO_CHANGES', locked });
    }
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quick_edit_drafted', stageKey: key, details: { stageKey: key, versionId, request: checked.request } } });
    return this.status(userId, projectId);
  }

  /**
   * New phone, messenger, e-mail or address. They live on the «Цель» stage, which other stages are built on, so the
   * owner's confirmation also answers those stages «no change» — contacts do not change what they decided — and the
   * build is redone. No AI is used. Returns what changed.
   */
  async contacts(userId: string, projectId: string, raw: unknown) {
    const checked = checkContacts(raw);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const ctx = await this.load(userId, projectId);
    const blocked = this.blocker(ctx);
    if (blocked) throw blocked === 'QUICK_EDIT_FORBIDDEN' ? new ForbiddenException(blocked) : new ConflictException(blocked);
    if (await this.pending(projectId, ctx.stage)) throw new ConflictException('QUICK_EDIT_PENDING');
    const goal = ctx.stage('goal');
    if (goal?.status !== 'approved' || !goal.approvedVersionId) throw new ConflictException('QUICK_EDIT_STAGE_IN_WORK');
    if (await this.prisma.stageAssignment.count({ where: { stageId: goal.id, role: 'lead', status: { in: ['invited', 'active'] } } })) throw new ConflictException('QUICK_EDIT_STAGE_HAS_LEAD');
    const current = (await this.prisma.stageArtifactVersion.findUniqueOrThrow({ where: { id: goal.approvedVersionId }, select: { content: true } })).content as Record<string, unknown>;
    const changes = contactChanges(current as Partial<Contacts>, checked.contacts);
    if (!changes.length) throw new UnprocessableEntityException('QUICK_EDIT_NO_CHANGES');
    const slug = ctx.project.publication!.slug;

    await this.journey.reopen(userId, projectId, 'goal');
    try {
      const saved = await this.journey.saveDraft(userId, projectId, 'goal', { content: { ...current, ...checked.contacts }, baseVersionId: goal.approvedVersionId });
      await this.journey.accept(userId, projectId, 'goal', saved.data.versionId);
    } catch (error) {
      await this.backToAccepted(userId, projectId, 'goal', 'cancelled');
      throw error;
    }
    const goalId = goal.id;
    const notices = await this.prisma.changeNotice.findMany({ where: { projectId, sourceStageId: goalId, status: { in: ['open', 'discussing'] } }, select: { id: true } });
    for (const notice of notices) await this.journey.actOnChange(userId, projectId, notice.id, { action: 'accept_no_change', text: 'Изменились только контакты.', resolution: null });
    const result = await this.rebuildAndPublish(userId, projectId, slug, 'goal');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quick_edit_contacts', stageKey: 'goal', details: { fields: changes.map((change) => change.field), buildVersion: result.buildVersion } } });
    return { data: { ...(await this.status(userId, projectId)).data, published: { buildVersion: result.buildVersion, contacts: changes } } };
  }

  /** Build from the accepted stages, require the checks, accept the build and update the live site. */
  private async rebuildAndPublish(userId: string, projectId: string, slug: string, source: StageKey) {
    const build = await this.prisma.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'build' }, select: { id: true, status: true } });
    // The build may have got a change notice (texts, look) or still be accepted (contacts come from «Цель», which feeds it only through the page).
    const notices = await this.prisma.changeNotice.findMany({ where: { projectId, targetStageId: build.id, status: { in: ['open', 'discussing'] } }, select: { id: true } });
    for (const notice of notices) await this.journey.actOnChange(userId, projectId, notice.id, { action: 'accept', text: null, resolution: null });
    if ((await this.prisma.projectStage.findUniqueOrThrow({ where: { id: build.id }, select: { status: true } })).status === 'approved') await this.journey.reopen(userId, projectId, 'build');
    const built = await this.journey.build(userId, projectId);
    const failed = [...built.data.checks.filter((check) => check.required && check.status === 'failed').map((check) => check.id),
      ...built.data.quality.findings.filter((finding) => finding.blocking).map((finding) => `quality:${finding.id}`)];
    if (failed.length || built.data.quality.status === 'failed') {
      // The change is accepted, but the new build does not pass: the live site keeps the old version until it is fixed.
      await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quick_edit_checks_failed', stageKey: 'build', details: { source, checks: failed } } });
      throw new UnprocessableEntityException('QUICK_EDIT_CHECKS_FAILED');
    }
    await this.journey.accept(userId, projectId, 'build', built.data.versionId);
    await this.publishing.publish(userId, projectId, { slug, confirm: true });
    return { buildVersion: built.data.versionNumber };
  }

  async cancel(userId: string, projectId: string) {
    const ctx = await this.load(userId, projectId);
    if (!ctx.canChange) throw new ForbiddenException('QUICK_EDIT_FORBIDDEN');
    const pending = await this.pending(projectId, ctx.stage);
    if (!pending) throw new ConflictException('QUICK_EDIT_NOTHING_PENDING');
    await this.backToAccepted(userId, projectId, pending.stageKey, 'cancelled');
    return this.status(userId, projectId);
  }

  private async backToAccepted(userId: string, projectId: string, key: StageKey, reason: 'cancelled' | 'ai_failed' | 'no_changes') {
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: key }, select: { id: true, approvedVersionId: true } });
    if (!stage?.approvedVersionId) return;
    await this.prisma.$transaction([
      // Only from the state a quick edit leaves; a stage someone moved on meanwhile is not touched.
      this.prisma.projectStage.updateMany({ where: { id: stage.id, status: 'in_progress' }, data: { status: 'approved', currentVersionId: stage.approvedVersionId } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quick_edit_cancelled', stageKey: key, details: { reason } } }),
    ]);
  }

  /** The owner saw the changes and the preview: accept, rebuild, check and update the live site. */
  async confirm(userId: string, projectId: string, versionId: unknown) {
    const ctx = await this.load(userId, projectId);
    if (!ctx.canChange) throw new ForbiddenException('QUICK_EDIT_FORBIDDEN');
    const pending = await this.pending(projectId, ctx.stage);
    if (!pending || pending.versionId !== versionId) throw new ConflictException('QUICK_EDIT_NOTHING_PENDING');
    if (!pending.changes.length) throw new UnprocessableEntityException('QUICK_EDIT_NO_CHANGES');
    const slug = ctx.project.publication?.slug;
    if (!slug) throw new ConflictException('QUICK_EDIT_NOT_LIVE');

    await this.journey.accept(userId, projectId, pending.stageKey, pending.versionId);
    // The build was built on the old version, so it got a change notice: the owner's confirmation is the answer.
    const result = await this.rebuildAndPublish(userId, projectId, slug, pending.stageKey);
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quick_edit_published', stageKey: pending.stageKey, details: { stageKey: pending.stageKey, versionId: pending.versionId, buildVersion: result.buildVersion } } });
    return { data: { ...(await this.status(userId, projectId)).data, published: { buildVersion: result.buildVersion, changes: pending.changes } } };
  }
}
