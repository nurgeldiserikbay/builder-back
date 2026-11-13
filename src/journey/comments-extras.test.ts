import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { StageAiService } from './stage-ai.service.js';
import { WorktimeService } from './worktime.service.js';
import { CommentsService } from './comments.service.js';
import { StageFilesService } from '../analysis/stage-files.service.js';
import { TelegramBotService } from '../telegram-bot/bot.service.js';

/** Attachments and mentions in remarks, and remarks from the Telegram bot — against DATABASE_URL; skipped without it. */
describe('remarks: files, mentions and the bot (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT file_ids FROM stage_comments LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  async function user(label: string) {
    const email = `${label}-${randomUUID()}@test.local`;
    const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: label, locale: 'ru' } });
    users.push(created.id);
    return created;
  }
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('attaches stage files, names people, and works from Telegram', { skip }, async () => {
    const sent: Array<{ chat: string; text: string; buttons: string[] }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        if ((request.url ?? '').endsWith('/sendMessage')) {
          const body = JSON.parse(raw);
          sent.push({ chat: String(body.chat_id), text: body.text, buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((button: { callback_data?: string }) => button.callback_data ?? '') });
        }
        response.writeHead(200).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bp_bot', TELEGRAM_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, UPLOAD_MALWARE_SCAN: 'disabled' });
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    try {
      const billing = new BillingService(prisma!);
      const core = new JourneyCore(prisma!, billing);
      core.provider = null;
      const worktime = new WorktimeService(prisma!);
      const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core));
      const comments = new CommentsService(prisma!, core);
      const files = new StageFilesService(prisma!, core);
      const bot = new TelegramBotService(prisma!, journey, {} as never, comments);

      const owner = await user('owner');
      const writer = await user('writer');
      const outsider = await user('outsider');
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
      await prisma!.projectMember.createMany({ data: [{ projectId: project.id, userId: owner.id, role: 'owner' }, { projectId: project.id, userId: writer.id, role: 'contributor' }] });
      for (const [position, key] of ['goal', 'process', 'techplan', 'content', 'design', 'build'].entries()) await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: position === 0 ? 'in_progress' : 'locked' } });

      const pdf = await files.upload(owner.id, project.id, 'goal', { buffer: Buffer.from('%PDF-1.7 old brief'), size: 18, originalname: 'old.pdf' }, {});
      const listed = await comments.list(owner.id, project.id, 'goal');
      assert.deepEqual(listed.data.people.map((person) => person.id), [writer.id]);
      assert.deepEqual(listed.data.files.map((file) => file.name), ['old.pdf']);
      await assert.rejects(comments.add(owner.id, project.id, 'goal', { text: 'Смотри файл', targetKey: null, blocking: false, parentId: null, mentionUserIds: [outsider.id] }), /COMMENT_MENTIONS_INVALID/);
      await assert.rejects(comments.add(owner.id, project.id, 'goal', { text: 'Смотри файл', targetKey: null, blocking: false, parentId: null, fileIds: [randomUUID()] }), /FILE_NOT_FOUND/);
      const added = await comments.add(owner.id, project.id, 'goal', { text: 'Сверь с прошлым ТЗ', targetKey: null, blocking: false, parentId: null, fileIds: [pdf.data.createdId!], mentionUserIds: [writer.id] });
      const remark = added.data.comments.at(-1)!;
      assert.deepEqual(remark.attachments.map((file) => file.name), ['old.pdf']);
      assert.deepEqual(remark.mentions, ['writer']);
      // A deleted file stays visible as «deleted», the remark keeps its history.
      await files.remove(owner.id, project.id, 'goal', pdf.data.createdId!);
      const after = (await comments.list(writer.id, project.id, 'goal')).data.comments.at(-1)!;
      assert.deepEqual(after.attachments.map((file) => (file as { deleted?: boolean }).deleted === true), [true]);

      // From Telegram: the writer opens the stage, reads remarks and replies; a new remark; the owner closes it.
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      const wchat = `chat-${randomUUID().slice(0, 8)}`;
      await bot.onCallback(writer.id, wchat, 'q1', `P:${project.id}`);
      await bot.onCallback(writer.id, wchat, 'q2', 'S:goal');
      await settle();
      assert.ok(sent.at(-1)!.buttons.includes('C'));
      await bot.onCallback(writer.id, wchat, 'q3', 'C');
      await settle();
      assert.match(sent.at(-1)!.text, /Сверь с прошлым ТЗ/);
      assert.ok(sent.at(-1)!.buttons.includes(`CR:${remark.id}`));
      assert.ok(!sent.at(-1)!.buttons.includes(`CX:${remark.id}`));
      await bot.onCallback(writer.id, wchat, 'q4', `CR:${remark.id}`);
      await bot.onMessage(writer.id, wchat, 'Сверил, всё учтено', 'text');
      await bot.onCallback(writer.id, wchat, 'q5', 'CN');
      await bot.onMessage(writer.id, wchat, 'Добавьте адрес в контакты', 'text');
      await settle();
      const rows = await prisma!.stageComment.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(rows.map((row) => [row.text, row.parentId === remark.id]), [['Сверь с прошлым ТЗ', false], ['Сверил, всё учтено', true], ['Добавьте адрес в контакты', false]]);
      const ochat = `chat-${randomUUID().slice(0, 8)}`;
      await bot.onCallback(owner.id, ochat, 'q6', `P:${project.id}`);
      await bot.onCallback(owner.id, ochat, 'q7', 'S:goal');
      await bot.onCallback(owner.id, ochat, 'q8', `CX:${rows[2]!.id}`);
      await settle();
      assert.ok((await prisma!.stageComment.findUniqueOrThrow({ where: { id: rows[2]!.id } })).resolvedAt);
      // The owner may leave a blocking remark from the bot; the writer is not offered it.
      assert.ok(!sent.filter((item) => item.chat === wchat).some((item) => item.buttons.includes('CB')));
      await bot.onCallback(owner.id, ochat, 'q10', 'C');
      await settle();
      assert.ok(sent.at(-1)!.buttons.includes('CB'));
      await bot.onCallback(owner.id, ochat, 'q11', 'CB');
      await bot.onMessage(owner.id, ochat, 'Нет телефона в контактах', 'text');
      await settle();
      assert.equal((await prisma!.stageComment.findFirstOrThrow({ where: { projectId: project.id, text: 'Нет телефона в контактах' } })).blocking, true);
      // A voice message is not taken for a remark.
      await bot.onCallback(writer.id, wchat, 'q9', 'CN');
      await bot.onMessage(writer.id, wchat, null, 'voice', { fileId: 'f', duration: 3, size: 100 });
      await settle();
      assert.ok(sent.filter((item) => item.chat === wchat).some((item) => /Голосовые сообщения пока не поддерживаются|текстом/.test(item.text)));
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
