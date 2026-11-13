import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { catalogScore, catalogStageKeys, checkModeration, checkPortfolio, checkProfile, checkReport, checkReview, ratingSummary, reviewState, type PortfolioItem, type ProfileInput } from './catalog-rules.js';
import { tr } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const stageTitle = (key: string) => stageDefinitions[key as StageKey]?.title ?? key;
const tenge = (tiyn: number | null) => (tiyn === null ? null : tiyn / 100);
/** Visible in the catalog: published, and the account is not being deleted. */
const visible = { published: true, user: { deletionRequestedAt: null } };

/**
 * Specialist catalog. The catalog never shows an e-mail: an owner invites by profile and the address is taken on the
 * server. Reviews name neither the owner nor the project — only the stage and the kind of project.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  stages() {
    return catalogStageKeys.map((key) => ({ key, title: stageDefinitions[key].title }));
  }

  private async stats(userIds: string[]) {
    const [reviews, completed] = await Promise.all([
      this.prisma.specialistReview.groupBy({ by: ['specialistUserId'], where: { specialistUserId: { in: userIds }, hiddenAt: null }, _sum: { rating: true }, _count: { _all: true } }),
      this.prisma.stageAssignment.groupBy({ by: ['userId'], where: { userId: { in: userIds }, status: 'completed' }, _count: { _all: true } }),
    ]);
    return (userId: string) => {
      const r = reviews.find((row) => row.specialistUserId === userId);
      return { ...ratingSummary(r?._sum.rating ?? 0, r?._count._all ?? 0), completedStages: completed.find((row) => row.userId === userId)?._count._all ?? 0 };
    };
  }

  private card(profile: { id: string; userId: string; displayName: string; headline: string; stageKeys: string[]; hourlyRateTiyn: number | null; city: string | null }, stat: { rating: number | null; reviews: number; completedStages: number }) {
    return {
      id: profile.id, displayName: profile.displayName, headline: profile.headline, city: profile.city, hourlyRate: tenge(profile.hourlyRateTiyn),
      stages: profile.stageKeys.map((key) => ({ key, title: stageTitle(key) })), ...stat,
    };
  }

  async list(stageKey: string | null) {
    if (stageKey && !(catalogStageKeys as string[]).includes(stageKey)) throw new BadRequestException('PROFILE_STAGE_INVALID');
    const profiles = await this.prisma.specialistProfile.findMany({
      where: { ...visible, ...(stageKey ? { stageKeys: { has: stageKey } } : {}) }, take: 200, orderBy: { updatedAt: 'desc' },
      select: { id: true, userId: true, displayName: true, headline: true, stageKeys: true, hourlyRateTiyn: true, city: true, portfolio: true },
    });
    const stat = await this.stats(profiles.map((profile) => profile.userId));
    const cards = profiles.map((profile) => ({ ...this.card(profile, stat(profile.userId)), works: (profile.portfolio as unknown as PortfolioItem[]).length }));
    cards.sort((a, b) => catalogScore(b.rating, b.reviews, b.completedStages) - catalogScore(a.rating, a.reviews, a.completedStages));
    return { data: { specialists: cards, stages: this.stages() } };
  }

  async get(profileId: string, viewerId: string) {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findFirst({
      where: { id: profileId, OR: [visible, { userId: viewerId }] },
      select: { id: true, userId: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true, portfolio: true },
    });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    const [stat, reviews] = await Promise.all([
      this.stats([profile.userId]),
      this.prisma.specialistReview.findMany({ where: { specialistUserId: profile.userId, hiddenAt: null }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, rating: true, text: true, reply: true, repliedAt: true, stageKey: true, projectType: true, createdAt: true, reportStatus: true } }),
    ]);
    const own = profile.userId === viewerId;
    const summary = stat(profile.userId);
    return {
      data: {
        ...this.card(profile, summary), reviewCount: summary.reviews, about: profile.about, own, published: profile.published,
        portfolio: (profile.portfolio as unknown as PortfolioItem[]).map((item) => ({ ...item, stageTitle: item.stageKey ? stageTitle(item.stageKey) : null, host: item.url ? new URL(item.url).hostname.replace(/^www\./, '') : null })),
        reviews: reviews.map((review) => ({
          id: review.id, rating: review.rating, text: review.text, reply: review.reply, repliedAt: review.repliedAt, createdAt: review.createdAt,
          stageTitle: stageTitle(review.stageKey), projectTypeTitle: projectTypeOf(review.projectType)?.title ?? null, canReply: own && !review.reply,
          // Only the specialist sees the state of their own complaint.
          ...(own ? { reportStatus: review.reportStatus, canReport: review.reportStatus === 'none' } : {}),
        })),
      },
    };
  }

  async mine(userId: string) {
    const [profile, user] = await Promise.all([
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { id: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true, portfolio: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    return { data: { profile: profile ? { ...profile, hourlyRate: tenge(profile.hourlyRateTiyn), hourlyRateTiyn: undefined } : null, suggestedName: user?.name ?? null, stages: this.stages() } };
  }

  /** portfolio: undefined keeps what is saved, so an older client does not wipe it. */
  async saveMine(userId: string, input: ProfileInput, portfolio?: unknown) {
    const checked = checkProfile(input);
    if (!checked.ok) throw new BadRequestException(checked.code);
    let works: PortfolioItem[] | undefined;
    if (portfolio !== undefined) {
      const items = checkPortfolio(portfolio);
      if (!items.ok) throw new BadRequestException(items.code);
      works = items.items;
    }
    const data = { ...checked.value, ...(works ? { portfolio: works as unknown as object } : {}) };
    await this.prisma.specialistProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return this.mine(userId);
  }

  /** E-mail of a published profile, for an invitation from the catalog. The address is not returned to the inviter. */
  async emailForInvite(profileId: string): Promise<string> {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findFirst({ where: { id: profileId, ...visible }, select: { user: { select: { emailNormalized: true } } } });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    return profile.user.emailNormalized;
  }

  async review(userId: string, projectId: string, assignmentId: string, rating: unknown, text: unknown) {
    if (!isUuid(projectId) || !isUuid(assignmentId)) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (member.role !== 'owner' && member.role !== 'manager') throw new ForbiddenException('REVIEW_FORBIDDEN');
    const assignment = await this.prisma.stageAssignment.findFirst({
      where: { id: assignmentId, projectId },
      select: { id: true, status: true, userId: true, stage: { select: { stageKey: true } }, project: { select: { projectType: true } }, review: { select: { id: true, createdAt: true, authorUserId: true, hiddenAt: true } } },
    });
    if (!assignment) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const state = reviewState(assignment, assignment.review, userId);
    if (!state.allowed) throw new ConflictException(state.code);
    // Editing must not bring back a review that support hid.
    if (assignment.review?.hiddenAt) throw new ConflictException('REVIEW_HIDDEN');
    const checked = checkReview(rating, text);
    if (!checked.ok) throw new BadRequestException(checked.code);
    await this.prisma.$transaction(async (tx) => {
      if (state.mode === 'create') {
        await tx.specialistReview.create({ data: { assignmentId, specialistUserId: assignment.userId!, authorUserId: userId, stageKey: assignment.stage.stageKey, projectType: assignment.project.projectType, rating: checked.rating, text: checked.text } });
      } else {
        await tx.specialistReview.update({ where: { id: assignment.review!.id }, data: { rating: checked.rating, text: checked.text } });
      }
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: state.mode === 'create' ? 'specialist_reviewed' : 'specialist_review_changed', stageKey: assignment.stage.stageKey, details: { assignmentId, rating: checked.rating } } });
    });
    if (state.mode === 'create') {
      await notifyUser(this.prisma, assignment.userId, {
        text: () => tr('Новый отзыв о вашей работе на этапе «{0}»: {1} из 5. Ответить можно в карточке специалиста.', [tr(stageTitle(assignment.stage.stageKey)), checked.rating]),
        emailSubject: () => tr('BuildPath: новый отзыв о вашей работе'), link: { path: '/account/specialist', label: () => tr('Открыть карточку') },
      });
    }
    return { data: { rating: checked.rating, text: checked.text } };
  }

  /** The reviewed specialist asks support to check a review once, e.g. it is insulting or about something else. */
  async report(userId: string, reviewId: string, reason: unknown) {
    if (!isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const checked = checkReport(reason);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const updated = await this.prisma.specialistReview.updateMany({ where: { id: reviewId, specialistUserId: userId, reportStatus: 'none', hiddenAt: null }, data: { reportStatus: 'pending', reportReason: checked.reason, reportedAt: new Date() } });
    if (updated.count !== 1) {
      const exists = await this.prisma.specialistReview.findFirst({ where: { id: reviewId, specialistUserId: userId }, select: { id: true } });
      throw exists ? new ConflictException('REVIEW_ALREADY_REPORTED') : new NotFoundException('REVIEW_NOT_FOUND');
    }
    return { data: { reportStatus: 'pending' } };
  }

  // --- Staff ---

  async staffReports(status: string) {
    const rows = await this.prisma.specialistReview.findMany({
      where: status === 'decided' ? { reportStatus: { in: ['kept', 'hidden'] } } : { reportStatus: 'pending' },
      orderBy: { reportedAt: status === 'decided' ? 'desc' : 'asc' }, take: 100,
      select: { id: true, rating: true, text: true, reply: true, reportStatus: true, reportReason: true, reportedAt: true, moderationNote: true, stageKey: true, createdAt: true, assignment: { select: { project: { select: { name: true } }, user: { select: { name: true, specialistProfile: { select: { displayName: true } } } } } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, rating: row.rating, text: row.text, reply: row.reply, status: row.reportStatus, reason: row.reportReason, reportedAt: row.reportedAt, note: row.moderationNote, createdAt: row.createdAt,
        stage: stageTitle(row.stageKey), project: row.assignment.project.name, specialist: row.assignment.user?.specialistProfile?.displayName ?? row.assignment.user?.name ?? '—',
      })),
    };
  }

  /** Staff keep or hide a reported review; both the specialist and the author learn the outcome. */
  async staffDecide(staffId: string, reviewId: string, decision: unknown, note: unknown) {
    if (!isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const checked = checkModeration(decision, note);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const review = await this.prisma.specialistReview.findUnique({ where: { id: reviewId }, select: { specialistUserId: true, authorUserId: true, stageKey: true, assignment: { select: { projectId: true } } } });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    const hidden = checked.decision === 'hide';
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.specialistReview.updateMany({ where: { id: reviewId, reportStatus: 'pending' }, data: { reportStatus: hidden ? 'hidden' : 'kept', hiddenAt: hidden ? new Date() : null, moderationNote: checked.note, moderatedByStaffId: staffId } });
      if (!updated.count) throw new ConflictException('REVIEW_NOT_REPORTED');
      await tx.adminAuditEvent.create({ data: { staffId, eventType: hidden ? 'review.hidden' : 'review.kept', targetType: 'specialist_review', targetId: reviewId, details: { note: checked.note } } });
      await tx.projectEvent.create({ data: { projectId: review.assignment.projectId, type: hidden ? 'specialist_review_hidden' : 'specialist_review_kept', stageKey: review.stageKey, details: { reviewId } } });
    });
    const title = stageTitle(review.stageKey);
    await notifyUser(this.prisma, review.specialistUserId, {
      text: hidden ? () => tr('Поддержка BuildPath скрыла отзыв о вашей работе на этапе «{0}»: {1}', [tr(title), checked.note]) : () => tr('Поддержка BuildPath проверила отзыв о вашей работе на этапе «{0}» и оставила его: {1}', [tr(title), checked.note]),
      emailSubject: () => tr('BuildPath: решение по отзыву'),
    });
    if (hidden) await notifyUser(this.prisma, review.authorUserId, { text: () => tr('Поддержка BuildPath скрыла ваш отзыв о специалисте на этапе «{0}»: {1}', [tr(title), checked.note]), emailSubject: () => tr('BuildPath: решение по отзыву') });
    return this.staffReports('pending');
  }

  /** The specialist answers a review once; the answer is public next to it. */
  async reply(userId: string, reviewId: string, text: unknown) {
    if (!isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const value = typeof text === 'string' ? text.trim() : '';
    if (value.length < 2 || value.length > 1000) throw new BadRequestException('REVIEW_REPLY_INVALID');
    const updated = await this.prisma.specialistReview.updateMany({ where: { id: reviewId, specialistUserId: userId, reply: null }, data: { reply: value, repliedAt: new Date() } });
    if (updated.count !== 1) {
      const exists = await this.prisma.specialistReview.findFirst({ where: { id: reviewId, specialistUserId: userId }, select: { id: true } });
      throw exists ? new ConflictException('REVIEW_ALREADY_REPLIED') : new NotFoundException('REVIEW_NOT_FOUND');
    }
    return { data: { reply: value } };
  }
}
