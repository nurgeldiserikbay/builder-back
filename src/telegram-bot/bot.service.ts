import { contentLocale, currentLocale, localizeDeep, runWithLocale, tr } from '../i18n/i18n.js';
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
    if (url.protocol === 'https:') { url.searchParams.set('tg', '1'); return { text: tr("📱 Открыть в приложении"), web_app: { url: url.toString() } }; }
    return { text: tr("📱 Открыть в приложении"), url: url.toString() };
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

  /** The bot answers in the language of the linked BuildPath account. */
  private async inUserLocale<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
    return runWithLocale(contentLocale(user?.locale), work);
  }

  async onMessage(userId: string, chatId: string, text: string | null, kind: 'text' | 'voice' | 'other') {
    return this.inUserLocale(userId, () => this.handleMessage(userId, chatId, text, kind));
  }

  private async handleMessage(userId: string, chatId: string, text: string | null, kind: 'text' | 'voice' | 'other') {
    const config = telegramConfig();
    if (!config) return;
    const ctx: Ctx = { config, chatId, userId };
    if (kind === 'voice') return void this.send(ctx, tr("Голосовые сообщения пока не поддерживаются — напишите, пожалуйста, текстом."));
    if (kind !== 'text' || !text) return void this.send(ctx, tr("Я понимаю только текст. Наберите /projects, чтобы открыть проекты."));
    const trimmed = text.trim();
    if (/^\/(projects|menu)(@\w+)?$/i.test(trimmed) || /^(проекты|projects)$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return this.guarded(ctx, () => this.showProjects(ctx)); }
    if (/^\/(help|start)(@\w+)?$/i.test(trimmed)) return void this.send(ctx, helpText(), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    if (/^\/cancel(@\w+)?$/i.test(trimmed) || /^(отмена|cancel)$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return void this.send(ctx, tr("Хорошо, отменил.")); }

    const state = await this.state(chatId);
    const pending = state && state.userId === userId && state.pending && state.pendingUntil && state.pendingUntil > new Date() ? state.pending as Pending : null;
    if (!pending || !state?.projectId || !state.stageKey) {
      return void this.send(ctx, tr("Чтобы что-то изменить, откройте этап и нажмите «Попросить ИИ». Наберите /projects, чтобы выбрать проект."), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    }
    if (trimmed.length < 2 || trimmed.length > 1000) return void this.send(ctx, tr("Напишите от 2 до 1000 символов или /cancel, чтобы отменить."));
    await this.setState(ctx, { pending: null });
    const { projectId, stageKey } = state;
    await this.guarded(ctx, async () => {
      if (pending === 'instruction') {
        await this.send(ctx, tr("✨ ИИ работает — обычно это занимает до минуты…"));
        const result = await this.journey.generate(userId, projectId, stageKey, { instruction: trimmed, saveAs: 'one_off', targetKey: null, source: 'telegram' });
        await this.send(ctx, tr("Готово: версия {0}.", [result.data.versionNumber]));
      } else if (pending === 'changes_note') {
        await this.journey.requestChanges(userId, projectId, stageKey, trimmed);
        await this.send(ctx, tr("↩️ Этап возвращён на доработку с вашим комментарием."));
      } else {
        await this.journey.suggest(userId, projectId, stageKey, { text: trimmed, targetKey: null });
        await this.send(ctx, tr("💬 Предложение отправлено ведущему этапа."));
      }
      await this.showStage(ctx, projectId, stageKey);
    });
  }

  async onCallback(userId: string, chatId: string, callbackId: string, data: string) {
    return this.inUserLocale(userId, () => this.handleCallback(userId, chatId, callbackId, data));
  }

  private async handleCallback(userId: string, chatId: string, callbackId: string, data: string) {
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
          await this.send(ctx, tr("Напишите одним сообщением, что изменить. Например: «Сделай текст первого экрана короче и теплее».\n\nОтменить — /cancel"));
          return;
        case 'R':
          await this.setState(ctx, { pending: 'changes_note' });
          await this.send(ctx, tr("Напишите, что нужно доработать. Специалист увидит этот комментарий.\n\nОтменить — /cancel"));
          return;
        case 'G':
          await this.setState(ctx, { pending: 'suggestion' });
          await this.send(ctx, tr("Напишите вашу правку. Ведущий этапа решит, отправить ли её ИИ.\n\nОтменить — /cancel"));
          return;
        case 'B': {
          const result = await this.journey.build(userId, projectId);
          const failed = localizeDeep(result.data.checks, currentLocale()).filter((check) => check.required && check.status === 'failed');
          await this.send(ctx, failed.length ? tr("Сайт собран, но не пройдены проверки: {0}.", [failed.map((check) => check.title).join(', ')]) : tr("Сайт собран, все обязательные проверки пройдены."));
          return this.showStage(ctx, projectId, stageKey);
        }
        case 'A': {
          if (!isUuid(arg)) return;
          const detail = localizeDeep((await this.journey.stage(userId, projectId, stageKey)).data, currentLocale());
          return void this.send(ctx, tr("Принять версию {0} этапа «{1}»? {2}", [detail.current?.versionNumber ?? '', detail.stage.title, detail.stage.acceptExplanation]),
            [[{ text: tr("✅ Да, принять"), callback_data: `OK:${arg}` }, { text: tr("Отмена"), callback_data: `S:${stageKey}` }]]);
        }
        case 'OK': {
          if (!isUuid(arg)) return;
          const journey = localizeDeep((await this.journey.accept(userId, projectId, stageKey, arg)).data, currentLocale());
          const next = journey.nextAction.stageKey;
          await this.send(ctx, next ? tr("✅ Этап принят. Дальше: «{0}».", [journey.nextAction.title]) : tr("✅ Этап принят."), next ? [[{ text: `➡️ ${journey.nextAction.title}`, callback_data: `S:${next}` }]] : undefined);
          return;
        }
        case 'AP': {
          if (!isUuid(arg)) return;
          const detail = localizeDeep((await this.journey.stage(userId, projectId, stageKey)).data, currentLocale());
          return void this.send(ctx, tr("Одобрить версию {0} этапа «{1}»? Одобрение записывается от вашего имени и относится только к этой версии.", [detail.current?.versionNumber ?? '', detail.stage.title]),
            [[{ text: tr("👍 Да, одобрить"), callback_data: `APK:${arg}` }, { text: tr("Отмена"), callback_data: `S:${stageKey}` }]]);
        }
        case 'APK': {
          if (!isUuid(arg)) return;
          const detail = localizeDeep((await this.journey.approve(userId, projectId, stageKey, arg, null)).data, currentLocale());
          await this.send(ctx, detail.stage.status === 'approved' ? tr("✅ Одобрено. Набраны все нужные одобрения — этап принят.") : tr("👍 Одобрено: {0} из {1}.", [detail.stage.approval.approved ?? 0, detail.stage.approval.required ?? 0]));
          return;
        }
        case 'U': {
          if (!isUuid(arg)) return;
          await this.journey.submit(userId, projectId, stageKey, arg);
          const policy = (await this.journey.stage(userId, projectId, stageKey)).data.stage.approval.policy;
          await this.send(ctx, policy ? tr("📤 Отправлено проверяющим. Пока они проверяют, этап нельзя менять.") : tr("📤 Отправлено владельцу на приёмку. Пока он проверяет, этап нельзя менять."));
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
    const assignments = localizeDeep((await this.specialists.mine(ctx.userId)).data, currentLocale());
    const keyboard: InlineKeyboard = memberProjects.map((project) => [{ text: `📁 ${project.name}`.slice(0, 60), callback_data: `P:${project.id}` }]);
    for (const item of assignments) {
      if (!memberProjects.some((project) => project.id === item.projectId) && !keyboard.some((row) => row[0].callback_data === `P:${item.projectId}`)) {
        keyboard.push([{ text: `🤝 ${item.projectName} · ${item.stageTitle}`.slice(0, 60), callback_data: `P:${item.projectId}` }]);
      }
    }
    if (!keyboard.length) {
      const button = this.appButton('/projects');
      return void this.send(ctx, tr("У вас пока нет проектов. Создайте первый в приложении — это займёт пару минут."), button ? [[button]] : undefined);
    }
    await this.send(ctx, tr("Ваши проекты. 🤝 — проекты, где вы помогаете как специалист."), keyboard);
  }

  private async showProject(ctx: Ctx, projectId: string) {
    const journey = localizeDeep((await this.journey.journey(ctx.userId, projectId)).data, currentLocale());
    const lines = [`📁 ${journey.project.name} — ${journey.project.typeTitle}`, tr("Принято этапов: {0} из {1}", [journey.progress.accepted, journey.progress.total]), '', journey.nextAction.text];
    const keyboard: InlineKeyboard = journey.stages.map((stage) => [{ text: `${statusEmoji[stage.status] ?? '•'} ${stage.title} — ${stage.statusLabel}`.slice(0, 60), callback_data: `S:${stage.key}` }]);
    const button = this.appButton(`/projects/${projectId}`);
    keyboard.push([...(button ? [button] : []), { text: tr("← Проекты"), callback_data: 'L' }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }

  private async showStage(ctx: Ctx, projectId: string, stageKey: string) {
    const detail = localizeDeep((await this.journey.stage(ctx.userId, projectId, stageKey)).data, currentLocale());
    const { stage, ai, current } = detail;
    const lines = [`${statusEmoji[stage.status] ?? '•'} ${stage.title} — ${stage.statusLabel}`, stage.statusExplanation];
    if (stage.reviewNote && stage.status === 'changes_requested') lines.push('', tr("Владелец просит: {0}", [stage.reviewNote]));
    if (current) {
      lines.push('', tr("Версия {0}", [current.versionNumber]));
      const summary = artifactSummary(stage.artifactType, current.content);
      if (summary) lines.push(summary);
    } else if (stage.status !== 'locked') {
      lines.push('', tr("Черновика пока нет."));
    }
    if (detail.issues.length) lines.push('', tr("Чего не хватает:"), ...[...new Set(detail.issues.map((issue) => `• ${issue.message}`))].slice(0, 5));
    const keyboard: InlineKeyboard = [];
    if (stage.canEdit && ai.level !== 'none' && ai.configured && stage.inputsReady) keyboard.push([{ text: tr("✨ Попросить ИИ"), callback_data: 'I' }]);
    if (stage.canEdit && stage.artifactType === 'site' && stage.inputsReady) keyboard.push([{ text: tr("🛠 Собрать сайт"), callback_data: 'B' }]);
    const failedChecks = stage.artifactType === 'site' && (current?.content as { checks?: Array<{ status: string; required: boolean }> } | undefined)?.checks?.some((check) => check.required && check.status === 'failed');
    if (stage.canAccept && current && !detail.issues.length && !failedChecks) keyboard.push([{ text: stage.status === 'stale' ? tr("✅ Подтвердить") : tr("✅ Принять"), callback_data: `A:${current.id}` }]);
    if (stage.canRequestChanges) keyboard.push([{ text: tr("↩️ Вернуть на доработку"), callback_data: 'R' }]);
    if (stage.approval.canApprove && current) keyboard.push([{ text: tr("👍 Одобрить"), callback_data: `AP:${current.id}` }]);
    if (stage.canSubmit && current && !detail.issues.length && stage.inputsReady) keyboard.push([{ text: tr("📤 Отправить на приёмку"), callback_data: `U:${current.id}` }]);
    if (stage.canSuggest) keyboard.push([{ text: tr("💬 Предложить правку"), callback_data: 'G' }]);
    const button = this.appButton(`/projects/${projectId}/stages/${stageKey}`);
    keyboard.push([...(button ? [button] : []), { text: tr("← Этапы"), callback_data: `P:${projectId}` }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }
}
