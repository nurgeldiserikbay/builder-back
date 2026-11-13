import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { MAX_UPLOAD_BYTES, ImageRejectedError, detectImageType, processImage } from '../images/image-processing.js';
import { scanRequired, scanWithClamAv } from '../security/clamav.js';
import { PrismaService } from '../database/prisma.service.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { MAX_PORTFOLIO, catalogScore, catalogStageKeys, checkModeration, checkPortfolio, checkProfile, checkReport, checkReview, checkProfileReport, checkProfileDecision, searchWords, matchesSearch, ratingSummary, reviewState, type PortfolioItem, type ProfileInput } from './catalog-rules.js';
import { tr } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const stageTitle = (key: string) => stageDefinitions[key as StageKey]?.title ?? key;
const tenge = (tiyn: number | null) => (tiyn === null ? null : tiyn / 100);
/** Visible in the catalog: published, not hidden by support, and the account is not being deleted. */
const visible = { published: true, blockedAt: null, user: { deletionRequestedAt: null } };

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

  async list(stageKey: string | null, query: unknown = null) {
    if (stageKey && !(catalogStageKeys as string[]).includes(stageKey)) throw new BadRequestException('PROFILE_STAGE_INVALID');
    const search = searchWords(query);
    if (!search.ok) throw new BadRequestException(search.code);
    const found = await this.prisma.specialistProfile.findMany({
      where: { ...visible, ...(stageKey ? { stageKeys: { has: stageKey } } : {}) }, take: search.words.length ? 1000 : 200, orderBy: { updatedAt: 'desc' },
      select: { id: true, userId: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, portfolio: true },
    });
    // Text search runs over the card as shown: the catalog is small enough to match in memory, and so the result is the same words a person reads.
    const profiles = found.filter((profile) => matchesSearch([
      profile.displayName, profile.headline, profile.about ?? '', profile.city ?? '', ...profile.stageKeys.map((key) => tr(stageTitle(key))),
      ...(profile.portfolio as unknown as PortfolioItem[]).flatMap((item) => [item.title, item.description ?? '']),
    ].join(' '), search.words)).slice(0, 200);
    const stat = await this.stats(profiles.map((profile) => profile.userId));
    const cards = profiles.map((profile) => ({ ...this.card(profile, stat(profile.userId)), works: (profile.portfolio as unknown as PortfolioItem[]).length }));
    cards.sort((a, b) => catalogScore(b.rating, b.reviews, b.completedStages) - catalogScore(a.rating, a.reviews, a.completedStages));
    return { data: { specialists: cards, stages: this.stages(), query: search.words.join(' ') } };
  }

  async get(profileId: string, viewerId: string) {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findFirst({
      where: { id: profileId, OR: [visible, { userId: viewerId }] },
      select: { id: true, userId: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true, portfolio: true, blockedAt: true, blockedReason: true },
    });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    const pendingReport = profile.userId === viewerId ? null : await this.prisma.specialistProfileReport.findFirst({ where: { profileId: profile.id, reporterUserId: viewerId, status: 'pending' }, select: { id: true } });
    const [stat, reviews] = await Promise.all([
      this.stats([profile.userId]),
      this.prisma.specialistReview.findMany({ where: { specialistUserId: profile.userId, hiddenAt: null }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, rating: true, text: true, reply: true, repliedAt: true, stageKey: true, projectType: true, createdAt: true, reportStatus: true } }),
    ]);
    const own = profile.userId === viewerId;
    const summary = stat(profile.userId);
    return {
      data: {
        ...this.card(profile, summary), reviewCount: summary.reviews, about: profile.about, own, published: profile.published,
        // Only the specialist sees why support hid the card; others never reach a hidden card.
        ...(own ? { blocked: profile.blockedAt ? { at: profile.blockedAt, reason: profile.blockedReason } : null } : { canReport: !pendingReport, reportPending: Boolean(pendingReport) }),
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
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { id: true, displayName: true, headline: true, about: true, stageKeys: true, hourlyRateTiyn: true, city: true, published: true, portfolio: true, blockedAt: true, blockedReason: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    return { data: { profile: profile ? { ...profile, hourlyRate: tenge(profile.hourlyRateTiyn), hourlyRateTiyn: undefined, blockedAt: undefined, blockedReason: undefined, blocked: profile.blockedAt ? { at: profile.blockedAt, reason: profile.blockedReason } : null } : null, suggestedName: user?.name ?? null, stages: this.stages() } };
  }

  /** portfolio: undefined keeps what is saved, so an older client does not wipe it. */
  async saveMine(userId: string, input: ProfileInput, portfolio?: unknown) {
    const checked = checkProfile(input);
    if (!checked.ok) throw new BadRequestException(checked.code);
    if (checked.value.published) {
      const current = await this.prisma.specialistProfile.findUnique({ where: { userId }, select: { blockedAt: true } });
      if (current?.blockedAt) throw new ConflictException('PROFILE_BLOCKED');
    }
    let works: PortfolioItem[] | undefined;
    if (portfolio !== undefined) {
      const photos = await this.prisma.specialistPhoto.findMany({ where: { userId }, select: { id: true } });
      const items = checkPortfolio(portfolio, new Set(photos.map((photo) => photo.id)));
      if (!items.ok) throw new BadRequestException(items.code);
      works = items.items;
    }
    const data = { ...checked.value, ...(works ? { portfolio: works as unknown as object } : {}) };
    await this.prisma.specialistProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    // Photos no saved work shows any more (taken off a work, or uploaded and never saved) are removed with the save.
    if (works) await this.prisma.specialistPhoto.deleteMany({ where: { userId, id: { notIn: works.flatMap((item) => (item.photoId ? [item.photoId] : [])) } } });
    return this.mine(userId);
  }

  /** Photos are uploaded first, then put on a work; scanned and re-encoded like project photos. Up to 24 kept between saves. */
  async uploadPhoto(userId: string, file: { buffer: Buffer; size: number } | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('IMAGE_FILE_REQUIRED');
    if (file.size > MAX_UPLOAD_BYTES) throw new UnprocessableEntityException('IMAGE_TOO_LARGE');
    if (!detectImageType(file.buffer)) throw new UnprocessableEntityException('IMAGE_TYPE_NOT_SUPPORTED');
    if ((await this.prisma.specialistPhoto.count({ where: { userId } })) >= MAX_PORTFOLIO * 2) throw new ConflictException('PORTFOLIO_PHOTO_LIMIT');
    if (scanRequired()) {
      const scan = await scanWithClamAv(file.buffer);
      if (scan === 'infected') throw new UnprocessableEntityException('IMAGE_REJECTED_BY_SCAN');
      if (scan === 'unavailable') throw new ServiceUnavailableException('IMAGE_SCAN_UNAVAILABLE');
    }
    let processed;
    try { processed = await processImage(file.buffer); } catch (error) { throw new UnprocessableEntityException(error instanceof ImageRejectedError ? error.code : 'IMAGE_UNREADABLE'); }
    const photo = await this.prisma.specialistPhoto.create({ data: { userId, data: new Uint8Array(processed.data), width: processed.width, height: processed.height, sizeBytes: processed.data.length, sha256: processed.sha256 }, select: { id: true, width: true, height: true } });
    return { data: photo };
  }

  /** A photo that no work uses any more can be deleted; one on a work must be taken off first. */
  async deletePhoto(userId: string, photoId: string) {
    if (!isUuid(photoId)) throw new NotFoundException('PHOTO_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findUnique({ where: { userId }, select: { portfolio: true } });
    if ((profile?.portfolio as unknown as PortfolioItem[] | undefined)?.some((item) => item.photoId === photoId)) throw new ConflictException('PORTFOLIO_PHOTO_IN_USE');
    const deleted = await this.prisma.specialistPhoto.deleteMany({ where: { id: photoId, userId } });
    if (!deleted.count) throw new NotFoundException('PHOTO_NOT_FOUND');
    return { data: { deleted: true } };
  }

  /** A portfolio photo: to its author always, to others only when a work of a published profile shows it. */
  async photo(userId: string, photoId: string) {
    if (!isUuid(photoId)) throw new NotFoundException('PHOTO_NOT_FOUND');
    const row = await this.prisma.specialistPhoto.findUnique({ where: { id: photoId }, select: { userId: true, data: true, sha256: true } });
    if (!row) throw new NotFoundException('PHOTO_NOT_FOUND');
    if (row.userId !== userId) {
      const profile = await this.prisma.specialistProfile.findFirst({ where: { userId: row.userId, ...visible }, select: { portfolio: true } });
      if (!(profile?.portfolio as unknown as PortfolioItem[] | undefined)?.some((item) => item.photoId === photoId)) throw new NotFoundException('PHOTO_NOT_FOUND');
    }
    return { data: Buffer.from(row.data), etag: row.sha256 };
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

  /** Anyone signed in except the specialist can complain about a card or one of its works; one open complaint per card. */
  async reportProfile(userId: string, profileId: string, raw: { target?: unknown; workIndex?: unknown; reason?: unknown; text?: unknown }) {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const profile = await this.prisma.specialistProfile.findFirst({ where: { id: profileId, ...visible }, select: { id: true, userId: true, portfolio: true } });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    if (profile.userId === userId) throw new ForbiddenException('PROFILE_REPORT_OWN');
    const works = profile.portfolio as unknown as PortfolioItem[];
    const checked = checkProfileReport(raw, works.length);
    if (!checked.ok) throw new BadRequestException(checked.code);
    if ((await this.prisma.specialistProfileReport.count({ where: { reporterUserId: userId, status: 'pending' } })) >= 5) throw new ConflictException('PROFILE_REPORT_TOO_MANY');
    const work = checked.workIndex === null ? null : works[checked.workIndex]!;
    try {
      await this.prisma.specialistProfileReport.create({ data: { profileId, reporterUserId: userId, target: checked.target, workTitle: work?.title ?? null, workUrl: work?.url ?? null, reason: checked.reason, text: checked.text } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('PROFILE_REPORT_PENDING');
      throw error;
    }
    return { data: { reportPending: true } };
  }

  async staffProfileReports(status: string) {
    const rows = await this.prisma.specialistProfileReport.findMany({
      where: status === 'decided' ? { status: { not: 'pending' } } : { status: 'pending' }, orderBy: { createdAt: status === 'decided' ? 'desc' : 'asc' }, take: 100,
      select: { id: true, target: true, workTitle: true, workUrl: true, reason: true, text: true, status: true, staffNote: true, createdAt: true, decidedAt: true,
        profile: { select: { id: true, displayName: true, headline: true, published: true, blockedAt: true, portfolio: true } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, target: row.target, reason: row.reason, text: row.text, status: row.status, note: row.staffNote, createdAt: row.createdAt, decidedAt: row.decidedAt,
        work: row.target === 'work' ? { title: row.workTitle, url: row.workUrl, stillShown: (row.profile.portfolio as unknown as PortfolioItem[]).some((item) => item.title === row.workTitle && item.url === row.workUrl) } : null,
        profile: { id: row.profile.id, displayName: row.profile.displayName, headline: row.profile.headline, published: row.profile.published, blocked: Boolean(row.profile.blockedAt) },
      })),
    };
  }

  /**
   * Staff decide a complaint: dismiss it, take the reported work off the card, or hide the whole card until support
   * restores it. The reporter learns the outcome; the specialist learns what changed, never who complained.
   */
  async staffDecideProfileReport(staffId: string, reportId: string, decision: unknown, note: unknown) {
    if (!isUuid(reportId)) throw new NotFoundException('REPORT_NOT_FOUND');
    const report = await this.prisma.specialistProfileReport.findUnique({ where: { id: reportId }, select: { id: true, target: true, workTitle: true, workUrl: true, reporterUserId: true, profile: { select: { id: true, userId: true } } } });
    if (!report) throw new NotFoundException('REPORT_NOT_FOUND');
    const checked = checkProfileDecision(decision, note, report.target);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const status = checked.decision === 'dismiss' ? 'dismissed' : checked.decision === 'remove_work' ? 'work_removed' : 'card_hidden';
    let removed = false;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.specialistProfileReport.updateMany({ where: { id: reportId, status: 'pending' }, data: { status, staffNote: checked.note, decidedByStaffId: staffId, decidedAt: new Date() } });
      if (!updated.count) throw new ConflictException('REPORT_ALREADY_DECIDED');
      if (checked.decision === 'remove_work') {
        const profile = await tx.specialistProfile.findUniqueOrThrow({ where: { id: report.profile.id }, select: { portfolio: true } });
        const works = profile.portfolio as unknown as PortfolioItem[];
        // The work is matched as it was reported; if the specialist already changed or removed it, nothing is taken off.
        const kept = works.filter((item) => !(item.title === report.workTitle && item.url === report.workUrl));
        removed = kept.length !== works.length;
        if (removed) await tx.specialistProfile.update({ where: { id: report.profile.id }, data: { portfolio: kept as unknown as object } });
      }
      if (checked.decision === 'hide_card') await tx.specialistProfile.update({ where: { id: report.profile.id }, data: { published: false, blockedAt: new Date(), blockedReason: checked.note } });
      await tx.adminAuditEvent.create({ data: { staffId, eventType: `specialist_profile_report.${status}`, targetType: 'specialist_profile', targetId: report.profile.id, details: { reportId, note: checked.note, removed } } });
    });
    if (checked.decision === 'remove_work' && removed) {
      await notifyUser(this.prisma, report.profile.userId, { text: () => tr('Поддержка BuildPath убрала из вашей карточки работу «{0}»: {1}', [report.workTitle ?? '', checked.note]), emailSubject: () => tr('BuildPath: изменение в карточке специалиста'), link: { path: '/account/specialist', label: () => tr('Открыть карточку') } }).catch(() => undefined);
    }
    if (checked.decision === 'hide_card') {
      await notifyUser(this.prisma, report.profile.userId, { text: () => tr('Поддержка BuildPath скрыла вашу карточку из каталога: {0}. Вы можете её исправить; если не согласны с решением — напишите в поддержку.', [checked.note]), emailSubject: () => tr('BuildPath: карточка скрыта из каталога'), link: { path: '/account/specialist', label: () => tr('Открыть карточку') } }).catch(() => undefined);
    }
    await notifyUser(this.prisma, report.reporterUserId, {
      text: checked.decision === 'dismiss' ? () => tr('Поддержка BuildPath проверила вашу жалобу на карточку специалиста и ничего не изменила: {0}', [checked.note]) : () => tr('Поддержка BuildPath проверила вашу жалобу на карточку специалиста и приняла меры: {0}', [checked.note]),
      emailSubject: () => tr('BuildPath: решение по жалобе'),
    }).catch(() => undefined);
    return this.staffProfileReports('pending');
  }

  /** Support puts a hidden card back; the specialist publishes it again themselves. */
  async staffUnblockProfile(staffId: string, profileId: string, note: unknown) {
    if (!isUuid(profileId)) throw new NotFoundException('PROFILE_NOT_FOUND');
    const value = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '';
    if (value.length < 5 || value.length > 500) throw new BadRequestException('MODERATION_NOTE_REQUIRED');
    const profile = await this.prisma.specialistProfile.findUnique({ where: { id: profileId }, select: { userId: true, blockedAt: true } });
    if (!profile) throw new NotFoundException('PROFILE_NOT_FOUND');
    if (!profile.blockedAt) throw new ConflictException('PROFILE_NOT_BLOCKED');
    await this.prisma.$transaction([
      this.prisma.specialistProfile.update({ where: { id: profileId }, data: { blockedAt: null, blockedReason: null } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'specialist_profile.unblocked', targetType: 'specialist_profile', targetId: profileId, details: { note: value } } }),
    ]);
    await notifyUser(this.prisma, profile.userId, { text: () => tr('Поддержка BuildPath вернула возможность публиковать вашу карточку: {0}', [value]), emailSubject: () => tr('BuildPath: карточку снова можно опубликовать'), link: { path: '/account/specialist', label: () => tr('Открыть карточку') } }).catch(() => undefined);
    return { data: { blocked: false } };
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
