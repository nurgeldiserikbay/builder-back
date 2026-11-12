import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { catalogScore, catalogStageKeys, checkProfile, checkReview, ratingSummary, reviewState, type ProfileInput } from './catalog-rules.js';

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
      this.prisma.specialistReview.groupBy({ by: ['specialistUserId'], where: { specialistUserId: { in: userIds } }, _sum: { rating: true }, _count: { _all: true } }),
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
      select: { id: true, userId: true, displayName: true, headline: true, stageKeys: true, hourlyRateTiyn: true, city: true },
    });
    const stat = await this.stats(profiles.map((profile) => profile.userId));
    const cards = profiles.map((profile) => this.card(profile, stat(profile.userId)));
    cards.sort((a, b) => catalogScore(b.rating, b.reviews, b.completedStages) - catalogScore(a.rating, a.reviews, a.completedStages));
    return { data: { specialists: cards, stages: this.stages() } };
  }

  async get(profileId: string, viewerId: string) {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findFirst({
      where: { id: profileId, OR: [visible, { userId: viewerId }] },
      select: { id: true, userId: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true },
    });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    const [stat, reviews] = await Promise.all([
      this.stats([profile.userId]),
      this.prisma.specialistReview.findMany({ where: { specialistUserId: profile.userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, rating: true, text: true, reply: true, repliedAt: true, stageKey: true, projectType: true, createdAt: true } }),
    ]);
    const own = profile.userId === viewerId;
    const summary = stat(profile.userId);
    return {
      data: {
        ...this.card(profile, summary), reviewCount: summary.reviews, about: profile.about, own, published: profile.published,
        reviews: reviews.map((review) => ({
          id: review.id, rating: review.rating, text: review.text, reply: review.reply, repliedAt: review.repliedAt, createdAt: review.createdAt,
          stageTitle: stageTitle(review.stageKey), projectTypeTitle: projectTypeOf(review.projectType)?.title ?? null, canReply: own && !review.reply,
        })),
      },
    };
  }

  async mine(userId: string) {
    const [profile, user] = await Promise.all([
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { id: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    return { data: { profile: profile ? { ...profile, hourlyRate: tenge(profile.hourlyRateTiyn), hourlyRateTiyn: undefined } : null, suggestedName: user?.name ?? null, stages: this.stages() } };
  }

  async saveMine(userId: string, input: ProfileInput) {
    const checked = checkProfile(input);
    if (!checked.ok) throw new BadRequestException(checked.code);
    await this.prisma.specialistProfile.upsert({ where: { userId }, create: { userId, ...checked.value }, update: checked.value });
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
      select: { id: true, status: true, userId: true, stage: { select: { stageKey: true } }, project: { select: { projectType: true } }, review: { select: { id: true, createdAt: true, authorUserId: true } } },
    });
    if (!assignment) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const state = reviewState(assignment, assignment.review, userId);
    if (!state.allowed) throw new ConflictException(state.code);
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
    return { data: { rating: checked.rating, text: checked.text } };
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
