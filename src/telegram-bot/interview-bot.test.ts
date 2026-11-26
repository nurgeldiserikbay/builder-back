import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { JourneyService } from '../journey/journey.service.js';
import { ChangeNoticesService } from '../journey/change-notices.service.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { StageReviewService } from '../journey/stage-review.service.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { InterviewService } from '../journey/interview.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { TelegramBotService } from './bot.service.js';

/** «Разговор» in the Telegram chat — against DATABASE_URL; skipped without it. */
describe('«Разговор» in the bot (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM stage_interviews LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('starts from the stage, takes answers as messages, fills the form and opens the same talk in the app', { skip }, async () => {
    const sent: Array<{ text: string; buttons: string[]; apps: string[] }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        if ((request.url ?? '').endsWith('/sendMessage')) {
          const body = JSON.parse(raw);
          const buttons = (body.reply_markup?.inline_keyboard ?? []).flat() as Array<{ callback_data?: string; web_app?: { url: string } }>;
          sent.push({ text: body.text, buttons: buttons.map((button) => button.callback_data ?? ''), apps: buttons.flatMap((button) => (button.web_app ? [button.web_app.url] : [])) });
        }
        response.writeHead(200).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bp_bot', TELEGRAM_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, PUBLIC_APP_URL: 'https://app.example' });
    try {
      const billing = new BillingService(prisma!);
      const core = new JourneyCore(prisma!, billing);
      core.setProvider(null);
      const worktime = new WorktimeService(prisma!);
      const stageAi = new StageAiService(prisma!, core, worktime);
      const review = new StageReviewService(prisma!, core, stageAi);
      const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
      const bot = new TelegramBotService(prisma!, journey, {} as never, {} as never, {} as never, { forRecipient: async () => null } as never, review, new InterviewService(prisma!, core, worktime, stageAi));
      const email = `bot-talk-${randomUUID()}@test.local`;
      const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
      users.push(owner.id);
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
      const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Усы', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
      // The idea passport comes first on new routes; accepting it opens «Цель сайта».
      await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Усы', essence: 'Мужчины записываются на стрижку онлайн, а мастер видит записи на день', audience: 'Мужчины 20–45 лет', problem: 'Записи в мессенджере теряются', story: null, materials: null }, baseVersionId: null });
      await journey.accept(owner.id, projectId, 'story', (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'story' } })).currentVersionId!);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
      const chat = `chat-${randomUUID().slice(0, 8)}`;
      await bot.onCallback(owner.id, chat, 'q1', `P:${projectId}`);
      await bot.onCallback(owner.id, chat, 'q2', 'S:goal');
      await settle();
      assert.ok(sent.at(-1)!.buttons.includes('T'), 'the stage offers «💬 Разговор»');
      await bot.onCallback(owner.id, chat, 'q3', 'T');
      await settle();
      assert.match(sent.at(-1)!.text, /Название бизнеса/);
      assert.match(sent.at(-1)!.text, /Обязательные ответы: 0 из \d/);
      assert.ok(sent.at(-1)!.apps.some((url) => /\/stages\/goal\?talk=1&tg=1$/.test(url)), 'the same conversation opens in the Mini App');
      for (const answer of ['Барбершоп Усы', 'Стрижки и бритьё для мужчин', 'Мужчины 20–45 лет']) { await bot.onMessage(owner.id, chat, answer, 'text'); await settle(); }
      assert.ok(sent.at(-1)!.buttons.includes('TA'));
      const talk = await prisma!.stageInterview.findFirstOrThrow({ where: { projectId } });
      assert.equal((talk.extracted as Record<string, unknown>).businessName, 'Барбершоп Усы');
      await bot.onCallback(owner.id, chat, 'q4', 'TA');
      await settle();
      assert.ok(sent.some((item) => /ответы перенесены в форму, версия 1/.test(item.text)));
      const goal = await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'goal' } });
      assert.equal(((await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: goal.currentVersionId! } })).content as Record<string, unknown>).audience, 'Мужчины 20–45 лет');
      // After filling, a message is no longer an answer.
      await bot.onMessage(owner.id, chat, 'ещё что-то', 'text');
      await settle();
      assert.match(sent.at(-1)!.text, /Попросить ИИ/);
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
