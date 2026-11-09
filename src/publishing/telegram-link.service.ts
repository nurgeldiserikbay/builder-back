import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { answerCallbackQuery, sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { TelegramBotService } from '../telegram-bot/bot.service.js';

const CODE_TTL_MS = 15 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type TelegramMessage = { text?: unknown; voice?: unknown; audio?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; username?: unknown } };
type TelegramUpdate = { message?: TelegramMessage; callback_query?: { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { chat?: { id?: unknown; type?: unknown } } } };
const idOf = (value: unknown) => (typeof value === 'number' || typeof value === 'string' ? String(value) : null);

@Injectable()
export class TelegramLinkService {
  constructor(private readonly prisma: PrismaService, private readonly bot: TelegramBotService) {}

  async status(userId: string) {
    const config = telegramConfig();
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { username: true, createdAt: true } });
    return { data: { configured: Boolean(config), botUsername: config?.botUsername ?? null, linked: Boolean(identity), username: identity?.username ?? null, linkedAt: identity?.createdAt ?? null } };
  }

  /** One-time code for the bot deep link. The bot never receives the BuildPath password or session. */
  async createLink(userId: string) {
    const config = telegramConfig();
    if (!config) throw new ServiceUnavailableException('TELEGRAM_NOT_CONFIGURED');
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.telegramLinkCode.create({ data: { userId, codeHash: digest(code), expiresAt } });
    return { data: { deepLink: `https://t.me/${config.botUsername}?start=${code}`, botUsername: config.botUsername, expiresAt } };
  }

  async unlink(userId: string) {
    await this.prisma.telegramChatState.deleteMany({ where: { userId } });
    const deleted = await this.prisma.externalIdentity.deleteMany({ where: { userId, provider: 'telegram' } });
    if (deleted.count === 0) throw new NotFoundException('TELEGRAM_NOT_LINKED');
  }

  /** Telegram webhook. Unknown or malformed updates are acknowledged and ignored. */
  async handleUpdate(secretHeader: string | undefined, update: unknown): Promise<boolean> {
    const config = telegramConfig();
    if (!config?.webhookSecret) return false;
    const expected = Buffer.from(config.webhookSecret);
    const actual = Buffer.from(secretHeader ?? '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    const callback = (update as TelegramUpdate)?.callback_query;
    if (callback) {
      const callbackId = idOf(callback.id);
      const fromId = idOf(callback.from?.id);
      const chat = idOf(callback.message?.chat?.id);
      if (!callbackId || !fromId || !chat || callback.message?.chat?.type !== 'private' || typeof callback.data !== 'string' || callback.data.length > 64) return true;
      const identity = await this.prisma.externalIdentity.findUnique({ where: { provider_externalId: { provider: 'telegram', externalId: fromId } }, select: { userId: true } });
      if (!identity) {
        await answerCallbackQuery(config, callbackId, 'Telegram не подключён к BuildPath');
        return true;
      }
      // Answer Telegram immediately; AI work can take longer than the webhook timeout.
      void this.bot.onCallback(identity.userId, chat, callbackId, callback.data).catch(() => undefined);
      return true;
    }
    const message = (update as TelegramUpdate)?.message;
    const chatId = message?.chat?.id;
    const fromId = message?.from?.id;
    if (message?.chat?.type !== 'private' || (typeof chatId !== 'number' && typeof chatId !== 'string') || (typeof fromId !== 'number' && typeof fromId !== 'string')) return true;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const reply = (value: string) => sendTelegramMessage(config, String(chatId), value);
    const username = typeof message.from?.username === 'string' ? message.from.username.slice(0, 64) : null;

    const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})$/);
    if (start) {
      const now = new Date();
      const linked = await this.prisma.$transaction(async (tx) => {
        const code = await tx.telegramLinkCode.findUnique({ where: { codeHash: digest(start[1]) }, select: { id: true, userId: true, expiresAt: true, usedAt: true } });
        if (!code || code.usedAt || code.expiresAt < now) return false;
        await tx.telegramLinkCode.update({ where: { id: code.id }, data: { usedAt: now } });
        // One Telegram account maps to one BuildPath account; relinking moves it.
        await tx.externalIdentity.deleteMany({ where: { provider: 'telegram', OR: [{ externalId: String(fromId) }, { userId: code.userId }] } });
        await tx.externalIdentity.create({ data: { userId: code.userId, provider: 'telegram', externalId: String(fromId), chatId: String(chatId), username } });
        return true;
      });
      await reply(linked
        ? 'Готово! Telegram привязан к вашему аккаунту BuildPath. Сюда будут приходить заявки с сайтов и уведомления о приёмке этапов. Наберите /projects, чтобы работать с проектами. Отключить: /stop'
        : 'Ссылка устарела или уже использована. Откройте BuildPath и нажмите «Подключить Telegram» ещё раз.');
      return true;
    }
    if (/^\/stop(?:@\w+)?$/.test(text)) {
      const deleted = await this.prisma.externalIdentity.deleteMany({ where: { provider: 'telegram', externalId: String(fromId) } });
      await this.prisma.telegramChatState.deleteMany({ where: { chatId: String(chatId) } });
      await reply(deleted.count ? 'Telegram отключён от BuildPath. Заявки сюда больше не придут.' : 'Этот Telegram не привязан к BuildPath.');
      return true;
    }
    const identity = await this.prisma.externalIdentity.findUnique({ where: { provider_externalId: { provider: 'telegram', externalId: String(fromId) } }, select: { userId: true } });
    if (identity) {
      const kind = typeof message.text === 'string' ? 'text' : message.voice || message.audio ? 'voice' : 'other';
      void this.bot.onMessage(identity.userId, String(chatId), typeof message.text === 'string' ? message.text : null, kind).catch(() => undefined);
      return true;
    }
    await reply('Это бот BuildPath. Здесь можно вести проекты и получать заявки с сайтов. Чтобы подключиться, откройте проект в BuildPath и нажмите «Подключить Telegram».');
    return true;
  }
}
