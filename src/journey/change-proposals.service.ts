import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { routeInputs, stageDefinitions, type StageKey } from './catalog.js';
import { JourneyCore, acceptRoles, editableProject, isUuid } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { StageAiService } from './stage-ai.service.js';
import { isSatisfied } from './stage-state.js';

const OPEN_PER_AUTHOR = 10;

/**
 * Change proposals (STAGE_WORK_MODEL §6): a specialist's instructions cannot change an accepted requirement, so a specialist who
 * thinks one is wrong proposes a change. Nothing changes until the owner or a manager accepts. Accepting reopens the requirement
 * stage and, when AI is connected and asked for, drafts the change there; the usual acceptance then notifies the stages built on it.
 */
@Injectable()
export class ChangeProposalsService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly journey: JourneyService, private readonly stageAi: StageAiService) {}

  async create(userId: string, projectId: string, fromKey: string, raw: unknown) {
    const ctx = await this.core.load(userId, projectId, 'read', fromKey);
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const assignment = this.core.assignmentFor(ctx, fromKey);
    if (!assignment || assignment.status !== 'active') throw new ForbiddenException('PROPOSAL_ONLY_FOR_SPECIALISTS');
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const targetKey = typeof input.targetStageKey === 'string' ? input.targetStageKey : '';
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length < 10 || text.length > 1000) throw new BadRequestException('PROPOSAL_TEXT_INVALID');
    // Only a requirement the specialist can see: an input of their stage or a result the owner opened to them.
    const visible = [...routeInputs(ctx.route, fromKey as StageKey), ...assignment.scope.extraReadStages];
    if (!visible.includes(targetKey as StageKey)) throw new BadRequestException('PROPOSAL_TARGET_INVALID');
    if (!isSatisfied(ctx.dep[targetKey as StageKey])) throw new ConflictException('PROPOSAL_TARGET_NOT_ACCEPTED');
    const open = await this.prisma.changeProposal.count({ where: { projectId, authorUserId: userId, status: 'open' } });
    if (open >= OPEN_PER_AUTHOR) throw new ConflictException('PROPOSAL_LIMIT');
    const from = this.core.stageOf(ctx, fromKey);
    const target = this.core.stageOf(ctx, targetKey);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.changeProposal.create({ data: { projectId, fromStageId: from.id, targetStageId: target.id, authorUserId: userId, text }, select: { id: true, createdAt: true } });
      await this.core.event(tx, projectId, userId, 'change_proposed', targetKey, { proposalId: row.id, fromStageKey: fromKey });
      return row;
    });
    const deciders = await this.prisma.projectMember.findMany({ where: { projectId, status: 'active', role: { in: [...acceptRoles] as never } }, select: { userId: true } });
    const fromTitle = stageDefinitions[fromKey as StageKey].title;
    const targetTitle = stageDefinitions[targetKey as StageKey].title;
    for (const decider of deciders) {
      void this.core.notifyUser(decider.userId, () => tr('Специалист этапа «{0}» предлагает изменить «{1}»: {2}\n{3}', [tr(fromTitle), tr(targetTitle), text, this.core.stageLink(projectId, targetKey)])).catch(() => undefined);
    }
    return { data: { id: created.id, status: 'open', createdAt: created.createdAt } };
  }

  /** Owners and managers see every proposal of the project; a specialist sees their own. */
  async list(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const deciding = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    if (ctx.viewer.kind === 'member' && !deciding) throw new ForbiddenException('PROPOSALS_FORBIDDEN');
    const rows = await this.prisma.changeProposal.findMany({
      where: { projectId, ...(deciding ? {} : { authorUserId: userId }) }, orderBy: { createdAt: 'desc' }, take: 100,
      select: {
        id: true, text: true, status: true, decisionNote: true, decidedAt: true, createdAt: true, authorUserId: true,
        fromStage: { select: { stageKey: true } }, targetStage: { select: { stageKey: true, status: true } },
        author: { select: { name: true, email: true } },
      },
    });
    return {
      data: {
        canDecide: deciding,
        proposals: rows.map((row) => ({
          id: row.id, text: row.text, status: row.status, decisionNote: row.decisionNote, decidedAt: row.decidedAt, createdAt: row.createdAt,
          fromStageKey: row.fromStage.stageKey, fromTitle: stageDefinitions[row.fromStage.stageKey as StageKey]?.title ?? row.fromStage.stageKey,
          targetStageKey: row.targetStage.stageKey, targetTitle: stageDefinitions[row.targetStage.stageKey as StageKey]?.title ?? row.targetStage.stageKey,
          author: deciding ? row.author.name || row.author.email : tr('Вы'), mine: row.authorUserId === userId,
        })),
      },
    };
  }

  /**
   * accept: the requirement stage is reopened (if it was accepted) and, with applyWithAi, the AI drafts the change from the proposal text.
   * The owner then reviews and accepts that stage as usual. reject: closed with an optional note for the specialist.
   */
  async decide(userId: string, projectId: string, proposalId: string, raw: unknown) {
    if (!isUuid(proposalId)) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const decision = input.decision;
    if (decision !== 'accept' && decision !== 'reject') throw new BadRequestException('PROPOSAL_DECISION_INVALID');
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    if (note && note.length > 500) throw new BadRequestException('PROPOSAL_NOTE_TOO_LONG');
    const proposal = await this.prisma.changeProposal.findFirst({ where: { id: proposalId, projectId }, select: { id: true, status: true, text: true, authorUserId: true, targetStage: { select: { stageKey: true } } } });
    if (!proposal) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const targetKey = proposal.targetStage.stageKey;
    const ctx = await this.core.load(userId, projectId, 'accept', targetKey);
    if (proposal.status !== 'open') throw new ConflictException('PROPOSAL_ALREADY_DECIDED');

    // Decide first, atomically: two owners pressing at once must not both reopen and draft.
    const decided = await this.prisma.changeProposal.updateMany({ where: { id: proposal.id, status: 'open' }, data: { status: decision === 'accept' ? 'accepted' : 'rejected', decidedByUserId: userId, decisionNote: note, decidedAt: new Date() } });
    if (decided.count !== 1) throw new ConflictException('PROPOSAL_ALREADY_DECIDED');
    await this.core.event(this.prisma, projectId, userId, decision === 'accept' ? 'change_proposal_accepted' : 'change_proposal_rejected', targetKey, { proposalId: proposal.id, note });

    let generation: { ok: boolean; code: string | null } | null = null;
    if (decision === 'accept') {
      const stage = this.core.stageOf(ctx, targetKey);
      if (stage.status === 'approved' || stage.status === 'imported') await this.journey.reopen(userId, projectId, targetKey);
      if (input.applyWithAi === true) {
        try {
          await this.stageAi.generate(userId, projectId, targetKey, { instruction: tr('Предложение изменения от специалиста, принятое владельцем: {0}', [proposal.text]), saveAs: 'one_off', targetKey: null });
          generation = { ok: true, code: null };
        } catch (caught) {
          // The decision stands; the owner applies the change by hand or asks the AI again from the stage page.
          generation = { ok: false, code: caught instanceof Error ? caught.message : 'AI_FAILED' };
        }
      }
    }
    const title = tr(stageDefinitions[targetKey as StageKey].title);
    void this.core.notifyUser(proposal.authorUserId, () => decision === 'accept'
      ? tr('Владелец принял ваше предложение изменить «{0}».{1}', [title, note ? ` ${note}` : ''])
      : tr('Владелец отклонил ваше предложение изменить «{0}».{1}', [title, note ? ` ${note}` : ''])).catch(() => undefined);
    return { data: { id: proposal.id, status: decision === 'accept' ? 'accepted' : 'rejected', targetStageKey: targetKey, generation } };
  }

  async withdraw(userId: string, projectId: string, proposalId: string) {
    if (!isUuid(proposalId)) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const updated = await this.prisma.changeProposal.updateMany({ where: { id: proposalId, projectId, authorUserId: userId, status: 'open' }, data: { status: 'withdrawn', decidedAt: new Date() } });
    if (updated.count !== 1) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    await this.core.event(this.prisma, projectId, userId, 'change_proposal_withdrawn', null, { proposalId });
    return { data: { id: proposalId, status: 'withdrawn' } };
  }
}
