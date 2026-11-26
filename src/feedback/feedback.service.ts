// Feedback from a launched application (builder-docs PRODUCT_LIFECYCLE.md §4.12, «Работа и обратная связь»). The owner
// turns the inbox on; the AI agent then puts a small «Сообщить о проблеме или идее» form into the application, which posts
// to a public address with the project's token. Each message lands in the backlog («Развитие») as an item to decide on.
// What people write is untrusted text: it is kept as plain text, never run, never given to an AI as instructions.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { JourneyCore } from '../journey/journey-core.js';
import { RateLimiter } from '../security/rate-limit.js';

export const FEEDBACK_LIMITS = { text: 2000, contact: 200, page: 300 };
/** One person (address) per hour, and the whole application per day: a form, not a channel for floods. */
export const FEEDBACK_RATE = { perIp: { max: 10, windowMs: 60 * 60_000 }, perApp: { max: 300, windowMs: 24 * 60 * 60_000 } };
const limits = new RateLimiter();
const TOKEN = /^[A-Za-z0-9_-]{24,48}$/;

export const newFeedbackToken = () => randomBytes(24).toString('base64url');

/** The public address the application posts to; null when the platform's public API address is not set. */
export function feedbackUrl(token: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/api/v1/feedback/${token}` : null;
}

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '');

/** A message as the application sends it; null when it is not one (the honeypot was filled, or the text is empty). */
export function readFeedback(raw: unknown): { kind: 'problem' | 'idea'; text: string; contact: string; page: string } | null {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  // A field people never see: a bot fills every field it finds.
  if (typeof body.website === 'string' && body.website.trim()) return null;
  const text = clean(body.text, FEEDBACK_LIMITS.text);
  if (text.length < 3) throw new BadRequestException('FEEDBACK_TEXT_REQUIRED');
  return { kind: body.kind === 'idea' ? 'idea' : 'problem', text, contact: clean(body.contact, FEEDBACK_LIMITS.contact), page: clean(body.page, FEEDBACK_LIMITS.page) };
}

/** The backlog item a message becomes: a short title, the whole message and how to reach the person in the details. */
export function feedbackItem(message: { kind: 'problem' | 'idea'; text: string; contact: string; page: string }) {
  const first = message.text.split('\n')[0]!.trim();
  const title = `${message.kind === 'idea' ? tr('Идея') : tr('Проблема')}: ${first.length > 120 ? `${first.slice(0, 117)}…` : first}`;
  const details = [message.text, message.page ? tr('Страница: {0}', [message.page]) : '', message.contact ? tr('Как связаться: {0}', [message.contact]) : ''].filter(Boolean).join('\n').slice(0, 1000);
  return { title: title.slice(0, 200), details, priority: message.kind === 'problem' ? 'high' : 'medium' };
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  private view(inbox: { token: string; enabled: boolean; received: number; lastReceivedAt: Date | null } | null) {
    if (!inbox) return { enabled: false, url: null, received: 0, lastReceivedAt: null, configured: Boolean(process.env.PUBLIC_API_URL) };
    return { enabled: inbox.enabled, url: feedbackUrl(inbox.token), received: inbox.received, lastReceivedAt: inbox.lastReceivedAt, configured: Boolean(process.env.PUBLIC_API_URL) };
  }

  async get(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    if (ctx.type.key !== 'web_app') throw new NotFoundException('FEEDBACK_NOT_FOR_PROJECT');
    return { data: this.view(await this.prisma.feedbackInbox.findUnique({ where: { projectId } })) };
  }

  /** On, off, or a new address (the old one stops working at once — for when the form is abused). */
  async set(userId: string, projectId: string, input: { enabled?: unknown; renew?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'write');
    if (ctx.type.key !== 'web_app') throw new NotFoundException('FEEDBACK_NOT_FOR_PROJECT');
    if (typeof input.enabled !== 'boolean' && input.renew !== true) throw new BadRequestException('INVALID_BODY');
    const existing = await this.prisma.feedbackInbox.findUnique({ where: { projectId } });
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true;
    const inbox = existing
      ? await this.prisma.feedbackInbox.update({ where: { projectId }, data: { enabled, ...(input.renew === true ? { token: newFeedbackToken() } : {}) } })
      : await this.prisma.feedbackInbox.create({ data: { projectId, token: newFeedbackToken(), enabled } });
    await this.core.event(this.prisma, projectId, userId, 'feedback_inbox_changed', null, { enabled, renewed: input.renew === true });
    return { data: this.view(inbox) };
  }

  /** The address the agent writes into the application's form, when the owner turned feedback on. */
  async urlFor(projectId: string): Promise<string | null> {
    const inbox = await this.prisma.feedbackInbox.findUnique({ where: { projectId }, select: { token: true, enabled: true } });
    return inbox?.enabled ? feedbackUrl(inbox.token) : null;
  }

  /** The public side: a message from the application. Unknown or turned-off addresses look the same: not found. */
  async receive(token: string, ip: string, raw: unknown): Promise<{ ok: true }> {
    if (!TOKEN.test(token)) throw new NotFoundException('FEEDBACK_NOT_FOUND');
    const inbox = await this.prisma.feedbackInbox.findUnique({ where: { token }, select: { id: true, projectId: true, enabled: true } });
    if (!inbox?.enabled) throw new NotFoundException('FEEDBACK_NOT_FOUND');
    await limits.take('feedback-ip', `${token}:${ip}`, FEEDBACK_RATE.perIp, 'FEEDBACK_TOO_MANY');
    await limits.take('feedback-app', token, FEEDBACK_RATE.perApp, 'FEEDBACK_TOO_MANY');
    const message = readFeedback(raw);
    // A bot: answered like a person, so it learns nothing; nothing is stored.
    if (!message) return { ok: true };
    const project = await this.prisma.project.findUnique({ where: { id: inbox.projectId }, select: { locale: true } });
    const item = runWithLocale(contentLocale(project?.locale ?? 'ru'), () => feedbackItem(message));
    await this.prisma.$transaction([
      this.prisma.backlogItem.create({ data: { projectId: inbox.projectId, source: 'app_feedback', title: item.title, details: item.details, priority: item.priority } }),
      this.prisma.feedbackInbox.update({ where: { id: inbox.id }, data: { received: { increment: 1 }, lastReceivedAt: new Date() } }),
      this.prisma.projectEvent.create({ data: { projectId: inbox.projectId, type: 'app_feedback_received', details: { kind: message.kind } } }),
    ]);
    return { ok: true };
  }
}
