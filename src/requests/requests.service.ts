import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { roleAccess } from '../journey/specialists.service.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { tr } from '../i18n/i18n.js';
import {
  MAX_OPEN_REQUESTS_PER_PROJECT, REQUEST_OPEN_DAYS, cannotRespond, isOpen, parseRequest, parseResponse, payKindAllowed, responseTotalTiyn,
} from './request-rules.js';

const MANAGERS = new Set(['owner', 'manager']);
const tenge = (tiyn: number | null) => (tiyn === null ? null : tiyn / 100);
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const stageTitle = (key: string) => stageDefinitions[key as StageKey]?.title ?? key;

type ResponseRow = {
  id: string; specialistUserId: string; message: string; payKind: string; fixedAmountTiyn: number | null; hourlyRateTiyn: number | null; hourLimit: number | null;
  days: number; status: string; createdAt: Date;
};
const responseSelect = { id: true, specialistUserId: true, message: true, payKind: true, fixedAmountTiyn: true, hourlyRateTiyn: true, hourLimit: true, days: true, status: true, createdAt: true } as const;
const termsOf = (row: ResponseRow) => ({ payKind: row.payKind, fixedAmount: tenge(row.fixedAmountTiyn), hourlyRate: tenge(row.hourlyRateTiyn), hourLimit: row.hourLimit, total: tenge(responseTotalTiyn({ payKind: row.payKind as 'fixed' | 'hourly', fixedAmountTiyn: row.fixedAmountTiyn, hourlyRateTiyn: row.hourlyRateTiyn, hourLimit: row.hourLimit })) });

/**
 * «Заявки на этап» (STAGE_WORK_MODEL, specialists). The owner or a manager describes the work on a stage; specialists
 * with a published catalog card respond with their terms; choosing a response makes that specialist an active
 * assignment on the stage with exactly those terms. The project's name and data are not shown on the board: only the
 * project type, the stage and what the owner wrote.
 */
@Injectable()
export class RequestsService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly core: JourneyCore) {}

  private async managed(userId: string, projectId: string, stageKey?: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: { id: true, name: true, status: true, projectType: true, members: { where: { userId, status: 'active' }, select: { role: true } }, stages: { select: { id: true, stageKey: true, status: true } } },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (!MANAGERS.has(project.members[0]?.role ?? '')) throw new ForbiddenException('REQUESTS_FORBIDDEN');
    const stage = stageKey ? project.stages.find((item) => item.stageKey === stageKey) : undefined;
    if (stageKey && !stage) throw new NotFoundException('STAGE_NOT_FOUND');
    return { project, stage };
  }

  /** Owner or manager publishes a request for a stage. */
  async create(userId: string, projectId: string, stageKey: string, raw: unknown) {
    const input = parseRequest(raw);
    const { project, stage } = await this.managed(userId, projectId, stageKey);
    if (!['active', 'live'].includes(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    if (['approved', 'imported', 'skipped'].includes(stage!.status)) throw new ConflictException('STAGE_ACCEPTED_REOPEN_FIRST');
    await this.billing.assertCanInviteSpecialists(projectId);
    if (input.role === 'lead' && await this.prisma.stageAssignment.count({ where: { stageId: stage!.id, role: 'lead', status: { in: ['invited', 'active'] } } })) throw new ConflictException('LEAD_ALREADY_ASSIGNED');
    const openHere = await this.prisma.stageRequest.findMany({ where: { projectId, status: 'open', closesAt: { gt: new Date() } }, select: { stageId: true, role: true } });
    if (openHere.some((item) => item.stageId === stage!.id && item.role === input.role)) throw new ConflictException('REQUEST_ALREADY_OPEN');
    if (openHere.length >= MAX_OPEN_REQUESTS_PER_PROJECT) throw new ConflictException('TOO_MANY_OPEN_REQUESTS');
    const created = await this.prisma.$transaction(async (tx) => {
      // An expired open request of the same stage and role is closed so the unique «one open» index lets the new one in.
      await tx.stageRequest.updateMany({ where: { stageId: stage!.id, role: input.role, status: 'open', closesAt: { lte: new Date() } }, data: { status: 'cancelled' } });
      const row = await tx.stageRequest.create({
        data: { projectId, stageId: stage!.id, createdByUserId: userId, role: input.role, description: input.description, payKind: input.payKind, budgetTiyn: input.budgetTiyn, days: input.days, closesAt: new Date(Date.now() + REQUEST_OPEN_DAYS * 86_400_000) },
        select: { id: true },
      });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'stage_request_created', stageKey, details: { requestId: row.id, role: input.role } } });
      return row;
    });
    return this.forStage(userId, projectId, stageKey, created.id);
  }

  /** Requests of a stage with their responses and the responders' catalog cards — for the owner and managers. */
  async forStage(userId: string, projectId: string, stageKey: string, createdId?: string) {
    const { stage } = await this.managed(userId, projectId, stageKey);
    const requests = await this.prisma.stageRequest.findMany({
      where: { stageId: stage!.id }, orderBy: { createdAt: 'desc' }, take: 10,
      select: { id: true, role: true, description: true, payKind: true, budgetTiyn: true, days: true, status: true, closesAt: true, createdAt: true, chosenResponseId: true, responses: { orderBy: { createdAt: 'asc' }, select: responseSelect } },
    });
    const people = await this.cards(requests.flatMap((request) => request.responses.map((response) => response.specialistUserId)));
    const now = new Date();
    return {
      data: {
        createdId: createdId ?? null,
        requests: requests.map((request) => ({
          id: request.id, role: request.role, roleTitle: roleAccess[request.role].title, description: request.description, payKind: request.payKind, budget: tenge(request.budgetTiyn), days: request.days,
          status: isOpen(request, now) ? 'open' : request.status === 'open' ? 'expired' : request.status, closesAt: request.closesAt, createdAt: request.createdAt,
          responses: request.responses.filter((response) => response.status !== 'withdrawn').map((response) => ({
            id: response.id, message: response.message, days: response.days, status: response.status, createdAt: response.createdAt, terms: termsOf(response),
            overBudget: request.budgetTiyn !== null && responseTotalTiyn({ payKind: response.payKind as 'fixed' | 'hourly', fixedAmountTiyn: response.fixedAmountTiyn, hourlyRateTiyn: response.hourlyRateTiyn, hourLimit: response.hourLimit }) > request.budgetTiyn,
            specialist: people.get(response.specialistUserId) ?? null,
          })),
        })),
      },
    };
  }

  /** The owner closes a request without choosing anyone; responders are told. */
  async cancel(userId: string, projectId: string, requestId: string) {
    const request = await this.requestOf(userId, projectId, requestId);
    const updated = await this.prisma.stageRequest.updateMany({ where: { id: request.id, status: 'open' }, data: { status: 'cancelled' } });
    if (updated.count !== 1) throw new ConflictException('REQUEST_CLOSED');
    await this.prisma.stageRequestResponse.updateMany({ where: { requestId: request.id, status: 'sent' }, data: { status: 'declined' } });
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'stage_request_cancelled', stageKey: request.stage.stageKey, details: { requestId } } });
    for (const response of request.responses.filter((item) => item.status === 'sent')) {
      await this.core.notifyUser(response.specialistUserId, () => tr("Заявку на этап «{0}» закрыли без выбора исполнителя. Спасибо за отклик.", [tr(stageTitle(request.stage.stageKey))]), 'team').catch(() => undefined);
    }
    return this.forStage(userId, projectId, request.stage.stageKey);
  }

  /**
   * The owner chooses a response: the specialist joins the stage at once with the terms they offered (they agreed to
   * them by responding), the request is filled and the other responders are told.
   */
  async choose(userId: string, projectId: string, requestId: string, responseId: string) {
    const request = await this.requestOf(userId, projectId, requestId);
    if (!isOpen(request)) throw new ConflictException('REQUEST_CLOSED');
    const response = request.responses.find((item) => item.id === responseId && item.status === 'sent');
    if (!response) throw new NotFoundException('RESPONSE_NOT_FOUND');
    await this.billing.assertCanInviteSpecialists(projectId);
    const user = await this.prisma.user.findUnique({ where: { id: response.specialistUserId }, select: { email: true, deletionRequestedAt: true } });
    if (!user || user.deletionRequestedAt) throw new ConflictException('SPECIALIST_UNAVAILABLE');
    if (await this.prisma.projectMember.count({ where: { projectId, userId: response.specialistUserId, status: 'active' } })) throw new ConflictException('ALREADY_PROJECT_MEMBER');
    const open = await this.prisma.stageAssignment.findMany({ where: { stageId: request.stageId, status: { in: ['invited', 'active'] } }, select: { userId: true, email: true, role: true } });
    if (open.some((item) => item.userId === response.specialistUserId || item.email === user.email.toLowerCase())) throw new ConflictException('ALREADY_INVITED');
    if (request.role === 'lead' && open.some((item) => item.role === 'lead')) throw new ConflictException('LEAD_ALREADY_ASSIGNED');
    const now = new Date();
    const assignment = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stageRequest.updateMany({ where: { id: request.id, status: 'open' }, data: { status: 'filled', chosenResponseId: response.id } });
      if (claimed.count !== 1) throw new ConflictException('REQUEST_CLOSED');
      const created = await tx.stageAssignment.create({
        data: {
          projectId, stageId: request.stageId, userId: response.specialistUserId, email: user.email.toLowerCase(), role: request.role, status: 'active', acceptedAt: now,
          // No link is sent: the specialist joined by responding. The token is random and never shown.
          inviteTokenHash: createHash('sha256').update(randomBytes(24)).digest('hex'), inviteExpiresAt: now, invitedByUserId: userId,
          payKind: response.payKind, fixedAmountTiyn: response.fixedAmountTiyn, hourlyRateTiyn: response.hourlyRateTiyn, hourLimit: response.hourLimit,
        },
        select: { id: true },
      });
      await tx.stageRequestResponse.update({ where: { id: response.id }, data: { status: 'chosen', assignmentId: created.id } });
      await tx.stageRequestResponse.updateMany({ where: { requestId: request.id, status: 'sent', id: { not: response.id } }, data: { status: 'declined' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'stage_request_filled', stageKey: request.stage.stageKey, details: { requestId, assignmentId: created.id, role: request.role } } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: response.specialistUserId, type: 'specialist_joined', stageKey: request.stage.stageKey, details: { assignmentId: created.id, role: request.role } } });
      return created;
    });
    const title = stageTitle(request.stage.stageKey);
    await this.core.notifyUser(response.specialistUserId, () => tr("Вас выбрали исполнителем этапа «{0}» в проекте «{1}». Этап уже открыт: {2}", [tr(title), request.project.name, this.core.stageLink(projectId, request.stage.stageKey)]).trim(), 'team').catch(() => undefined);
    for (const other of request.responses.filter((item) => item.status === 'sent' && item.id !== response.id)) {
      await this.core.notifyUser(other.specialistUserId, () => tr("По заявке на этап «{0}» владелец выбрал другого специалиста. Спасибо за отклик.", [tr(title)]), 'team').catch(() => undefined);
    }
    return { data: { assignmentId: assignment.id, ...(await this.forStage(userId, projectId, request.stage.stageKey)).data } };
  }

  /** The owner turns down one response; the request stays open. */
  async decline(userId: string, projectId: string, requestId: string, responseId: string) {
    const request = await this.requestOf(userId, projectId, requestId);
    const updated = await this.prisma.stageRequestResponse.updateMany({ where: { id: responseId, requestId: request.id, status: 'sent' }, data: { status: 'declined' } });
    if (updated.count !== 1) throw new NotFoundException('RESPONSE_NOT_FOUND');
    const response = request.responses.find((item) => item.id === responseId);
    if (response) await this.core.notifyUser(response.specialistUserId, () => tr("Владелец отклонил ваш отклик на этап «{0}».", [tr(stageTitle(request.stage.stageKey))]), 'team').catch(() => undefined);
    return this.forStage(userId, projectId, request.stage.stageKey);
  }

  private async requestOf(userId: string, projectId: string, requestId: string) {
    await this.managed(userId, projectId);
    if (!isUuid(requestId)) throw new NotFoundException('REQUEST_NOT_FOUND');
    const request = await this.prisma.stageRequest.findFirst({
      where: { id: requestId, projectId },
      select: { id: true, stageId: true, role: true, status: true, closesAt: true, budgetTiyn: true, stage: { select: { stageKey: true } }, project: { select: { name: true } }, responses: { select: responseSelect } },
    });
    if (!request) throw new NotFoundException('REQUEST_NOT_FOUND');
    return request;
  }

  // ---------- The board, for specialists ----------

  /** Open requests across BuildPath, newest first; whether the caller can respond and their own response. */
  async board(userId: string, query: { stageKey?: string; mine?: boolean }) {
    if (query.stageKey !== undefined && !(query.stageKey in stageDefinitions)) throw new BadRequestException('INVALID_STAGE');
    const now = new Date();
    const [profile, rows] = await Promise.all([
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { published: true, blockedAt: true, stageKeys: true } }),
      this.prisma.stageRequest.findMany({
        where: { status: 'open', closesAt: { gt: now }, ...(query.stageKey ? { stage: { stageKey: query.stageKey } } : {}), project: { status: { in: ['active', 'live'] } } },
        orderBy: { createdAt: 'desc' }, take: 100,
        select: {
          id: true, projectId: true, createdByUserId: true, role: true, description: true, payKind: true, budgetTiyn: true, days: true, closesAt: true, createdAt: true,
          stage: { select: { id: true, stageKey: true } }, project: { select: { projectType: true } },
          responses: { where: { status: { not: 'withdrawn' } }, select: responseSelect },
        },
      }),
    ]);
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const [memberships, assignments] = await Promise.all([
      this.prisma.projectMember.findMany({ where: { userId, status: 'active', projectId: { in: projectIds } }, select: { projectId: true } }),
      this.prisma.stageAssignment.findMany({ where: { userId, status: { in: ['invited', 'active'] }, stageId: { in: rows.map((row) => row.stage.id) } }, select: { stageId: true } }),
    ]);
    const profileState = !profile ? 'none' : profile.blockedAt ? 'blocked' : profile.published ? 'published' : 'draft';
    const items = rows.map((row) => {
      const mine = row.responses.find((response) => response.specialistUserId === userId) ?? null;
      const reason = cannotRespond({
        profile: profileState, isAuthor: row.createdByUserId === userId,
        memberOfProject: memberships.some((item) => item.projectId === row.projectId), assignedToStage: assignments.some((item) => item.stageId === row.stage.id),
      });
      return {
        id: row.id, projectType: row.project.projectType, projectTypeTitle: projectTypeOf(row.project.projectType)?.title ?? null,
        stageKey: row.stage.stageKey, stageTitle: stageTitle(row.stage.stageKey), stagePurpose: stageDefinitions[row.stage.stageKey as StageKey]?.purpose ?? '',
        role: row.role, roleTitle: roleAccess[row.role].title, roleExplanation: roleAccess[row.role].forSpecialist.explanation, can: roleAccess[row.role].forSpecialist.can,
        description: row.description, payKind: row.payKind, budget: tenge(row.budgetTiyn), days: row.days, closesAt: row.closesAt, createdAt: row.createdAt,
        responses: row.responses.length, matchesProfile: Boolean(profile?.stageKeys.includes(row.stage.stageKey)),
        canRespond: reason === null, cannotRespond: reason,
        mine: mine ? { id: mine.id, status: mine.status, message: mine.message, days: mine.days, terms: termsOf(mine), createdAt: mine.createdAt } : null,
      };
    });
    return { data: { profile: profileState, requests: query.mine ? items.filter((item) => item.mine) : items } };
  }

  /** A specialist responds (or changes their response while the request is open). */
  async respond(userId: string, requestId: string, raw: unknown) {
    const input = parseResponse(raw);
    if (!isUuid(requestId)) throw new NotFoundException('REQUEST_NOT_FOUND');
    const request = await this.prisma.stageRequest.findUnique({
      where: { id: requestId },
      select: { id: true, projectId: true, createdByUserId: true, status: true, closesAt: true, payKind: true, stageId: true, stage: { select: { stageKey: true } }, project: { select: { status: true, name: true, members: { where: { status: 'active', role: { in: ['owner', 'manager'] } }, select: { userId: true } } } } },
    });
    if (!request || !['active', 'live'].includes(request.project.status)) throw new NotFoundException('REQUEST_NOT_FOUND');
    if (!isOpen(request)) throw new ConflictException('REQUEST_CLOSED');
    if (!payKindAllowed(request.payKind, input.payKind)) throw new BadRequestException('PAYKIND_NOT_ASKED');
    const [profile, member, assigned, existing] = await Promise.all([
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { published: true, blockedAt: true } }),
      this.prisma.projectMember.count({ where: { projectId: request.projectId, userId, status: 'active' } }),
      this.prisma.stageAssignment.count({ where: { stageId: request.stageId, userId, status: { in: ['invited', 'active'] } } }),
      this.prisma.stageRequestResponse.findUnique({ where: { requestId_specialistUserId: { requestId, specialistUserId: userId } }, select: { id: true, status: true } }),
    ]);
    const reason = cannotRespond({ profile: !profile ? 'none' : profile.blockedAt ? 'blocked' : profile.published ? 'published' : 'draft', isAuthor: request.createdByUserId === userId, memberOfProject: member > 0, assignedToStage: assigned > 0 });
    if (reason) throw new ForbiddenException(reason);
    if (existing && existing.status !== 'sent' && existing.status !== 'withdrawn') throw new ConflictException('RESPONSE_DECIDED');
    const data = { message: input.message, payKind: input.payKind, fixedAmountTiyn: input.fixedAmountTiyn, hourlyRateTiyn: input.hourlyRateTiyn, hourLimit: input.hourLimit, days: input.days, status: 'sent' };
    await this.prisma.stageRequestResponse.upsert({ where: { requestId_specialistUserId: { requestId, specialistUserId: userId } }, create: { requestId, specialistUserId: userId, ...data }, update: data });
    if (!existing || existing.status === 'withdrawn') {
      // The project log shows that a response came, never who sent it or the terms: those are on the stage for deciders.
      await this.prisma.projectEvent.create({ data: { projectId: request.projectId, type: 'stage_request_response', stageKey: request.stage.stageKey, details: { requestId } } });
      for (const manager of request.project.members) {
        await this.core.notifyUser(manager.userId, () => tr("Новый отклик на заявку по этапу «{0}» в проекте «{1}»: {2}", [tr(stageTitle(request.stage.stageKey)), request.project.name, this.core.stageLink(request.projectId, request.stage.stageKey)]).trim(), 'team').catch(() => undefined);
      }
    }
    return this.board(userId, { mine: true });
  }

  async withdraw(userId: string, requestId: string) {
    if (!isUuid(requestId)) throw new NotFoundException('REQUEST_NOT_FOUND');
    const updated = await this.prisma.stageRequestResponse.updateMany({ where: { requestId, specialistUserId: userId, status: 'sent' }, data: { status: 'withdrawn' } });
    if (updated.count !== 1) throw new NotFoundException('RESPONSE_NOT_FOUND');
    return this.board(userId, { mine: true });
  }

  /** The specialist's responses of the last 90 days, whatever happened to them — for «Моя работа». */
  async myResponses(userId: string) {
    const rows = await this.prisma.stageRequestResponse.findMany({
      where: { specialistUserId: userId, createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }, orderBy: { updatedAt: 'desc' }, take: 50,
      select: { ...responseSelect, request: { select: { id: true, status: true, closesAt: true, role: true, projectId: true, stage: { select: { stageKey: true } }, project: { select: { projectType: true } } } } },
    });
    const now = new Date();
    return {
      data: rows.map((row) => ({
        id: row.id, requestId: row.request.id, status: row.status,
        requestStatus: isOpen(row.request, now) ? 'open' : row.request.status === 'open' ? 'expired' : row.request.status,
        stageKey: row.request.stage.stageKey, stageTitle: stageTitle(row.request.stage.stageKey), projectTypeTitle: projectTypeOf(row.request.project.projectType)?.title ?? null,
        role: row.request.role, days: row.days, terms: termsOf(row), createdAt: row.createdAt,
        // Once chosen, the stage is theirs to open.
        projectId: row.status === 'chosen' ? row.request.projectId : null,
      })),
    };
  }

  /** Catalog cards of responders: name, headline, city, rating and how many stages they finished on BuildPath. */
  private async cards(userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Map();
    const [profiles, reviews, finished] = await Promise.all([
      this.prisma.specialistProfile.findMany({ where: { userId: { in: ids } }, select: { id: true, userId: true, displayName: true, headline: true, city: true, published: true, blockedAt: true } }),
      this.prisma.specialistReview.groupBy({ by: ['specialistUserId'], where: { specialistUserId: { in: ids }, reportStatus: { not: 'hidden' } }, _avg: { rating: true }, _count: { _all: true } }),
      this.prisma.stageAssignment.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'completed' }, _count: { _all: true } }),
    ]);
    return new Map(ids.map((id) => {
      const profile = profiles.find((item) => item.userId === id);
      const rating = reviews.find((item) => item.specialistUserId === id);
      return [id, {
        profileId: profile && profile.published && !profile.blockedAt ? profile.id : null, name: profile?.displayName ?? null, headline: profile?.headline ?? null, city: profile?.city ?? null,
        rating: rating?._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null, reviews: rating?._count._all ?? 0,
        finishedStages: finished.find((item) => item.userId === id)?._count._all ?? 0,
      }];
    }));
  }
}
