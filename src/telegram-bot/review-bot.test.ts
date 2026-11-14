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
import { CommentsService } from '../journey/comments.service.js';
import { StageFilesService } from '../analysis/stage-files.service.js';
import { TelegramBotService } from './bot.service.js';
import { templateProcess } from '../journey/process.js';

/** The quality review in the Telegram bot — against DATABASE_URL; skipped without it. */
describe('quality review in the bot (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT id FROM stage_review_overrides LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('shows findings, asks the AI to review and fix, and takes a written explanation', { skip }, async () => {
    const sent: Array<{ text: string; buttons: string[] }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        if ((request.url ?? '').endsWith('/sendMessage')) {
          const body = JSON.parse(raw);
          sent.push({ text: body.text, buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((button: { callback_data?: string }) => button.callback_data ?? '') });
        }
        response.writeHead(200).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bp_bot', TELEGRAM_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    try {
      const billing = new BillingService(prisma!);
      const core = new JourneyCore(prisma!, billing);
      const prompts: string[] = [];
      core.provider = {
        name: 'fake', model: 'fake-1',
        async generate(request) {
          prompts.push(request.user);
          if (request.schemaName.startsWith('buildpath_review_')) return { findings: [{ severity: 'important', category: 'logic', target: 'rules', where: 'Правила', message: 'Не сказано, сколько ждать ответа клиента.', fix: 'Добавьте срок ответа.' }] };
          return JSON.parse(request.user).currentDraft;
        },
      };
      const worktime = new WorktimeService(prisma!);
      const stageAi = new StageAiService(prisma!, core, worktime);
      const review = new StageReviewService(prisma!, core, stageAi);
      const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
      const bot = new TelegramBotService(prisma!, journey, {} as never, new CommentsService(prisma!, core), new StageFilesService(prisma!, core), { forRecipient: async () => null } as never, review);
      const email = `bot-review-${randomUUID()}@test.local`;
      const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
      users.push(owner.id);
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0', locale: 'ru' } });
      await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
      for (const [position, key] of ['goal', 'process', 'techplan', 'content', 'design', 'build'].entries()) await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: position === 0 ? 'approved' : position === 1 ? 'in_progress' : 'locked' } });
      // A process without the consent rule: a blocking finding.
      await journey.saveDraft(owner.id, project.id, 'process', { content: { ...templateProcess('landing', null), rules: [] }, baseVersionId: null });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      const chat = `chat-${randomUUID().slice(0, 8)}`;
      await bot.onCallback(owner.id, chat, 'q1', `P:${project.id}`);
      await bot.onCallback(owner.id, chat, 'q2', 'S:process');
      await settle();
      assert.match(sent.at(-1)!.text, /Проверка качества: \d+ из 100 · блокирующих: 1/);
      assert.ok(sent.at(-1)!.buttons.includes('Q'));
      assert.ok(!sent.at(-1)!.buttons.some((button) => button.startsWith('A:')), 'no «accept» while a blocker is open');
      await bot.onCallback(owner.id, chat, 'q3', 'Q');
      await settle();
      assert.match(sent.at(-1)!.text, /⛔ Правила: .*согласи/);
      assert.deepEqual(sent.at(-1)!.buttons, ['QF', 'QA', 'QO', 'S:process']);
      // The AI reviewer from the bot: its advice is listed separately.
      await bot.onCallback(owner.id, chat, 'q4', 'QA');
      await settle();
      assert.match(sent.at(-1)!.text, /Советы ИИ[\s\S]*сколько ждать ответа/);
      // An explanation that is too short is asked again; a proper one is saved and the stage can be accepted.
      await bot.onCallback(owner.id, chat, 'q5', 'QO');
      await bot.onMessage(owner.id, chat, 'надо', 'text');
      await settle();
      assert.match(sent.at(-1)!.text, /хотя бы одним понятным предложением/);
      await bot.onMessage(owner.id, chat, 'Согласие берём в WhatsApp, контакты на сайте не храним', 'text');
      await settle();
      assert.ok(sent.some((item) => /Объяснение сохранено/.test(item.text)));
      assert.ok(sent.at(-1)!.buttons.some((button) => button.startsWith('A:')), 'accept is offered now');
      const override = await prisma!.stageReviewOverride.findFirstOrThrow({ where: { projectId: project.id } });
      assert.deepEqual(override.findingIds, ['PROCESS_PERSONAL_DATA_NO_RULE:rules']);
      // «Fix» sends the open findings and the advice to the AI.
      await bot.onCallback(owner.id, chat, 'q6', 'Q');
      await bot.onCallback(owner.id, chat, 'q7', 'QF');
      await settle();
      assert.ok(sent.some((item) => /Готово: версия 2/.test(item.text)));
      assert.match(JSON.parse(prompts.at(-1)!).instruction, /сколько ждать ответа/);
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
