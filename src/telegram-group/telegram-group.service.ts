// The project's Telegram group (STAGE_WORK_MODEL §15).
//
// The owner or a manager links one group to a project: BuildPath gives a one-time «add to group» link
// (t.me/<bot>?startgroup=<code>), Telegram opens the group picker, adds the bot and sends /start <code> in the group.
// From then on key events of the project go to the group as plain lines with the stage title and a button to open the
// project. Nothing else: no contents, names, contacts or money, because people in a group need not be in the project.
// Delivery runs once a minute from a cursor over the project's events, so an event goes at most once; a failed send is
// recorded and not retried. The link ends from BuildPath or when the bot is removed from the group.

import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { contentLocale, inLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { acceptRoles, JourneyCore } from '../journey/journey-core.js';
import { isStageKey, stageTitle, type StageKey } from '../journey/catalog.js';
import { sendTelegramMessage, telegramConfig, type TelegramConfig } from '../notifications/telegram.js';

const CODE_TTL_MS = 30 * 60_000;
const INTERVAL_MS = 60_000;
const BATCH = 20;
/** Only one API instance sends at a time. */
const LOCK_KEY = 7_316_015;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The events that go to the group, each as one line with the stage title. */
export const GROUP_EVENTS = ['stage_submitted', 'stage_accepted', 'stage_changes_requested', 'stage_reopened', 'change_notice_created', 'site_published', 'agent_task_finished'] as const;
type GroupEvent = typeof GROUP_EVENTS[number];

/** One line of the group: stage titles only, never contents. */
export function groupLine(event: { type: string; stageKey: string | null; details: unknown }, projectName: string, projectType: string | null): string | null {
  if (!(GROUP_EVENTS as readonly string[]).includes(event.type)) return null;
  const stage = event.stageKey && isStageKey(event.stageKey) ? `«${tr(stageTitle(event.stageKey as StageKey, projectType))}»` : null;
  const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : {};
  const head = `${projectName}:`;
  switch (event.type as GroupEvent) {
    case 'stage_submitted': return stage ? `${head} ${tr('этап {0} отправлен на приёмку', [stage])}` : null;
    case 'stage_accepted': return stage ? `${head} ${tr('этап {0} принят', [stage])}` : null;
    case 'stage_changes_requested': return stage ? `${head} ${tr('этап {0} возвращён на доработку', [stage])}` : null;
    case 'stage_reopened': return stage ? `${head} ${tr('этап {0} открыт для изменений', [stage])}` : null;
    case 'change_notice_created': return stage ? `${head} ${tr('изменился этап {0} — следующим этапам нужно решить, принять ли изменение', [stage])}` : null;
    case 'site_published': return `${head} ${tr('сайт опубликован')}`;
    case 'agent_task_finished': return `${head} ${details.status === 'succeeded' ? tr('ИИ-агент закончил задачу, проверки прошли') : details.status === 'stopped' ? tr('задачу ИИ-агента остановили') : tr('ИИ-агент закончил задачу, но проверки не прошли')}`;
  }
}

type Update = { message?: { text?: unknown; chat?: { id?: unknown; type?: unknown; title?: unknown }; migrate_to_chat_id?: unknown }; my_chat_member?: { chat?: { id?: unknown; type?: unknown }; new_chat_member?: { status?: unknown } } };
const idOf = (value: unknown) => (typeof value === 'number' || typeof value === 'string' ? String(value).slice(0, 64) : null);
const isGroup = (type: unknown) => type === 'group' || type === 'supergroup';

@Injectable()
export class TelegramGroupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('TelegramGroups');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  onApplicationBootstrap(): void {
    if (process.env.TELEGRAM_GROUPS_DISABLED === 'true' || !telegramConfig()) return;
    const run = () => { this.tick().catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'TELEGRAM_GROUPS_FAILED')); };
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async manager(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    if (ctx.viewer.kind !== 'member' || !acceptRoles.has(ctx.role)) throw new ForbiddenException('TELEGRAM_GROUP_FORBIDDEN');
    return ctx;
  }

  private view(row: { chatId: string | null; title: string | null; linkedAt: Date | null; codeExpiresAt: Date | null; lastSentAt: Date | null; lastFailedAt: Date | null } | null, config: TelegramConfig | null) {
    const linked = Boolean(row?.chatId);
    return {
      configured: Boolean(config), botUsername: config?.botUsername ?? null,
      group: linked ? { title: row!.title, linkedAt: row!.linkedAt, lastSentAt: row!.lastSentAt, lastFailedAt: row!.lastFailedAt } : null,
      waiting: !linked && row?.codeExpiresAt && row.codeExpiresAt > new Date() ? { expiresAt: row.codeExpiresAt } : null,
      events: GROUP_EVENTS.map((type) => ({ type, title: eventTitle(type) })),
    };
  }

  /** Any project member reads whether there is a group; only the owner or a manager changes it. */
  async get(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    if (ctx.viewer.kind !== 'member') throw new NotFoundException('PROJECT_NOT_FOUND');
    const row = await this.prisma.projectTelegramGroup.findUnique({ where: { projectId } });
    return { data: { ...this.view(row, telegramConfig()), canManage: acceptRoles.has(ctx.role) } };
  }

  /** A new one-time «add to group» link; an earlier unused one stops working. */
  async link(userId: string, projectId: string) {
    await this.manager(userId, projectId);
    const config = telegramConfig();
    if (!config) throw new ServiceUnavailableException('TELEGRAM_NOT_CONFIGURED');
    const row = await this.prisma.projectTelegramGroup.findUnique({ where: { projectId }, select: { chatId: true } });
    if (row?.chatId) throw new ConflictException('TELEGRAM_GROUP_LINKED');
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const data = { codeHash: digest(code), codeExpiresAt: expiresAt, linkedByUserId: userId };
    await this.prisma.projectTelegramGroup.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
    return { data: { deepLink: `https://t.me/${config.botUsername}?startgroup=${code}`, expiresAt } };
  }

  async unlink(userId: string, projectId: string) {
    const ctx = await this.manager(userId, projectId);
    const row = await this.prisma.projectTelegramGroup.findUnique({ where: { projectId } });
    if (!row) throw new NotFoundException('TELEGRAM_GROUP_NOT_LINKED');
    await this.prisma.$transaction(async (tx) => {
      await tx.projectTelegramGroup.delete({ where: { id: row.id } });
      if (row.chatId) await this.core.event(tx, projectId, userId, 'telegram_group_unlinked', null, {});
    });
    const config = telegramConfig();
    if (config && row.chatId) await sendTelegramMessage(config, row.chatId, inLocale(ctx.project.locale, () => tr('Группа отключена от проекта «{0}» в BuildPath. Новых сообщений о нём здесь не будет.', [ctx.project.name])));
    return this.get(userId, projectId);
  }

  /**
   * Group updates from the webhook (already verified by its secret): /start <code> in a group links it; the bot removed,
   * or the group turned into a supergroup, updates the links. Returns true when the update was a group one.
   */
  async handleGroupUpdate(update: unknown): Promise<boolean> {
    const member = (update as Update)?.my_chat_member;
    if (member && isGroup(member.chat?.type)) {
      const chatId = idOf(member.chat?.id);
      if (chatId && (member.new_chat_member?.status === 'left' || member.new_chat_member?.status === 'kicked')) {
        const rows = await this.prisma.projectTelegramGroup.findMany({ where: { chatId }, select: { id: true, projectId: true } });
        for (const row of rows) {
          await this.prisma.$transaction(async (tx) => {
            await tx.projectTelegramGroup.delete({ where: { id: row.id } });
            await tx.projectEvent.create({ data: { projectId: row.projectId, actorUserId: null, type: 'telegram_group_unlinked', stageKey: null, details: { byTelegram: true } } });
          });
        }
      }
      return true;
    }
    const message = (update as Update)?.message;
    if (!message || !isGroup(message.chat?.type)) return false;
    const chatId = idOf(message.chat?.id);
    if (!chatId) return true;
    const moved = idOf(message.migrate_to_chat_id);
    if (moved) { await this.prisma.projectTelegramGroup.updateMany({ where: { chatId }, data: { chatId: moved } }); return true; }
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})$/);
    if (!start) return true;
    const config = telegramConfig();
    if (!config) return true;
    const title = typeof message.chat?.title === 'string' ? message.chat.title.slice(0, 255) : null;
    const now = new Date();
    const linked = await this.prisma.$transaction(async (tx) => {
      const row = await tx.projectTelegramGroup.findUnique({ where: { codeHash: digest(start[1]!) }, select: { id: true, projectId: true, chatId: true, codeExpiresAt: true, linkedByUserId: true, project: { select: { name: true, locale: true } } } });
      if (!row || row.chatId || !row.codeExpiresAt || row.codeExpiresAt < now) return null;
      // Nothing from before the link goes to the group.
      await tx.projectTelegramGroup.update({ where: { id: row.id }, data: { chatId, title, linkedAt: now, codeHash: null, codeExpiresAt: null, cursorAt: now, cursorId: null } });
      await this.core.event(tx, row.projectId, row.linkedByUserId, 'telegram_group_linked', null, {});
      return row;
    });
    await sendTelegramMessage(config, chatId, linked
      ? inLocale(linked.project.locale, () => tr('Группа подключена к проекту «{0}». Сюда будут приходить короткие сообщения: этап на приёмке, принят, возвращён, изменение этапа, публикация сайта, работа ИИ-агента — только названия этапов, без содержимого. Отключить можно в BuildPath на вкладке «Команда».', [linked.project.name]))
      : tr('Ссылка устарела или уже использована. Откройте проект в BuildPath и нажмите «Подключить группу» ещё раз.'));
    return true;
  }

  /** Sends what happened since the cursor of each linked group. */
  async tick(fetchImpl: typeof fetch = fetch): Promise<number> {
    const config = telegramConfig();
    if (!config) return 0;
    const locked = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked[0]?.locked) return 0;
    try {
      let sent = 0;
      const groups = await this.prisma.projectTelegramGroup.findMany({ where: { chatId: { not: null } }, select: { id: true, projectId: true, chatId: true, cursorAt: true, cursorId: true, project: { select: { name: true, locale: true, projectType: true, status: true } } } });
      const appUrl = (process.env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
      for (const group of groups) {
        if (group.project.status === 'cancelled') continue;
        const after = group.cursorAt ?? new Date(0);
        const events = await this.prisma.projectEvent.findMany({
          where: { projectId: group.projectId, type: { in: [...GROUP_EVENTS] }, OR: [{ createdAt: { gt: after } }, ...(group.cursorId ? [{ createdAt: after, id: { gt: group.cursorId } }] : [])] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true, type: true, stageKey: true, details: true, createdAt: true },
        });
        if (!events.length) continue;
        let ok = true;
        for (const event of events) {
          const line = runWithLocale(contentLocale(group.project.locale), () => groupLine(event, group.project.name, group.project.projectType));
          if (!line) continue;
          const button = /^https:\/\//.test(appUrl) ? [[{ text: inLocale(group.project.locale, () => tr('Открыть в BuildPath')), url: `${appUrl}/projects/${group.projectId}${event.stageKey ? `/stages/${event.stageKey}` : ''}` }]] : undefined;
          if (await sendTelegramMessage(config, group.chatId!, line, fetchImpl, button)) sent += 1; else ok = false;
        }
        const last = events[events.length - 1]!;
        await this.prisma.projectTelegramGroup.update({ where: { id: group.id }, data: { cursorAt: last.createdAt, cursorId: last.id, ...(ok ? { lastSentAt: new Date() } : { lastFailedAt: new Date() }) } });
      }
      return sent;
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  }
}

function eventTitle(type: GroupEvent): string {
  return {
    stage_submitted: tr('Этап отправлен на приёмку'), stage_accepted: tr('Этап принят'), stage_changes_requested: tr('Этап возвращён на доработку'),
    stage_reopened: tr('Этап открыт для изменений'), change_notice_created: tr('Изменился этап, от которого зависят следующие'),
    site_published: tr('Сайт опубликован'), agent_task_finished: tr('ИИ-агент закончил задачу'),
  }[type];
}
