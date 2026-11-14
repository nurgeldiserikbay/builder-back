import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { TelegramBotService } from './bot.service.js';

/** Voice messages: consent, recognition and «Выполнить?» — against DATABASE_URL with stand-ins for Telegram and the provider. */
describe('bot voice messages (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT pending_text FROM telegram_chat_states LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('asks once for consent, shows what it heard and acts only after confirmation', { skip }, async () => {
    const sent: Array<{ text: string; buttons: string[] }> = [];
    const heard: string[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const url = request.url ?? '';
        if (url.endsWith('/sendMessage')) {
          const body = JSON.parse(raw);
          sent.push({ text: body.text, buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((button: { callback_data?: string }) => button.callback_data ?? '') });
          return response.writeHead(200).end('{"ok":true}');
        }
        if (url.endsWith('/answerCallbackQuery')) return response.writeHead(200).end('{"ok":true}');
        if (url.endsWith('/getFile')) return response.writeHead(200).end(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 3000 } }));
        if (url.includes('/file/bot')) return response.writeHead(200).end(Buffer.alloc(3000, 1));
        if (url.endsWith('/v1/audio/transcriptions')) { heard.push(raw.includes('name="model"') ? 'ok' : 'no-model'); return response.writeHead(200, { 'content-type': 'application/json' }).end('{"text":"  Сделай первый экран короче  "}'); }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bp_bot', TELEGRAM_API_BASE_URL: base, BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AI_OPENAI_BASE_URL: `${base}/v1`, BUILDER_AI_TRANSCRIBE_MODEL: 'whisper-test' });
    try {
      const email = `voice-${randomUUID()}@test.local`;
      const user = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'V', locale: 'ru' } });
      users.push(user.id);
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: user.id, name: 'W' } });
      const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: user.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing' } });
      const chatId = `chat-${randomUUID().slice(0, 8)}`;
      const bot = new TelegramBotService(prisma!, {} as never, {} as never, {} as never, {} as never, {} as never);
      const voice = { fileId: 'file-1', duration: 5, size: 3000 };
      // The bot does not wait for its own messages to be delivered; give the stand-in a moment.
      const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

      // Nothing is waiting for a text: the voice is not sent anywhere.
      await bot.onMessage(user.id, chatId, null, 'voice', voice);
      await settle();
      assert.match(sent.at(-1)!.text, /Голосом можно ответить/);
      assert.equal(heard.length, 0);

      await prisma!.telegramChatState.create({ data: { chatId, userId: user.id, projectId: project.id, stageKey: 'content', pending: 'instruction', pendingUntil: new Date(Date.now() + 600_000) } });
      // Too long a recording is refused before downloading.
      await bot.onMessage(user.id, chatId, null, 'voice', { ...voice, duration: 500 });
      await settle();
      assert.match(sent.at(-1)!.text, /длиннее 120 секунд/);

      await bot.onMessage(user.id, chatId, null, 'voice', voice);
      await settle();
      assert.match(sent.at(-1)!.text, /OpenAI \(США\)/);
      assert.deepEqual(sent.at(-1)!.buttons, ['VC', 'S:content']);
      assert.equal(heard.length, 0, 'nothing is sent before consent');

      await bot.onCallback(user.id, chatId, 'cb1', 'VC');
      await settle();
      assert.ok((await prisma!.user.findUniqueOrThrow({ where: { id: user.id } })).voiceConsentAt);
      assert.deepEqual(heard, ['ok']);
      assert.match(sent.at(-1)!.text, /Я услышал:\n«Сделай первый экран короче»\n\nВыполнить\?/);
      const state = await prisma!.telegramChatState.findUniqueOrThrow({ where: { chatId } });
      assert.deepEqual([state.pending, state.pendingText], ['voice:instruction', 'Сделай первый экран короче']);

      // «Написать текстом» goes back to waiting for a typed instruction.
      await bot.onCallback(user.id, chatId, 'cb2', 'VE');
      await settle();
      assert.equal((await prisma!.telegramChatState.findUniqueOrThrow({ where: { chatId } })).pending, 'instruction');
      // The second voice message needs no consent question.
      await bot.onMessage(user.id, chatId, null, 'voice', voice);
      await settle();
      assert.match(sent.at(-1)!.text, /Я услышал/);
      assert.equal(await prisma!.projectEvent.count({ where: { projectId: project.id, type: 'voice_transcribed' } }), 2);
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
