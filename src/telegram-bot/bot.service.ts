import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { SpecialistsService } from '../journey/specialists.service.js';
import { answerCallbackQuery, sendTelegramMessage, telegramConfig, type InlineKeyboard, type TelegramConfig } from '../notifications/telegram.js';
import { artifactSummary, errorText, helpText, statusEmoji } from './bot-texts.js';

const PENDING_TTL_MS = 15 * 60 * 1000;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
type Pending = 'instruction' | 'changes_note' | 'suggestion';
type Ctx = { config: TelegramConfig; chatId: string; userId: string };

/**
 * Stage work from a linked Telegram chat. Every action goes through JourneyService with the linked account,
 * so the bot never grants more than the web app does (STAGE_WORK_MODEL.md, section 16).
 */
@Injectable()
export class TelegramBotService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService, private readonly specialists: SpecialistsService) {}

  private send(ctx: Ctx, text: string, keyboard?: InlineKeyboard) {
    return sendTelegramMessage(ctx.config, ctx.chatId, text, fetch, keyboard);
  }

  private appButton(path: string): { text: string; url?: string; web_app?: { url: string } } | null {
    const base = process.env.PUBLIC_APP_URL;
    if (!base) return null;
    const url = new URL(path, base);
    // Mini App buttons require HTTPS; plain links are used in development.
    if (url.protocol === 'https:') { url.searchParams.set('tg', '1'); return { text: '📱 Открыть в приложении', web_app: { url: url.toString() } }; }
    return { text: '📱 Открыть в приложении', url: url.toString() };
  }

  private async state(chatId: string) {
    return this.prisma.telegramChatState.findUnique({ where: { chatId } });
  }

  private async setState(ctx: Ctx, data: { projectId?: string | null; stageKey?: string | null; pending?: Pending | null }) {
    const pending = data.pending === undefined ? undefined : data.pending;
    await this.prisma.telegramChatState.upsert({
      where: { chatId: ctx.chatId },
      create: { chatId: ctx.chatId, userId: ctx.userId, projectId: data.projectId ?? null, stageKey: data.stageKey ?? null, pending: pending ?? null, pendingUntil: pending ? new Date(Date.now() + PENDING_TTL_MS) : null },
      update: {
        userId: ctx.userId,
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data.stageKey !== undefined ? { stageKey: data.stageKey } : {}),
        ...(pending !== undefined ? { pending, pendingUntil: pending ? new Date(Date.now() + PENDING_TTL_MS) : null } : {}),
      },
    });
  }

  private async guarded(ctx: Ctx, action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      const code = error instanceof HttpException ? String((error.getResponse() as { message?: unknown })?.message ?? error.message) : 'FAILED';
      await this.send(ctx, errorText(code));
    }
  }

  async onMessage(userId: string, chatId: string, text: string | null, kind: 'text' | 'voice' | 'other') {
    const config = telegramConfig();
    if (!config) return;
    const ctx: Ctx = { config, chatId, userId };
    if (kind === 'voice') return void this.send(ctx, 'Голосовые сообщения пока не поддерживаются — напишите, пожалуйста, текстом.');
    if (kind !== 'text' || !text) return void this.send(ctx, 'Я понимаю только текст. Наберите /projects, чтобы открыть проекты.');
    const trimmed = text.trim();
    if (/^\/(projects|menu)(@\w+)?$/i.test(trimmed) || /^проекты$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return this.guarded(ctx, () => this.showProjects(ctx)); }
    if (/^\/(help|start)(@\w+)?$/i.test(trimmed)) return void this.send(ctx, helpText, [[{ text: '📂 Мои проекты', callback_data: 'L' }]]);
    if (/^\/cancel(@\w+)?$/i.test(trimmed) || /^отмена$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return void this.send(ctx, 'Хорошо, отменил.'); }

    const state = await this.state(chatId);
    const pending = state && state.userId === userId && state.pending && state.pendingUntil && state.pendingUntil > new Date() ? state.pending as Pending : null;
    if (!pending || !state?.projectId || !state.stageKey) {
      return void this.send(ctx, 'Чтобы что-то изменить, откройте этап и нажмите «Попросить ИИ». Наберите /projects, чтобы выбрать проект.', [[{ text: '📂 Мои проекты', callback_data: 'L' }]]);
    }
    if (trimmed.length < 2 || trimmed.length > 1000) return void this.send(ctx, 'Напишите от 2 до 1000 символов или /cancel, чтобы отменить.');
    await this.setState(ctx, { pending: null });
    const { projectId, stageKey } = state;
    await this.guarded(ctx, async () => {
      if (pending === 'instruction') {
        await this.send(ctx, '✨ ИИ работает — обычно это занимает до минуты…');
        const result = await this.journey.generate(userId, projectId, stageKey, { instruction: trimmed, saveAs: 'one_off', targetKey: null });
        await this.send(ctx, `Готово: версия ${result.data.versionNumber}.`);
      } else if (pending === 'changes_note') {
        await this.journey.requestChanges(userId, projectId, stageKey, trimmed);
        await this.send(ctx, '↩️ Этап возвращён на доработку с вашим комментарием.');
      } else {
        await this.journey.suggest(userId, projectId, stageKey, { text: trimmed, targetKey: null });
        await this.send(ctx, '💬 Предложение отправлено ведущему этапа.');
      }
      await this.showStage(ctx, projectId, stageKey);
    });
  }

  async onCallback(userId: string, chatId: string, callbackId: string, data: string) {
    const config = telegramConfig();
    if (!config) return;
    const ctx: Ctx = { config, chatId, userId };
    await answerCallbackQuery(config, callbackId);
    const [action, arg] = [data.slice(0, data.indexOf(':') >= 0 ? data.indexOf(':') : data.length), data.includes(':') ? data.slice(data.indexOf(':') + 1) : ''];
    if (action === 'L') return this.guarded(ctx, () => this.showProjects(ctx));
    // Access is checked by JourneyService before the chat context is saved.
    if (action === 'P' && isUuid(arg)) return this.guarded(ctx, async () => { await this.showProject(ctx, arg); await this.setState(ctx, { projectId: arg, stageKey: null, pending: null }); });
    const state = await this.state(chatId);
    if (!state || state.userId !== userId || !state.projectId) return this.guarded(ctx, () => this.showProjects(ctx));
    const projectId = state.projectId;
    if (action === 'S' && /^[a-z]{2,20}$/.test(arg)) return this.guarded(ctx, async () => { await this.showStage(ctx, projectId, arg); await this.setState(ctx, { stageKey: arg, pending: null }); });
    const stageKey = state.stageKey;
    if (!stageKey) return this.guarded(ctx, () => this.showProject(ctx, projectId));
    await this.guarded(ctx, async () => {
      switch (action) {
        case 'I':
          await this.setState(ctx, { pending: 'instruction' });
          await this.send(ctx, 'Напишите одним сообщением, что изменить. Например: «Сделай текст первого экрана короче и теплее».\n\nОтменить — /cancel');
          return;
        case 'R':
          await this.setState(ctx, { pending: 'changes_note' });
          await this.send(ctx, 'Напишите, что нужно доработать. Специалист увидит этот комментарий.\n\nОтменить — /cancel');
          return;
        case 'G':
          await this.setState(ctx, { pending: 'suggestion' });
          await this.send(ctx, 'Напишите вашу правку. Ведущий этапа решит, отправить ли её ИИ.\n\nОтменить — /cancel');
          return;
        case 'B': {
          const result = await this.journey.build(userId, projectId);
          const failed = result.data.checks.filter((check) => check.required && check.status === 'failed');
          await this.send(ctx, failed.length ? `Сайт собран, но не пройдены проверки: ${failed.map((check) => check.title).join(', ')}.` : 'Сайт собран, все обязательные проверки пройдены.');
          return this.showStage(ctx, projectId, stageKey);
        }
        case 'A': {
          if (!isUuid(arg)) return;
          const detail = (await this.journey.stage(userId, projectId, stageKey)).data;
          return void this.send(ctx, `Принять версию ${detail.current?.versionNumber ?? ''} этапа «${detail.stage.title}»? ${detail.stage.acceptExplanation}`,
            [[{ text: '✅ Да, принять', callback_data: `OK:${arg}` }, { text: 'Отмена', callback_data: `S:${stageKey}` }]]);
        }
        case 'OK': {
          if (!isUuid(arg)) return;
          const journey = (await this.journey.accept(userId, projectId, stageKey, arg)).data;
          const next = journey.nextAction.stageKey;
          await this.send(ctx, next ? `✅ Этап принят. Дальше: «${journey.nextAction.title}».` : '✅ Этап принят.', next ? [[{ text: `➡️ ${journey.nextAction.title}`, callback_data: `S:${next}` }]] : undefined);
          return;
        }
        case 'U': {
          if (!isUuid(arg)) return;
          await this.journey.submit(userId, projectId, stageKey, arg);
          await this.send(ctx, '📤 Отправлено владельцу на приёмку. Пока он проверяет, этап нельзя менять.');
          return;
        }
        default:
          return this.showStage(ctx, projectId, stageKey);
      }
    });
  }

  private async showProjects(ctx: Ctx) {
    const memberProjects = await this.prisma.project.findMany({
      where: { projectType: { not: null }, status: { not: 'archived' }, members: { some: { userId: ctx.userId, status: 'active' } } },
      orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, name: true },
    });
    const assignments = (await this.specialists.mine(ctx.userId)).data;
    const keyboard: InlineKeyboard = memberProjects.map((project) => [{ text: `📁 ${project.name}`.slice(0, 60), callback_data: `P:${project.id}` }]);
    for (const item of assignments) {
      if (!memberProjects.some((project) => project.id === item.projectId) && !keyboard.some((row) => row[0].callback_data === `P:${item.projectId}`)) {
        keyboard.push([{ text: `🤝 ${item.projectName} · ${item.stageTitle}`.slice(0, 60), callback_data: `P:${item.projectId}` }]);
      }
    }
    if (!keyboard.length) {
      const button = this.appButton('/projects');
      return void this.send(ctx, 'У вас пока нет проектов. Создайте первый в приложении — это займёт пару минут.', button ? [[button]] : undefined);
    }
    await this.send(ctx, 'Ваши проекты. 🤝 — проекты, где вы помогаете как специалист.', keyboard);
  }

  private async showProject(ctx: Ctx, projectId: string) {
    const journey = (await this.journey.journey(ctx.userId, projectId)).data;
    const lines = [`📁 ${journey.project.name} — ${journey.project.typeTitle}`, `Принято этапов: ${journey.progress.accepted} из ${journey.progress.total}`, '', journey.nextAction.text];
    const keyboard: InlineKeyboard = journey.stages.map((stage) => [{ text: `${statusEmoji[stage.status] ?? '•'} ${stage.title} — ${stage.statusLabel}`.slice(0, 60), callback_data: `S:${stage.key}` }]);
    const button = this.appButton(`/projects/${projectId}`);
    keyboard.push([...(button ? [button] : []), { text: '← Проекты', callback_data: 'L' }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }

  private async showStage(ctx: Ctx, projectId: string, stageKey: string) {
    const detail = (await this.journey.stage(ctx.userId, projectId, stageKey)).data;
    const { stage, ai, current } = detail;
    const lines = [`${statusEmoji[stage.status] ?? '•'} ${stage.title} — ${stage.statusLabel}`, stage.statusExplanation];
    if (stage.reviewNote && stage.status === 'changes_requested') lines.push('', `Владелец просит: ${stage.reviewNote}`);
    if (current) {
      lines.push('', `Версия ${current.versionNumber}`);
      const summary = artifactSummary(stage.artifactType, current.content);
      if (summary) lines.push(summary);
    } else if (stage.status !== 'locked') {
      lines.push('', 'Черновика пока нет.');
    }
    if (detail.issues.length) lines.push('', 'Чего не хватает:', ...[...new Set(detail.issues.map((issue) => `• ${issue.message}`))].slice(0, 5));
    const keyboard: InlineKeyboard = [];
    if (stage.canEdit && ai.level !== 'none' && ai.configured && stage.inputsReady) keyboard.push([{ text: '✨ Попросить ИИ', callback_data: 'I' }]);
    if (stage.canEdit && stage.artifactType === 'site' && stage.inputsReady) keyboard.push([{ text: '🛠 Собрать сайт', callback_data: 'B' }]);
    const failedChecks = stage.artifactType === 'site' && (current?.content as { checks?: Array<{ status: string; required: boolean }> } | undefined)?.checks?.some((check) => check.required && check.status === 'failed');
    if (stage.canAccept && current && !detail.issues.length && !failedChecks) keyboard.push([{ text: stage.status === 'stale' ? '✅ Подтвердить' : '✅ Принять', callback_data: `A:${current.id}` }]);
    if (stage.canRequestChanges) keyboard.push([{ text: '↩️ Вернуть на доработку', callback_data: 'R' }]);
    if (stage.canSubmit && current && !detail.issues.length && stage.inputsReady) keyboard.push([{ text: '📤 Отправить на приёмку', callback_data: `U:${current.id}` }]);
    if (stage.canSuggest) keyboard.push([{ text: '💬 Предложить правку', callback_data: 'G' }]);
    const button = this.appButton(`/projects/${projectId}/stages/${stageKey}`);
    keyboard.push([...(button ? [button] : []), { text: '← Этапы', callback_data: `P:${projectId}` }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }
}
