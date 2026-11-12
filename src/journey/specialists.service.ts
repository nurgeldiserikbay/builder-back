import { tr } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { emailConfig, sendEmail } from '../notifications/email.js';
import { escapeHtml } from './site-renderer.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { BillingService } from '../billing/billing.service.js';
import { reviewState } from '../catalog/catalog-rules.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const manageRoles = new Set(['owner', 'manager']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Plain-language access summary shown to the owner before inviting and to the specialist before accepting. */
export const roleAccess = {
  lead: {
    title: 'Ведущий этапа',
    explanation: 'Направляет ИИ на этом этапе: даёт инструкции, правит результат и отправляет его вам на приёмку. Принимаете этап вы.',
    can: ['Видеть принятые результаты этапов, от которых зависит этот этап', 'Давать инструкции ИИ и править результат этого этапа', 'Отправлять результат вам на приёмку'],
    forSpecialist: {
      explanation: 'Вы направляете ИИ на этом этапе: даёте инструкции, правите результат и отправляете его владельцу на приёмку. Принимает этап владелец.',
      can: ['Видеть принятые результаты этапов, от которых зависит этот этап', 'Давать инструкции ИИ и править результат этого этапа', 'Отправлять результат владельцу на приёмку'],
    },
  },
  consultant: {
    title: 'Консультант',
    explanation: 'Смотрит этап и предлагает правки. Ведущий или вы решаете, отправить ли предложение ИИ.',
    can: ['Видеть этот этап и результаты, от которых он зависит', 'Предлагать правки для ИИ'],
    forSpecialist: {
      explanation: 'Вы смотрите этап и предлагаете правки. Ведущий этапа или владелец решает, отправить ли предложение ИИ.',
      can: ['Видеть этот этап и результаты, от которых он зависит', 'Предлагать правки для ИИ'],
    },
  },
  cannot: ['Видеть другие этапы проекта', 'Публиковать сайт, видеть заявки и настройки проекта', 'Скачивать результат проекта', 'Приглашать других людей'],
  afterAcceptance: 'После того как вы примете этап, специалист больше не сможет его менять; смотреть сможет ещё 7 дней.',
  afterAcceptanceForSpecialist: 'Когда владелец примет этап, менять его будет нельзя; смотреть можно ещё 7 дней.',
} as const;

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

export type SpecialistTerms = {
  payKind: 'none' | 'fixed' | 'hourly'; fixedAmount: number | null; hourlyRate: number | null;
  hourLimit: number | null; weeklyHourLimit: number | null; revisionsIncluded: number | null; onlyResultTime: boolean;
};
const termsSelect = { payKind: true, fixedAmountTiyn: true, hourlyRateTiyn: true, hourLimit: true, weeklyHourLimit: true, revisionsIncluded: true, onlyResultTime: true } as const;
type TermsRow = { payKind: string; fixedAmountTiyn: number | null; hourlyRateTiyn: number | null; hourLimit: number | null; weeklyHourLimit: number | null; revisionsIncluded: number | null; onlyResultTime: boolean };

function termsData(terms: SpecialistTerms) {
  return {
    payKind: terms.payKind,
    fixedAmountTiyn: terms.payKind === 'fixed' && terms.fixedAmount !== null ? Math.round(terms.fixedAmount * 100) : null,
    hourlyRateTiyn: terms.payKind === 'hourly' && terms.hourlyRate !== null ? Math.round(terms.hourlyRate * 100) : null,
    hourLimit: terms.payKind === 'hourly' ? terms.hourLimit : null,
    weeklyHourLimit: terms.payKind === 'hourly' ? terms.weeklyHourLimit : null,
    revisionsIncluded: terms.payKind === 'fixed' ? terms.revisionsIncluded : null,
    onlyResultTime: terms.payKind === 'hourly' ? terms.onlyResultTime : false,
  };
}
function termsView(row: TermsRow): SpecialistTerms {
  return {
    payKind: (['fixed', 'hourly'].includes(row.payKind) ? row.payKind : 'none') as SpecialistTerms['payKind'],
    fixedAmount: row.fixedAmountTiyn === null ? null : row.fixedAmountTiyn / 100, hourlyRate: row.hourlyRateTiyn === null ? null : row.hourlyRateTiyn / 100,
    hourLimit: row.hourLimit, weeklyHourLimit: row.weeklyHourLimit, revisionsIncluded: row.revisionsIncluded, onlyResultTime: row.onlyResultTime,
  };
}
const money = (value: number) => `${value.toLocaleString('ru-RU')} ₸`;
/** One plain sentence for the invite page, the e-mail and the list of specialists. */
export function termsText(terms: SpecialistTerms): string {
  if (terms.payKind === 'fixed') {
    return tr("Фиксированная цена за этап: {0}. Оплата после того, как владелец примет результат{1}.", [money(terms.fixedAmount ?? 0), terms.revisionsIncluded !== null ? tr("; в цену входит правок: {0}", [terms.revisionsIncluded]) : '']);
  }
  if (terms.payKind === 'hourly') {
    const parts = [tr("Почасовая ставка: {0} в час, не больше {1} ч на этап", [money(terms.hourlyRate ?? 0), terms.hourLimit])];
    if (terms.weeklyHourLimit) parts.push(tr("до {0} ч в неделю", [terms.weeklyHourLimit]));
    parts.push(terms.onlyResultTime ? 'оплачивается только время, в которое были действия на этапе' : 'оплачивается подтверждённое время');
    return tr("{0}. Платформа считает время, пока вы работаете на этапе; оплата после того, как владелец примет результат.", [parts.join(', ')]);
  }
  return 'Без оплаты через платформу: условия вы обсуждаете с владельцем сами.';
}
const TIME_RULES = [
  'Время считается, пока страница этапа открыта и вы что-то делаете. Через 5 минут без действий учёт останавливается.',
  'Владелец видит табель: когда вы работали и были ли в это время действия на этапе (черновики, запросы к ИИ, отправка на проверку).',
  'Если вы работали вне платформы, можно добавить время вручную с пояснением — владелец его подтвердит или оспорит.',
  'Записи, которые владелец не оспорил за 3 дня, считаются подтверждёнными.',
  'Когда лимит часов закончится, учёт остановится, пока владелец его не увеличит.',
];

@Injectable()
export class SpecialistsService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService) {}

  private async manager(userId: string, projectId: string, stageKey?: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: {
        id: true, name: true, status: true,
        members: { where: { userId, status: 'active' }, select: { role: true } },
        owner: { select: { name: true, email: true } },
        stages: { select: { id: true, stageKey: true, status: true } },
      },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (!manageRoles.has(project.members[0]?.role ?? '')) throw new ForbiddenException('SPECIALISTS_FORBIDDEN');
    const stage = stageKey ? project.stages.find((item) => item.stageKey === stageKey) : undefined;
    if (stageKey && !stage) throw new NotFoundException('STAGE_NOT_FOUND');
    return { project, stage };
  }

  async list(userId: string, projectId: string, stageKey: string) {
    const { stage } = await this.manager(userId, projectId, stageKey);
    const rows = await this.prisma.stageAssignment.findMany({
      where: { stageId: stage!.id, status: { not: 'revoked' } }, orderBy: { createdAt: 'desc' },
      select: { id: true, userId: true, email: true, role: true, status: true, aiBudget: true, aiUsed: true, inviteExpiresAt: true, acceptedAt: true, completedAt: true, readUntil: true, user: { select: { name: true, specialistProfile: { select: { id: true, displayName: true, published: true } } } }, review: { select: { rating: true, text: true, reply: true, createdAt: true, authorUserId: true, hiddenAt: true, moderationNote: true } }, ...termsSelect },
    });
    return {
      data: {
        assignments: rows.map(({ user, review, userId: specialistId, payKind, fixedAmountTiyn, hourlyRateTiyn, hourLimit, weeklyHourLimit, revisionsIncluded, onlyResultTime, ...row }) => {
          const terms = termsView({ payKind, fixedAmountTiyn, hourlyRateTiyn, hourLimit, weeklyHourLimit, revisionsIncluded, onlyResultTime });
          const profile = user?.specialistProfile?.published ? user.specialistProfile : null;
          return {
            ...row, name: profile?.displayName ?? user?.name ?? null, profileId: profile?.id ?? null, inviteExpired: row.status === 'invited' && row.inviteExpiresAt < new Date(), terms, termsText: termsText(terms),
            review: review ? { rating: review.rating, text: review.text, reply: review.reply, hidden: Boolean(review.hiddenAt), moderationNote: review.hiddenAt ? review.moderationNote : null } : null,
            canReview: !review?.hiddenAt && reviewState({ status: row.status, userId: specialistId }, review, userId).allowed,
          };
        }),
        roles: roleAccess,
      },
    };
  }

  async invite(userId: string, projectId: string, stageKey: string, input: { email: string; role: 'lead' | 'consultant'; aiBudget: number | null; terms: SpecialistTerms }) {
    const { project, stage } = await this.manager(userId, projectId, stageKey);
    if (!['active', 'live'].includes(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    if (stage!.status === 'approved' || stage!.status === 'imported') throw new ConflictException('STAGE_ACCEPTED_REOPEN_FIRST');
    await this.billing.assertCanInviteSpecialists(projectId);
    const email = input.email.trim().toLowerCase();
    if (email === project.owner.email.trim().toLowerCase()) throw new BadRequestException('CANNOT_INVITE_OWNER');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, status: 'active', user: { emailNormalized: email } }, select: { id: true } });
    if (member) throw new ConflictException('ALREADY_PROJECT_MEMBER');
    const open = await this.prisma.stageAssignment.findMany({ where: { stageId: stage!.id, status: { in: ['invited', 'active'] } }, select: { email: true, role: true } });
    if (open.some((item) => item.email === email)) throw new ConflictException('ALREADY_INVITED');
    if (input.role === 'lead' && open.some((item) => item.role === 'lead')) throw new ConflictException('LEAD_ALREADY_ASSIGNED');
    const token = randomBytes(24).toString('base64url');
    const assignment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stageAssignment.create({
        data: { projectId, stageId: stage!.id, email, role: input.role, inviteTokenHash: digest(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), aiBudget: input.aiBudget, invitedByUserId: userId, ...termsData(input.terms) },
        select: { id: true, email: true, role: true, status: true, aiBudget: true, inviteExpiresAt: true },
      });
      if (input.role === 'lead' && stage!.status === 'ready') await tx.projectStage.update({ where: { id: stage!.id }, data: { status: 'awaiting_lead' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'specialist_invited', stageKey, details: { assignmentId: created.id, role: input.role, aiBudget: input.aiBudget, payKind: input.terms.payKind } } });
      return created;
    });
    const appUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';
    const inviteUrl = new URL(`/invite/${token}`, appUrl).toString();
    const mail = emailConfig();
    const stageTitle = stageDefinitions[stageKey as StageKey].title;
    const inviter = project.owner.name ?? project.owner.email;
    const emailSent = mail ? await sendEmail(mail, email, tr("Приглашение в проект «{0}»", [project.name]),
      tr("<p>{0} приглашает вас в проект «{1}» на этап «{2}» как {3}.</p><p>{4}</p><p><a href=\"{5}\">Открыть приглашение</a></p><p>Ссылка действует 7 дней.</p>", [escapeHtml(inviter), escapeHtml(project.name), escapeHtml(stageTitle), escapeHtml(roleAccess[input.role].title.toLowerCase()), escapeHtml(termsText(input.terms)), escapeHtml(inviteUrl)])) : false;
    return { data: { assignment, inviteUrl, emailSent } };
  }

  async revoke(userId: string, projectId: string, assignmentId: string) {
    await this.manager(userId, projectId);
    if (!isUuid(assignmentId)) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const assignment = await this.prisma.stageAssignment.findFirst({ where: { id: assignmentId, projectId, status: { not: 'revoked' } }, select: { id: true, role: true, stageId: true, stage: { select: { status: true, stageKey: true } } } });
    if (!assignment) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      await tx.stageAssignment.update({ where: { id: assignment.id }, data: { status: 'revoked', revokedAt: new Date(), readUntil: null } });
      if (assignment.role === 'lead' && assignment.stage.status === 'awaiting_lead') await tx.projectStage.update({ where: { id: assignment.stageId }, data: { status: 'ready' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'specialist_revoked', stageKey: assignment.stage.stageKey, details: { assignmentId } } });
    });
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('INVITE_NOT_FOUND');
    const assignment = await this.prisma.stageAssignment.findUnique({
      where: { inviteTokenHash: digest(token) },
      select: {
        id: true, email: true, role: true, status: true, aiBudget: true, inviteExpiresAt: true, userId: true, projectId: true, stageId: true, ...termsSelect,
        stage: { select: { stageKey: true, status: true } },
        project: { select: { name: true, owner: { select: { name: true, email: true } } } },
      },
    });
    if (!assignment) throw new NotFoundException('INVITE_NOT_FOUND');
    return assignment;
  }

  async inviteInfo(token: string) {
    const invite = await this.byToken(token);
    const definition = stageDefinitions[invite.stage.stageKey as StageKey];
    return {
      data: {
        projectName: invite.project.name, invitedBy: invite.project.owner.name ?? maskEmail(invite.project.owner.email),
        stageKey: invite.stage.stageKey, stageTitle: definition.title, stagePurpose: definition.purpose,
        role: invite.role, roleTitle: roleAccess[invite.role].title, roleExplanation: roleAccess[invite.role].forSpecialist.explanation,
        can: roleAccess[invite.role].forSpecialist.can, cannot: roleAccess.cannot, afterAcceptance: roleAccess.afterAcceptanceForSpecialist,
        aiBudget: invite.aiBudget, email: maskEmail(invite.email), status: invite.status,
        terms: termsView(invite), termsText: termsText(termsView(invite)), timeRules: TIME_RULES,
        expired: invite.status === 'invited' && invite.inviteExpiresAt < new Date(), projectId: invite.status === 'active' ? invite.projectId : null,
      },
    };
  }

  async accept(userId: string, userEmail: string, token: string) {
    const invite = await this.byToken(token);
    if (invite.status === 'active' && invite.userId === userId) return { data: { projectId: invite.projectId, stageKey: invite.stage.stageKey } };
    if (invite.status !== 'invited') throw new GoneException('INVITE_NOT_AVAILABLE');
    if (invite.inviteExpiresAt < new Date()) throw new GoneException('INVITE_EXPIRED');
    // The invitation is bound to the address it was sent to, so a forwarded link cannot be used by someone else.
    if (userEmail.trim().toLowerCase() !== invite.email) throw new ForbiddenException('INVITE_EMAIL_MISMATCH');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId: invite.projectId, userId, status: 'active' }, select: { id: true } });
    if (member) throw new ConflictException('ALREADY_PROJECT_MEMBER');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.stageAssignment.updateMany({ where: { id: invite.id, status: 'invited' }, data: { status: 'active', userId, acceptedAt: new Date() } });
      if (updated.count !== 1) throw new GoneException('INVITE_NOT_AVAILABLE');
      if (invite.role === 'lead' && invite.stage.status === 'awaiting_lead') await tx.projectStage.update({ where: { id: invite.stageId }, data: { status: 'ready' } });
      await tx.projectEvent.create({ data: { projectId: invite.projectId, actorUserId: userId, type: 'specialist_joined', stageKey: invite.stage.stageKey, details: { assignmentId: invite.id, role: invite.role } } });
    });
    return { data: { projectId: invite.projectId, stageKey: invite.stage.stageKey } };
  }

  async mine(userId: string) {
    const rows = await this.prisma.stageAssignment.findMany({
      where: { userId, OR: [{ status: 'active' }, { status: 'completed', readUntil: { gt: new Date() } }] }, orderBy: { updatedAt: 'desc' }, take: 100,
      select: { id: true, role: true, status: true, aiBudget: true, aiUsed: true, readUntil: true, projectId: true, project: { select: { name: true } }, stage: { select: { stageKey: true, status: true } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, projectId: row.projectId, projectName: row.project.name, stageKey: row.stage.stageKey, stageTitle: stageDefinitions[row.stage.stageKey as StageKey]?.title ?? row.stage.stageKey,
        stageStatus: row.stage.status, role: row.role, roleTitle: roleAccess[row.role].title, status: row.status, aiBudget: row.aiBudget, aiUsed: row.aiUsed, readUntil: row.readUntil,
      })),
    };
  }
}
