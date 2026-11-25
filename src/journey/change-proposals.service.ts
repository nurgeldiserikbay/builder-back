import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { routeAncestors, routeInputs, stageDefinitions, type StageKey } from './catalog.js';
import { JourneyCore, acceptRoles, editableProject, isUuid } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { StageAiService } from './stage-ai.service.js';
import { UNSETTLED_REQUESTS } from './stage-requests.js';

const OPEN_PER_AUTHOR = 10;
const UNSETTLED = UNSETTLED_REQUESTS;

/**
 * Requests to an earlier stage (STAGE_WORK_MODEL §6, «Запрос к этапу»). Whoever works on a stage — the owner, a member or a
 * specialist — may find that an earlier stage is wrong or unclear. They raise a question or a needed change to it, marked as
 * blocking when they cannot go on without it. Nothing in the earlier stage changes by itself:
 * - a question is answered by the owner, a manager or the specialist of that stage, and the answer is enough;
 * - a change is taken on by the owner or a manager: the stage is reopened (the AI may draft the change), and when it is
 *   accepted again the request is resolved and the stages built on it get the usual change notices — the same path as any change;
 * - either may be rejected with a note.
 * A blocking request holds the stage it came from: that stage cannot be accepted until the request is settled.
 */
@Injectable()
export class ChangeProposalsService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly journey: JourneyService, private readonly stageAi: StageAiService) {}

  async create(userId: string, projectId: string, fromKey: string, raw: unknown) {
    const ctx = await this.core.load(userId, projectId, 'write', fromKey);
    if (!editableProject(ctx.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const targetKey = typeof input.targetStageKey === 'string' ? input.targetStageKey : '';
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const kind = input.kind === 'question' ? 'question' : 'change';
    const blocking = input.blocking === true;
    if (text.length < 10 || text.length > 1000) throw new BadRequestException('PROPOSAL_TEXT_INVALID');
    // To an earlier stage the viewer can see: any stage this one is built on for the team; for a specialist, the inputs
    // of their stage and the results the owner opened to them.
    const assignment = this.core.assignmentFor(ctx, fromKey);
    const visible = ctx.viewer.kind === 'specialist'
      ? [...routeInputs(ctx.route, fromKey as StageKey), ...(assignment?.scope.extraReadStages ?? [])]
      : routeAncestors(ctx.route, fromKey as StageKey);
    if (!visible.includes(targetKey as StageKey)) throw new BadRequestException('PROPOSAL_TARGET_INVALID');
    const target = this.core.stageOf(ctx, targetKey);
    if (target.status === 'locked') throw new ConflictException('PROPOSAL_TARGET_LOCKED');
    const open = await this.prisma.changeProposal.count({ where: { projectId, authorUserId: userId, status: { in: [...UNSETTLED] } } });
    if (open >= OPEN_PER_AUTHOR) throw new ConflictException('PROPOSAL_LIMIT');
    const from = this.core.stageOf(ctx, fromKey);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.changeProposal.create({ data: { projectId, fromStageId: from.id, targetStageId: target.id, authorUserId: userId, text, kind, blocking }, select: { id: true, createdAt: true } });
      await this.core.event(tx, projectId, userId, kind === 'question' ? 'stage_question_asked' : 'change_proposed', targetKey, { proposalId: row.id, fromStageKey: fromKey, blocking });
      return row;
    });
    // Those who can settle it: the owner and managers, and the specialist working on the earlier stage.
    const deciders = await this.prisma.projectMember.findMany({ where: { projectId, status: 'active', role: { in: [...acceptRoles] as never } }, select: { userId: true } });
    const workers = await this.prisma.stageAssignment.findMany({ where: { projectId, stageId: target.id, status: 'active' }, select: { userId: true } });
    const fromTitle = stageDefinitions[fromKey as StageKey].title;
    const targetTitle = stageDefinitions[targetKey as StageKey].title;
    for (const recipient of new Set([...deciders, ...workers].map((item) => item.userId).filter((id): id is string => Boolean(id) && id !== userId))) {
      void this.core.notifyUser(recipient, () => tr(kind === 'question'
        ? '{4}Вопрос к этапу «{1}» от этапа «{0}»: {2}\n{3}'
        : '{4}Этап «{0}» просит изменить «{1}»: {2}\n{3}', [tr(fromTitle), tr(targetTitle), text, this.core.stageLink(projectId, targetKey), blocking ? tr('Блокер. ') : ''])).catch(() => undefined);
    }
    return { data: { id: created.id, status: 'open', kind, blocking, createdAt: created.createdAt } };
  }

  /**
   * Owners and managers see every request; everyone sees their own; a specialist also sees the requests to the stages they
   * work on, to answer them.
   */
  async list(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const deciding = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const myStages = ctx.viewer.kind === 'specialist' ? ctx.viewer.assignments.filter((item) => item.status === 'active').map((item) => item.stageKey) : [];
    const myStageIds = ctx.stages.filter((stage) => myStages.includes(stage.stageKey)).map((stage) => stage.id);
    const rows = await this.prisma.changeProposal.findMany({
      where: { projectId, ...(deciding ? {} : { OR: [{ authorUserId: userId }, { targetStageId: { in: myStageIds } }] }) }, orderBy: { createdAt: 'desc' }, take: 100,
      select: {
        id: true, text: true, kind: true, blocking: true, answer: true, status: true, decisionNote: true, decidedAt: true, createdAt: true, authorUserId: true,
        fromStage: { select: { stageKey: true } }, targetStage: { select: { id: true, stageKey: true, status: true } },
        author: { select: { name: true, email: true } },
      },
    });
    const title = (key: string) => stageDefinitions[key as StageKey]?.title ?? key;
    return {
      data: {
        canDecide: deciding,
        proposals: rows.map((row) => ({
          id: row.id, text: row.text, kind: row.kind, blocking: row.blocking, answer: row.answer, status: row.status, decisionNote: row.decisionNote, decidedAt: row.decidedAt, createdAt: row.createdAt,
          fromStageKey: row.fromStage.stageKey, fromTitle: title(row.fromStage.stageKey),
          targetStageKey: row.targetStage.stageKey, targetTitle: title(row.targetStage.stageKey),
          author: deciding || row.authorUserId === userId ? (row.authorUserId === userId ? tr('Вы') : row.author.name || row.author.email) : tr('Участник проекта'),
          mine: row.authorUserId === userId,
          // The specialist of the earlier stage answers questions; taking on a change is the owner's or a manager's.
          canAnswer: row.status === 'open' && (deciding || myStageIds.includes(row.targetStage.id)),
          canDecide: row.status === 'open' && deciding,
        })),
      },
    };
  }

  /**
   * accept: the earlier stage is reopened (if it was accepted) and, with applyWithAi, the AI drafts the change; the request is
   * resolved when that stage is accepted again. answer: a reply that settles a question (or a change the answer makes
   * unnecessary). reject: closed with a note. The author is told each time.
   */
  async decide(userId: string, projectId: string, proposalId: string, raw: unknown) {
    if (!isUuid(proposalId)) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const decision = input.decision;
    if (decision !== 'accept' && decision !== 'reject' && decision !== 'answer') throw new BadRequestException('PROPOSAL_DECISION_INVALID');
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    if (decision === 'answer' ? !note || note.length < 2 || note.length > 1000 : note !== null && note.length > 500) throw new BadRequestException(decision === 'answer' ? 'ANSWER_INVALID' : 'PROPOSAL_NOTE_TOO_LONG');
    const proposal = await this.prisma.changeProposal.findFirst({ where: { id: proposalId, projectId }, select: { id: true, status: true, text: true, kind: true, authorUserId: true, targetStage: { select: { stageKey: true } }, fromStage: { select: { stageKey: true } } } });
    if (!proposal) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const targetKey = proposal.targetStage.stageKey;
    // Answering needs write access to the earlier stage (its specialist may answer); deciding a change needs acceptance.
    const ctx = await this.core.load(userId, projectId, decision === 'answer' ? 'write' : 'accept', targetKey);
    if (proposal.status !== 'open') throw new ConflictException('PROPOSAL_ALREADY_DECIDED');

    const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'answered';
    // Decide first, atomically: two people pressing at once must not both reopen and draft.
    const decided = await this.prisma.changeProposal.updateMany({
      where: { id: proposal.id, status: 'open' },
      data: { status, decidedByUserId: userId, decidedAt: new Date(), ...(decision === 'answer' ? { answer: note } : { decisionNote: note }) },
    });
    if (decided.count !== 1) throw new ConflictException('PROPOSAL_ALREADY_DECIDED');
    await this.core.event(this.prisma, projectId, userId, decision === 'accept' ? 'change_proposal_accepted' : decision === 'reject' ? 'change_proposal_rejected' : 'stage_question_answered', targetKey, { proposalId: proposal.id, note });

    let generation: { ok: boolean; code: string | null } | null = null;
    if (decision === 'accept') {
      const stage = this.core.stageOf(ctx, targetKey);
      if (stage.status === 'approved' || stage.status === 'imported') await this.journey.reopen(userId, projectId, targetKey);
      if (input.applyWithAi === true) {
        try {
          await this.stageAi.generate(userId, projectId, targetKey, { instruction: tr('Запрос от этапа «{0}», принятый владельцем: {1}', [tr(stageDefinitions[proposal.fromStage.stageKey as StageKey]?.title ?? ''), proposal.text]), saveAs: 'one_off', targetKey: null });
          generation = { ok: true, code: null };
        } catch (caught) {
          // The decision stands; the owner applies the change by hand or asks the AI again from the stage page.
          generation = { ok: false, code: caught instanceof Error ? caught.message : 'AI_FAILED' };
        }
      }
    }
    const title = tr(stageDefinitions[targetKey as StageKey].title);
    if (proposal.authorUserId !== userId) void this.core.notifyUser(proposal.authorUserId, () => decision === 'accept'
      ? tr('Ваш запрос к этапу «{0}» принят: этап исправят и примут заново — тогда запрос закроется сам.{1}', [title, note ? ` ${note}` : ''])
      : decision === 'answer' ? tr('Ответ на ваш запрос к этапу «{0}»: {1}', [title, note])
      : tr('Ваш запрос к этапу «{0}» отклонён.{1}', [title, note ? ` ${note}` : ''])).catch(() => undefined);
    return { data: { id: proposal.id, status, targetStageKey: targetKey, generation } };
  }

  async withdraw(userId: string, projectId: string, proposalId: string) {
    if (!isUuid(proposalId)) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    const updated = await this.prisma.changeProposal.updateMany({ where: { id: proposalId, projectId, authorUserId: userId, status: 'open' }, data: { status: 'withdrawn', decidedAt: new Date() } });
    if (updated.count !== 1) throw new NotFoundException('PROPOSAL_NOT_FOUND');
    await this.core.event(this.prisma, projectId, userId, 'change_proposal_withdrawn', null, { proposalId });
    return { data: { id: proposalId, status: 'withdrawn' } };
  }
}
