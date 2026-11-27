// «Показать другому человеку» (builder-docs PRODUCT_LIFECYCLE.md §4.4): a read-only link to the product concept for a
// person without an account — a partner, an investor, a future developer. The owner turns it on, chooses sections to hide
// («Деньги, цели и риски» by default) and whether readers may leave remarks. The link shows the current saved concept,
// so edits reach readers at once; a new link or turning it off stops the old one at once.
// Remarks are untrusted plain text: kept as text, shown only to the project's team, never given to an AI.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { RateLimiter } from '../security/rate-limit.js';
import type { ConceptDocument } from './concept.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';

export const SHARE_LIMITS = { name: 60, text: 1000, comments: 200 };
export const SHARE_RATE = { perIp: { max: 10, windowMs: 60 * 60_000 }, perLink: { max: 100, windowMs: 24 * 60 * 60_000 } };
/** Sections a reader may not see by default: money, goals and risks are often not for outsiders. */
export const DEFAULT_HIDDEN = ['goals'];
const limits = new RateLimiter();
const TOKEN = /^[A-Za-z0-9_-]{24,48}$/;
const SECTION = /^[a-z]{1,40}$/;

export const newShareToken = () => randomBytes(24).toString('base64url');

/** The page a reader opens; null when the platform's public app address is not set. */
export function shareUrl(token: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/concept/${token}` : null;
}

/** The document without the hidden sections, and without the diagrams those sections carried. */
export function sharedDocument<T extends ConceptDocument>(document: T, hidden: string[]): Omit<T, 'markdown'> {
  const { markdown: _whole, ...rest } = document;
  const sections = document.sections.filter((section) => !hidden.includes(section.key));
  const shown = new Set(sections.map((section) => section.key));
  // The whole Markdown holds every section, hidden ones too: the reader gets sections only.
  return { ...rest, sections, diagrams: document.diagrams.filter((diagram) => shown.has(diagram.key === 'process' ? 'how' : 'data')) };
}

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '');

/** A remark as the reader sends it; null for a bot (the hidden field was filled). */
export function readRemark(raw: unknown, sections: string[]): { name: string; text: string; section: string | null } | null {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (typeof body.website === 'string' && body.website.trim()) return null;
  const text = clean(body.text, SHARE_LIMITS.text);
  if (text.length < 3) throw new BadRequestException('REMARK_TEXT_REQUIRED');
  const name = clean(body.name, SHARE_LIMITS.name);
  if (!name) throw new BadRequestException('REMARK_NAME_REQUIRED');
  const section = typeof body.section === 'string' && SECTION.test(body.section) && sections.includes(body.section) ? body.section : null;
  return { name, text, section };
}

type Share = { id: string; token: string; enabled: boolean; allowComments: boolean; hiddenSections: string[]; views: number; createdAt: Date };

@Injectable()
export class ConceptShareService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly journey: JourneyService) {}

  private async sections(projectId: string) {
    const concept = await this.journey.conceptForShare(projectId);
    return concept?.document.sections.map((section) => ({ key: section.key, title: section.title })) ?? [];
  }

  private async view(projectId: string, share: Share | null) {
    const comments = share ? await this.prisma.guestComment.findMany({ where: { shareId: share.id }, orderBy: { createdAt: 'desc' }, take: SHARE_LIMITS.comments }) : [];
    return {
      enabled: share?.enabled ?? false, url: share ? shareUrl(share.token) : null, configured: Boolean(process.env.PUBLIC_APP_URL),
      allowComments: share?.allowComments ?? true, hiddenSections: share?.hiddenSections ?? DEFAULT_HIDDEN, views: share?.views ?? 0,
      sections: await this.sections(projectId),
      comments: comments.map((item) => ({ id: item.id, name: item.name, section: item.section, text: item.text, createdAt: item.createdAt, resolvedAt: item.resolvedAt })),
    };
  }

  async get(userId: string, projectId: string) {
    await this.core.load(userId, projectId, 'read', 'concept');
    return { data: await this.view(projectId, await this.prisma.conceptShare.findUnique({ where: { projectId } })) };
  }

  /** On or off, remarks on or off, hidden sections, or a new link (the old one stops working at once). Owner or manager. */
  async set(userId: string, projectId: string, input: { enabled?: unknown; allowComments?: unknown; hiddenSections?: unknown; renew?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'accept', 'concept');
    if (!ctx.route.includes('concept')) throw new NotFoundException('STAGE_NOT_FOUND');
    const hidden = input.hiddenSections === undefined ? undefined : Array.isArray(input.hiddenSections) && input.hiddenSections.length <= 20 && input.hiddenSections.every((key) => typeof key === 'string' && SECTION.test(key)) ? [...new Set(input.hiddenSections as string[])] : null;
    if (hidden === null) throw new BadRequestException('INVALID_SECTIONS');
    const changes = { ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}), ...(typeof input.allowComments === 'boolean' ? { allowComments: input.allowComments } : {}), ...(hidden ? { hiddenSections: hidden } : {}) };
    if (!Object.keys(changes).length && input.renew !== true) throw new BadRequestException('INVALID_BODY');
    const existing = await this.prisma.conceptShare.findUnique({ where: { projectId } });
    if (!existing && !(await this.journey.conceptForShare(projectId))) throw new BadRequestException('NOTHING_TO_SHARE');
    const share = existing
      ? await this.prisma.conceptShare.update({ where: { projectId }, data: { ...changes, ...(input.renew === true ? { token: newShareToken(), views: 0 } : {}) } })
      : await this.prisma.conceptShare.create({ data: { projectId, token: newShareToken(), createdByUserId: userId, hiddenSections: DEFAULT_HIDDEN, ...changes } });
    await this.core.event(this.prisma, projectId, userId, 'concept_share_changed', null, { enabled: share.enabled, allowComments: share.allowComments, hidden: share.hiddenSections, renewed: input.renew === true });
    return { data: await this.view(projectId, share) };
  }

  /** «Учтено» on a remark, or back. */
  async resolve(userId: string, projectId: string, commentId: string, resolved: boolean) {
    await this.core.load(userId, projectId, 'write', 'concept');
    const share = await this.prisma.conceptShare.findUnique({ where: { projectId } });
    const comment = share && /^[0-9a-f-]{36}$/.test(commentId) ? await this.prisma.guestComment.findFirst({ where: { id: commentId, shareId: share.id } }) : null;
    if (!share || !comment) throw new NotFoundException('COMMENT_NOT_FOUND');
    await this.prisma.guestComment.update({ where: { id: comment.id }, data: { resolvedAt: resolved ? new Date() : null } });
    return { data: await this.view(projectId, share) };
  }

  private async open(token: string) {
    if (!TOKEN.test(token)) throw new NotFoundException('SHARE_NOT_FOUND');
    const share = await this.prisma.conceptShare.findUnique({ where: { token } });
    if (!share?.enabled) throw new NotFoundException('SHARE_NOT_FOUND');
    const concept = await this.journey.conceptForShare(share.projectId);
    if (!concept) throw new NotFoundException('SHARE_NOT_FOUND');
    return { share, concept };
  }

  /** The reader's page: the document without hidden sections. Each opening is counted, nothing about the reader is kept. */
  async read(token: string) {
    const { share, concept } = await this.open(token);
    await this.prisma.conceptShare.update({ where: { id: share.id }, data: { views: { increment: 1 } } });
    return { data: { document: sharedDocument(concept.document, share.hiddenSections), allowComments: share.allowComments, locale: concept.locale } };
  }

  async remark(token: string, ip: string, raw: unknown) {
    const { share, concept } = await this.open(token);
    if (!share.allowComments) throw new NotFoundException('SHARE_NOT_FOUND');
    await limits.take('share-ip', `${token}:${ip}`, SHARE_RATE.perIp, 'REMARK_TOO_MANY');
    await limits.take('share-link', token, SHARE_RATE.perLink, 'REMARK_TOO_MANY');
    const shown = sharedDocument(concept.document, share.hiddenSections).sections.map((section) => section.key);
    const remark = readRemark(raw, shown);
    if (!remark) return { data: { ok: true } };
    await this.prisma.$transaction([
      this.prisma.guestComment.create({ data: { shareId: share.id, ...remark } }),
      this.prisma.projectEvent.create({ data: { projectId: share.projectId, type: 'concept_guest_remark', details: { section: remark.section } } }),
    ]);
    return { data: { ok: true } };
  }
}
