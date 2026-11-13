import { contentLocale, currentLocale, localizeDeep, runWithLocale, tr } from '../i18n/i18n.js';
import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { JourneyService } from '../journey/journey.service.js';
import { SpecialistsService } from '../journey/specialists.service.js';
import { COMMENT_LIMITS, CommentsService } from '../journey/comments.service.js';
import { StageFilesService } from '../analysis/stage-files.service.js';
import { OwnershipService } from '../team/ownership.service.js';
import { STAGE_FILE_LIMITS } from '../analysis/file-types.js';
import { answerCallbackQuery, downloadTelegramFile, sendTelegramMessage, telegramConfig, type InlineKeyboard, type TelegramConfig } from '../notifications/telegram.js';
import { transcribe, transcribeConfig, VOICE_LIMITS } from './transcribe.js';
import { artifactSummary, errorText, helpText, statusEmoji } from './bot-texts.js';

const PENDING_TTL_MS = 15 * 60 * 1000;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
type Pending = 'instruction' | 'changes_note' | 'suggestion' | 'comment' | 'blocker' | 'reply';
const PENDING_KINDS: Pending[] = ['instruction', 'changes_note', 'suggestion', 'comment', 'blocker', 'reply'];
/** Remarks are typed: for a reply the bot keeps the remark id in pendingText, where a voice message would keep its text. */
const TEXT_ONLY: Pending[] = ['comment', 'blocker', 'reply'];
/** «voice:<kind>» — recognised text waits for «Выполнить»; «voice_consent:<kind>» — a voice file waits for consent. */
type VoicePending = `voice:${Pending}` | `voice_consent:${Pending}` | `mention:${Pending}`;
/** A typed remark waiting for «Отправить» while the person picks whom to mention. */
type MentionDraft = { text: string; target: string | null; mentionIds: string[]; fileIds?: string[] };
/** A file sent to the bot: a document or the largest size of a photo. */
export type IncomingFile = { fileId: string; name: string; size: number | null };
const MENTION_BUTTONS = 10;
export type VoiceMessage = { fileId: string; duration: number; size: number | null };
type Ctx = { config: TelegramConfig; chatId: string; userId: string };

/**
 * Stage work from a linked Telegram chat. Every action goes through JourneyService with the linked account,
 * so the bot never grants more than the web app does (STAGE_WORK_MODEL.md, section 16).
 */
@Injectable()
export class TelegramBotService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService, private readonly specialists: SpecialistsService, private readonly comments: CommentsService, private readonly stageFiles: StageFilesService, private readonly ownership: OwnershipService) {}

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

  private async setState(ctx: Ctx, data: { projectId?: string | null; stageKey?: string | null; pending?: Pending | VoicePending | null; pendingText?: string | null; draft?: MentionDraft | null }) {
    const pending = data.pending === undefined ? undefined : data.pending;
    await this.prisma.telegramChatState.upsert({
      where: { chatId: ctx.chatId },
      create: { chatId: ctx.chatId, userId: ctx.userId, projectId: data.projectId ?? null, stageKey: data.stageKey ?? null, pending: pending ?? null, pendingUntil: pending ? new Date(Date.now() + PENDING_TTL_MS) : null, pendingText: data.pendingText ?? null, pendingDraft: (data.draft ?? undefined) as never },
      update: {
        userId: ctx.userId,
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data.stageKey !== undefined ? { stageKey: data.stageKey } : {}),
        ...(pending !== undefined ? { pending, pendingUntil: pending ? new Date(Date.now() + PENDING_TTL_MS) : null, pendingText: data.pendingText ?? null, pendingDraft: (data.draft ?? Prisma.DbNull) as never } : {}),
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

  async onMessage(userId: string, chatId: string, text: string | null, kind: 'text' | 'voice' | 'file' | 'other', media?: VoiceMessage | IncomingFile) {
    return this.inUserLocale(userId, () => (kind === 'file' ? this.handleFileMessage(userId, chatId, text, media as IncomingFile | undefined) : this.handleMessage(userId, chatId, text, kind, media as VoiceMessage | undefined)));
  }

  /** What the bot is waiting for in this chat, if anything: the kind of text and whether a voice step is in between. */
  private async waiting(chatId: string, userId: string) {
    const state = await this.state(chatId);
    if (!state || state.userId !== userId || !state.pending || !state.pendingUntil || state.pendingUntil <= new Date() || !state.projectId || !state.stageKey) return null;
    const [step, kind] = state.pending.includes(':') ? state.pending.split(':') as [string, Pending] : [null, state.pending as Pending];
    if (!PENDING_KINDS.includes(kind)) return null;
    return { state, projectId: state.projectId, stageKey: state.stageKey, kind, step: step as 'voice' | 'voice_consent' | 'mention' | null };
  }

  private async handleVoice(ctx: Ctx, voice: VoiceMessage | undefined) {
    if (!transcribeConfig() || !voice) return void this.send(ctx, tr("Голосовые сообщения пока не поддерживаются — напишите, пожалуйста, текстом."));
    const waiting = await this.waiting(ctx.chatId, ctx.userId);
    // Voice is only recognised when the bot waits for a text, so nothing is sent to the provider by accident.
    if (!waiting) return void this.send(ctx, tr("Голосом можно ответить, когда бот ждёт ваш текст: откройте этап и нажмите «Попросить ИИ». Наберите /projects, чтобы выбрать проект."), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    if (TEXT_ONLY.includes(waiting.kind)) return void this.send(ctx, tr("Замечание напишите, пожалуйста, текстом."));
    if (voice.duration > VOICE_LIMITS.seconds || (voice.size ?? 0) > VOICE_LIMITS.bytes) return void this.send(ctx, tr("Голосовое длиннее {0} секунд — скажите короче или напишите текстом.", [VOICE_LIMITS.seconds]));
    const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { voiceConsentAt: true } });
    if (!user?.voiceConsentAt) {
      await this.setState(ctx, { pending: `voice_consent:${waiting.kind}`, pendingText: voice.fileId });
      return void this.send(ctx, tr("Чтобы понять голосовое, бот отправит запись в сервис распознавания речи OpenAI (США). Запись не хранится: остаётся только текст, который вы увидите и подтвердите. Разрешить?"),
        [[{ text: tr("✅ Разрешить"), callback_data: 'VC' }, { text: tr("Отмена"), callback_data: `S:${waiting.stageKey}` }]]);
    }
    return this.recognise(ctx, waiting.projectId, waiting.stageKey, waiting.kind, voice.fileId);
  }

  private async recognise(ctx: Ctx, projectId: string, stageKey: string, kind: Pending, fileId: string) {
    const config = transcribeConfig();
    if (!config) return void this.send(ctx, tr("Голосовые сообщения пока не поддерживаются — напишите, пожалуйста, текстом."));
    const today = await this.prisma.projectEvent.count({ where: { actorUserId: ctx.userId, type: 'voice_transcribed', createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (today >= VOICE_LIMITS.perDay) return void this.send(ctx, tr("На сегодня лимит голосовых исчерпан — напишите, пожалуйста, текстом."));
    await this.send(ctx, tr("🎙 Слушаю…"));
    const audio = await downloadTelegramFile(ctx.config, fileId, VOICE_LIMITS.bytes);
    const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { locale: true } });
    const text = audio ? await transcribe(config, audio, user?.locale === 'en' ? 'en' : user?.locale === 'kk' ? 'kk' : 'ru') : null;
    if (!text) { await this.setState(ctx, { pending: kind }); return void this.send(ctx, tr("Не получилось разобрать голосовое. Скажите ещё раз или напишите текстом.")); }
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: ctx.userId, type: 'voice_transcribed', stageKey, details: { kind, characters: text.length } } });
    const clipped = text.slice(0, 1000);
    await this.setState(ctx, { pending: `voice:${kind}`, pendingText: clipped });
    return void this.send(ctx, tr("Я услышал:\n«{0}»\n\nВыполнить?", [clipped]),
      [[{ text: tr("✅ Выполнить"), callback_data: 'VY' }, { text: tr("✏️ Написать текстом"), callback_data: 'VE' }], [{ text: tr("Отмена"), callback_data: `S:${stageKey}` }]]);
  }

  private async handleMessage(userId: string, chatId: string, text: string | null, kind: 'text' | 'voice' | 'other', voice?: VoiceMessage) {
    const config = telegramConfig();
    if (!config) return;
    const ctx: Ctx = { config, chatId, userId };
    if (kind === 'voice') return this.guarded(ctx, () => this.handleVoice(ctx, voice));
    if (kind !== 'text' || !text) return void this.send(ctx, tr("Я понимаю только текст. Наберите /projects, чтобы открыть проекты."));
    const trimmed = text.trim();
    if (/^\/(projects|menu)(@\w+)?$/i.test(trimmed) || /^(проекты|projects)$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return this.guarded(ctx, () => this.showProjects(ctx)); }
    if (/^\/(help|start)(@\w+)?$/i.test(trimmed)) return void this.send(ctx, helpText(), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    if (/^\/cancel(@\w+)?$/i.test(trimmed) || /^(отмена|cancel)$/i.test(trimmed)) { await this.setState(ctx, { pending: null }); return void this.send(ctx, tr("Хорошо, отменил.")); }

    // A typed message answers what the bot waits for, also instead of a recognised voice message.
    const waiting = await this.waiting(chatId, userId);
    if (!waiting) {
      return void this.send(ctx, tr("Чтобы что-то изменить, откройте этап и нажмите «Попросить ИИ». Наберите /projects, чтобы выбрать проект."), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    }
    if (waiting.step === 'mention') return void this.send(ctx, tr("Замечание уже написано: отметьте, кого упомянуть, и нажмите «Отправить» — или /cancel, чтобы отменить."));
    if (trimmed.length < 2 || trimmed.length > 1000) return void this.send(ctx, tr("Напишите от 2 до 1000 символов или /cancel, чтобы отменить."));
    const target = waiting.kind === 'reply' ? waiting.state.pendingText : null;
    const fileIds = (waiting.state.pendingDraft as MentionDraft | null)?.fileIds ?? [];
    await this.setState(ctx, { pending: null });
    await this.act(ctx, waiting.projectId, waiting.stageKey, waiting.kind, trimmed, target, fileIds);
  }

  /** Does what the person asked for with the text they typed or confirmed after a voice message. */
  private async act(ctx: Ctx, projectId: string, stageKey: string, pending: Pending, trimmed: string, target: string | null = null, fileIds: string[] = []) {
    const userId = ctx.userId;
    await this.guarded(ctx, async () => {
      if (pending === 'instruction') {
        await this.send(ctx, tr("✨ ИИ работает — обычно это занимает до минуты…"));
        const result = await this.journey.generate(userId, projectId, stageKey, { instruction: trimmed, saveAs: 'one_off', targetKey: null, source: 'telegram' });
        await this.send(ctx, tr("Готово: версия {0}.", [result.data.versionNumber]));
      } else if (pending === 'changes_note') {
        await this.journey.requestChanges(userId, projectId, stageKey, trimmed);
        await this.send(ctx, tr("↩️ Этап возвращён на доработку с вашим комментарием."));
      } else if (pending === 'comment' || pending === 'blocker' || pending === 'reply') {
        // People the person may mention (participants and the stage's specialists): pick them before the remark goes out.
        const people = (await this.comments.list(userId, projectId, stageKey)).data.people;
        if (people.length) return this.askMentions(ctx, pending, { text: trimmed, target, mentionIds: [], fileIds }, people);
        await this.comments.add(userId, projectId, stageKey, { text: trimmed, targetKey: null, blocking: pending === 'blocker', parentId: pending === 'reply' ? target : null, fileIds });
        await this.send(ctx, pending === 'reply' ? tr("💬 Ответ добавлен.") : pending === 'blocker' ? tr("⛔ Блокирующее замечание добавлено: этап нельзя принять, пока его не закроют.") : tr("💬 Замечание добавлено. Участники этапа получат уведомление."));
        return this.showComments(ctx, projectId, stageKey);
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
    if (action === 'VC' || action === 'VY' || action === 'VE') return this.guarded(ctx, () => this.voiceCallback(ctx, action));
    // Access is checked by JourneyService before the chat context is saved.
    // A project offered to this person: read it, accept (after one more tap) or decline — same checks as in the app.
    if ((action === 'OT' || action === 'OA' || action === 'OY' || action === 'OD') && isUuid(arg)) return this.guarded(ctx, () => this.transferCallback(ctx, action, arg));
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
          const blocking = result.data.quality.findings.filter((finding) => finding.blocking);
          await this.send(ctx, failed.length || blocking.length ? tr("Сайт собран, но не пройдены проверки: {0}.", [[...failed.map((check) => check.title), ...blocking.map((finding) => finding.title)].join(', ')]) : tr("Сайт собран, все обязательные проверки пройдены."));
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
        case 'C':
          return this.showComments(ctx, projectId, stageKey);
        case 'CN':
          await this.setState(ctx, { pending: 'comment' });
          await this.send(ctx, tr("Напишите замечание к этапу одним сообщением. Замечание к отдельной части и с файлами можно оставить в приложении.\n\nОтменить — /cancel"));
          return;
        case 'CB':
          await this.setState(ctx, { pending: 'blocker' });
          await this.send(ctx, tr("Напишите блокирующее замечание: пока его не закроют, этап нельзя принять или одобрить.\n\nОтменить — /cancel"));
          return;
        case 'CR':
          if (!isUuid(arg)) return;
          await this.setState(ctx, { pending: 'reply', pendingText: arg });
          await this.send(ctx, tr("Напишите ответ одним сообщением.\n\nОтменить — /cancel"));
          return;
        case 'MT':
        case 'MS':
          return this.mentionCallback(ctx, projectId, stageKey, action, arg);
        case 'CX':
          if (!isUuid(arg)) return;
          await this.comments.resolve(userId, projectId, stageKey, arg, true);
          await this.send(ctx, tr("✅ Замечание закрыто."));
          return this.showComments(ctx, projectId, stageKey);
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

  private async voiceCallback(ctx: Ctx, action: 'VC' | 'VY' | 'VE') {
    const waiting = await this.waiting(ctx.chatId, ctx.userId);
    if (!waiting || !waiting.step) return void this.send(ctx, tr("Это голосовое уже неактуально. Наберите /projects, чтобы продолжить."));
    if (action === 'VE') { await this.setState(ctx, { pending: waiting.kind }); return void this.send(ctx, tr("Хорошо, напишите текстом.\n\nОтменить — /cancel")); }
    if (action === 'VC' && waiting.step === 'voice_consent' && waiting.state.pendingText) {
      await this.prisma.user.update({ where: { id: ctx.userId }, data: { voiceConsentAt: new Date() } });
      await this.prisma.projectEvent.create({ data: { projectId: waiting.projectId, actorUserId: ctx.userId, type: 'voice_consent_given', stageKey: waiting.stageKey, details: {} } });
      return this.recognise(ctx, waiting.projectId, waiting.stageKey, waiting.kind, waiting.state.pendingText);
    }
    if (action === 'VY' && waiting.step === 'voice' && waiting.state.pendingText) {
      await this.setState(ctx, { pending: null });
      return this.act(ctx, waiting.projectId, waiting.stageKey, waiting.kind, waiting.state.pendingText);
    }
    return void this.send(ctx, tr("Это голосовое уже неактуально. Наберите /projects, чтобы продолжить."));
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
    const offered = await this.ownership.forRecipient(ctx.userId, projectId).catch(() => null);
    if (offered) keyboard.unshift([{ text: tr("📦 Вам предлагают стать владельцем"), callback_data: `OT:${projectId}` }]);
    const button = this.appButton(`/projects/${projectId}`);
    keyboard.push([...(button ? [button] : []), { text: tr("← Проекты"), callback_data: 'L' }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }

  private async transferCallback(ctx: Ctx, action: 'OT' | 'OA' | 'OY' | 'OD', projectId: string) {
    if (action === 'OD') {
      await this.ownership.decline(ctx.userId, projectId);
      return void this.send(ctx, tr("Вы отказались. Проект остаётся у прежнего владельца, он получит уведомление."));
    }
    if (action === 'OY') {
      await this.ownership.accept(ctx.userId, projectId);
      await this.send(ctx, tr("✅ Теперь вы владелец проекта."));
      return this.showProject(ctx, projectId);
    }
    const offer = await this.ownership.forRecipient(ctx.userId, projectId);
    if (!offer) return void this.send(ctx, tr("Этого предложения больше нет: его отменили, оно истекло или уже решено."));
    const until = offer.expiresAt.toLocaleDateString(currentLocale() === 'en' ? 'en-GB' : 'ru-RU');
    if (action === 'OA') {
      return void this.send(ctx, tr("Точно стать владельцем проекта «{0}»? Это действие не отменить из бота: вернуть проект можно только новой передачей.", [offer.projectName]),
        [[{ text: tr("✅ Да, стать владельцем"), callback_data: `OY:${projectId}` }], [{ text: tr("Назад"), callback_data: `OT:${projectId}` }]]);
    }
    const lines = [
      tr("📦 {0} предлагает передать вам проект «{1}».", [offer.fromName, offer.projectName]), '',
      tr("Если вы согласитесь, проект перейдёт в ваш аккаунт и будет считаться в вашем тарифе: место проекта, опубликованный сайт и команда. Запросы к ИИ, будущие оплаты специалистам и публикация — от вашего имени."),
      offer.keepAccess ? tr("Прежний владелец останется в команде администратором — вы сможете это изменить.") : tr("Прежний владелец потеряет доступ к проекту."),
      tr("Предложение действует до {0}.", [until]),
    ];
    if (offer.blockers.length) lines.push('', tr("Сейчас принять нельзя:"), ...offer.blockers.map((text) => `• ${text}`));
    const keyboard: InlineKeyboard = [];
    if (!offer.blockers.length) keyboard.push([{ text: tr("✅ Стать владельцем"), callback_data: `OA:${projectId}` }]);
    keyboard.push([{ text: tr("Отказаться"), callback_data: `OD:${projectId}` }]);
    const button = this.appButton(`/projects/${projectId}#team`);
    if (button) keyboard.push([button]);
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
    if (stage.status !== 'locked') keyboard.push([{ text: stage.blockingComments ? tr("📝 Замечания · блокирующих: {0}", [stage.blockingComments]) : tr("📝 Замечания"), callback_data: 'C' }]);
    const button = this.appButton(`/projects/${projectId}/stages/${stageKey}`);
    keyboard.push([...(button ? [button] : []), { text: tr("← Этапы"), callback_data: `P:${projectId}` }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }

  /**
   * A document or photo while the bot waits for a remark: it is stored as a file of the stage (the same checks as an
   * upload in the app — type by content, size, antivirus, limits) and attached to the remark. A caption is the remark.
   */
  private async handleFileMessage(userId: string, chatId: string, caption: string | null, file: IncomingFile | undefined) {
    const config = telegramConfig();
    if (!config || !file) return;
    const ctx: Ctx = { config, chatId, userId };
    const waiting = await this.waiting(chatId, userId);
    if (!waiting || !TEXT_ONLY.includes(waiting.kind)) return void this.send(ctx, tr("Файл можно прикрепить к замечанию: откройте этап, нажмите «📝 Замечания» и «➕ Новое замечание», затем пришлите файл."), [[{ text: tr("📂 Мои проекты"), callback_data: 'L' }]]);
    const draft: MentionDraft = (waiting.state.pendingDraft as MentionDraft | null) ?? { text: '', target: waiting.kind === 'reply' ? waiting.state.pendingText : null, mentionIds: [], fileIds: [] };
    const fileIds = draft.fileIds ?? [];
    if (fileIds.length >= COMMENT_LIMITS.files) return void this.send(ctx, tr("К одному замечанию можно прикрепить не больше {0} файлов.", [COMMENT_LIMITS.files]));
    if ((file.size ?? 0) > STAGE_FILE_LIMITS.fileBytes) return void this.send(ctx, tr("Файл больше {0} МБ — такие файлы к этапу не прикрепить.", [Math.round(STAGE_FILE_LIMITS.fileBytes / 1024 / 1024)]));
    await this.guarded(ctx, async () => {
      // Checked before downloading, so a file nobody may store here is not fetched at all.
      if (!(await this.stageFiles.list(userId, waiting.projectId, waiting.stageKey)).data.canUpload) return void this.send(ctx, tr("Прикреплять новые файлы может тот, кто может менять этап. Напишите замечание текстом."));
      const data = await downloadTelegramFile(config, file.fileId, STAGE_FILE_LIMITS.fileBytes);
      if (!data) return void this.send(ctx, tr("Не получилось получить файл из Telegram. Пришлите его ещё раз."));
      const stored = await this.stageFiles.upload(userId, waiting.projectId, waiting.stageKey, { buffer: data, size: data.length, originalname: file.name }, {});
      const next: MentionDraft = { ...draft, fileIds: [...fileIds, stored.data.createdId!] };
      const name = stored.data.files.find((item: { id: string }) => item.id === stored.data.createdId)?.name ?? file.name;
      const text = (caption ?? '').trim();
      if (waiting.step === 'mention') {
        // The remark is already written: the file joins it.
        const people = (await this.comments.list(userId, waiting.projectId, waiting.stageKey)).data.people;
        await this.send(ctx, tr("📎 «{0}» будет прикреплён к замечанию.", [name]));
        return this.askMentions(ctx, waiting.kind, next, people);
      }
      if (text.length >= 2 && text.length <= 1000) {
        await this.setState(ctx, { pending: null });
        return this.act(ctx, waiting.projectId, waiting.stageKey, waiting.kind, text, next.target, next.fileIds);
      }
      await this.setState(ctx, { pending: waiting.kind, pendingText: waiting.state.pendingText, draft: next });
      await this.send(ctx, tr("📎 «{0}» сохранён в файлах этапа и будет прикреплён к замечанию. Напишите текст замечания или пришлите ещё файл.\n\nОтменить — /cancel", [name]));
    });
  }

  /** Shows who can be mentioned; a tap toggles a person, «Отправить» posts the remark with them. */
  private async askMentions(ctx: Ctx, kind: Pending, draft: MentionDraft, people: Array<{ id: string; name: string }>) {
    await this.setState(ctx, { pending: `mention:${kind}`, draft });
    const shown = people.slice(0, MENTION_BUTTONS);
    const keyboard: InlineKeyboard = [];
    for (let index = 0; index < shown.length; index += 2) {
      keyboard.push(shown.slice(index, index + 2).map((person, offset) => ({ text: `${draft.mentionIds.includes(person.id) ? '☑️' : '⬜'} ${person.name}`.slice(0, 60), callback_data: `MT:${index + offset}` })));
    }
    keyboard.push([{ text: draft.mentionIds.length ? tr("📨 Отправить, упомянуть: {0}", [draft.mentionIds.length]) : tr("📨 Отправить без упоминаний"), callback_data: 'MS' }]);
    await this.send(ctx, tr("Кого упомянуть? Упомянутые получат отдельное уведомление. Отметьте людей и нажмите «Отправить».\n\nОтменить — /cancel"), keyboard);
  }

  private async mentionCallback(ctx: Ctx, projectId: string, stageKey: string, action: 'MT' | 'MS', arg: string) {
    const waiting = await this.waiting(ctx.chatId, ctx.userId);
    const draft = waiting?.step === 'mention' ? (waiting.state.pendingDraft as MentionDraft | null) : null;
    if (!waiting || !draft || waiting.projectId !== projectId || waiting.stageKey !== stageKey) return void this.send(ctx, tr("Это замечание уже отправлено или отменено. Откройте замечания этапа заново."));
    const people = (await this.comments.list(ctx.userId, projectId, stageKey)).data.people;
    if (action === 'MT') {
      const person = /^\d{1,2}$/.test(arg) ? people.slice(0, MENTION_BUTTONS)[Number(arg)] : undefined;
      if (!person) return this.askMentions(ctx, waiting.kind, draft, people);
      const mentionIds = draft.mentionIds.includes(person.id) ? draft.mentionIds.filter((id) => id !== person.id) : [...draft.mentionIds, person.id];
      return this.askMentions(ctx, waiting.kind, { ...draft, mentionIds }, people);
    }
    await this.setState(ctx, { pending: null });
    const kind = waiting.kind;
    // Someone who left the stage since is dropped rather than failing the whole remark.
    const allowed = new Set(people.map((person) => person.id));
    const mentionUserIds = draft.mentionIds.filter((id) => allowed.has(id));
    await this.comments.add(ctx.userId, projectId, stageKey, { text: draft.text, targetKey: null, blocking: kind === 'blocker', parentId: kind === 'reply' ? draft.target : null, mentionUserIds, fileIds: draft.fileIds ?? [] });
    const done = kind === 'reply' ? tr("💬 Ответ добавлен.") : kind === 'blocker' ? tr("⛔ Блокирующее замечание добавлено: этап нельзя принять, пока его не закроют.") : tr("💬 Замечание добавлено. Участники этапа получат уведомление.");
    await this.send(ctx, mentionUserIds.length ? `${done} ${tr("Упомянуты: {0}.", [people.filter((person) => mentionUserIds.includes(person.id)).map((person) => person.name).join(', ')])}` : done);
    return this.showComments(ctx, projectId, stageKey);
  }

  /** Open remarks of the stage, newest last; reply, close (author, owner, manager) or write a new one. */
  private async showComments(ctx: Ctx, projectId: string, stageKey: string) {
    const list = (await this.comments.list(ctx.userId, projectId, stageKey)).data;
    const open = list.comments.filter((item) => !item.resolved).slice(-5);
    const lines = [list.open ? tr("Открытых замечаний: {0}.", [list.open]) : tr("Открытых замечаний нет.")];
    const keyboard: InlineKeyboard = [];
    open.forEach((item, index) => {
      const number = index + 1;
      const files = item.attachments.length ? ` 📎${item.attachments.length}` : '';
      lines.push('', `${number}. ${item.blocking ? '⛔ ' : ''}${item.author ?? ''}${item.versionNumber ? ` · ${tr('версия {0}', [item.versionNumber])}` : ''}${files}`, item.text.slice(0, 500));
      for (const reply of item.replies.slice(-2)) lines.push(`   ↳ ${reply.author ?? ''}: ${reply.text.slice(0, 200)}`);
      const row: InlineKeyboard[number] = [];
      if (list.canWrite) row.push({ text: tr("↩️ Ответить на {0}", [number]), callback_data: `CR:${item.id}` });
      if (item.canResolve) row.push({ text: tr("✅ Закрыть {0}", [number]), callback_data: `CX:${item.id}` });
      if (row.length) keyboard.push(row);
    });
    if (list.canWrite) keyboard.push([{ text: tr("➕ Новое замечание"), callback_data: 'CN' }, ...(list.canBlock ? [{ text: tr("⛔ Блокирующее"), callback_data: 'CB' }] : [])]);
    keyboard.push([{ text: tr("← Этап"), callback_data: `S:${stageKey}` }]);
    await this.send(ctx, lines.join('\n'), keyboard);
  }
}
