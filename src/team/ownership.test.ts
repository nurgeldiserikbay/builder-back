import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { OwnershipService } from './ownership.service.js';
import { TeamService } from './team.service.js';
import { TelegramBotService } from '../telegram-bot/bot.service.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Handing a project to another member — against DATABASE_URL; skipped without it. */
describe('ownership transfer (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM ownership_transfers LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  async function user(label: string, plan: string | null = 'start') {
    const email = `${label}-${randomUUID()}@test.local`;
    const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: label } });
    users.push(created.id);
    if (plan) await prisma!.accountPlan.create({ data: { userId: created.id, planKey: plan } });
    return created;
  }
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.accountPlan.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('offers, refuses while something is tied to the old owner, and moves the project when the recipient accepts', { skip }, async () => {
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    const billing = new BillingService(prisma!);
    const ownership = new OwnershipService(prisma!, billing);
    const team = new TeamService(prisma!, billing);
    const owner = await user('owner');
    const heir = await user('heir');
    const free = await user('free', null);
    const watcher = await user('watcher');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const heirSpace = await prisma!.workspace.create({ data: { ownerUserId: heir.id, name: 'H' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.createMany({ data: [
      { projectId: project.id, userId: owner.id, role: 'owner' }, { projectId: project.id, userId: heir.id, role: 'manager' },
      { projectId: project.id, userId: free.id, role: 'contributor' }, { projectId: project.id, userId: watcher.id, role: 'viewer' },
    ] });
    const memberId = async (userId: string) => (await prisma!.projectMember.findFirstOrThrow({ where: { projectId: project.id, userId } })).id;

    await assert.rejects(ownership.offer(heir.id, project.id, { toMemberId: await memberId(free.id), keepAccess: true, confirmName: 'Торты' }), /OWNERSHIP_OWNER_ONLY/);
    await assert.rejects(ownership.offer(owner.id, project.id, { toMemberId: await memberId(heir.id), keepAccess: true, confirmName: 'Торт' }), /OWNERSHIP_CONFIRM_NAME/);
    await assert.rejects(ownership.offer(owner.id, project.id, { toMemberId: await memberId(watcher.id), keepAccess: true, confirmName: 'Торты' }), /OWNERSHIP_TARGET_VIEWER/);

    // A connected repository carries the old owner's token: it blocks until disconnected.
    await prisma!.codeRepository.create({ data: { projectId: project.id, provider: 'github', baseUrl: 'https://github.com', repoPath: 'o/r', webUrl: 'https://github.com/o/r', defaultBranch: 'main', isPrivate: true, tokenEncrypted: 'x', tokenHint: 'abcd', connectedVia: 'token', connectedByUserId: owner.id, verifiedAt: new Date() } });
    assert.deepEqual((await ownership.view(owner.id, project.id, 'owner')).blockers.map((item) => item.code), ['REPOSITORY_CONNECTED']);
    await assert.rejects(ownership.offer(owner.id, project.id, { toMemberId: await memberId(heir.id), keepAccess: true, confirmName: 'Торты' }), /OWNERSHIP_BLOCKED/);
    await prisma!.codeRepository.delete({ where: { projectId: project.id } });

    // A free-plan recipient cannot take a project with a team.
    await ownership.offer(owner.id, project.id, { toMemberId: await memberId(free.id), keepAccess: true, confirmName: ' Торты ' });
    await assert.rejects(ownership.offer(owner.id, project.id, { toMemberId: await memberId(heir.id), keepAccess: true, confirmName: 'Торты' }), /OWNERSHIP_OFFER_OPEN/);
    assert.equal((await ownership.view(heir.id, project.id, 'manager')).offer, null);
    assert.equal((await ownership.view(free.id, project.id, 'contributor')).offer?.forYou, true);
    await assert.rejects(ownership.accept(heir.id, project.id), /OWNERSHIP_OFFER_NOT_FOUND/);
    await assert.rejects(ownership.accept(free.id, project.id), /PLAN_NO_TEAM/);
    await ownership.decline(free.id, project.id);

    await ownership.offer(owner.id, project.id, { toMemberId: await memberId(heir.id), keepAccess: true, confirmName: 'Торты' });
    await ownership.accept(heir.id, project.id);
    const moved = await prisma!.project.findUniqueOrThrow({ where: { id: project.id } });
    assert.equal(moved.ownerUserId, heir.id);
    assert.equal(moved.workspaceId, heirSpace.id);
    const roles = Object.fromEntries((await prisma!.projectMember.findMany({ where: { projectId: project.id } })).map((row) => [row.userId, `${row.role}:${row.status}`]));
    assert.equal(roles[heir.id], 'owner:active');
    assert.equal(roles[owner.id], 'manager:active');
    assert.equal((await team.list(heir.id, project.id)).data.viewerRole, 'owner');
    await assert.rejects(ownership.accept(heir.id, project.id), /OWNERSHIP_OFFER_NOT_FOUND/);
    const events = await prisma!.projectEvent.findMany({ where: { projectId: project.id, type: { startsWith: 'ownership_' } }, select: { type: true } });
    assert.deepEqual(events.map((event) => event.type).sort(), ['ownership_declined', 'ownership_offered', 'ownership_offered', 'ownership_transferred']);

    // Leaving entirely: the previous owner loses access.
    await ownership.offer(heir.id, project.id, { toMemberId: await memberId(owner.id), keepAccess: false, confirmName: 'Торты' });
    await ownership.accept(owner.id, project.id);
    assert.equal((await prisma!.projectMember.findFirstOrThrow({ where: { projectId: project.id, userId: heir.id } })).status, 'revoked');
  });
  it('the recipient reads, accepts or declines the offer in Telegram', { skip }, async () => {
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
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bp_bot', TELEGRAM_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; delete process.env.PUBLIC_APP_URL;
    try {
      const billing = new BillingService(prisma!);
      const ownership = new OwnershipService(prisma!, billing);
      const journey = { journey: async () => ({ data: { project: { name: 'Кафе', typeTitle: 'Сайт' }, progress: { accepted: 0, total: 6 }, nextAction: { text: '' }, stages: [] } }) };
      const bot = new TelegramBotService(prisma!, journey as never, {} as never, {} as never, {} as never, ownership);
      const owner = await user('tg-owner');
      const heir = await user('tg-heir');
      await prisma!.user.update({ where: { id: heir.id }, data: { locale: 'ru' } });
      const chat = `chat-${randomUUID().slice(0, 8)}`;
      await prisma!.externalIdentity.create({ data: { userId: heir.id, provider: 'telegram', externalId: randomUUID().slice(0, 12), chatId: chat } });
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Кафе', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
      await prisma!.projectMember.createMany({ data: [{ projectId: project.id, userId: owner.id, role: 'owner' }, { projectId: project.id, userId: heir.id, role: 'manager' }] });
      const heirMember = (await prisma!.projectMember.findFirstOrThrow({ where: { projectId: project.id, userId: heir.id } })).id;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

      // The offer arrives with a button; declining from the chat.
      await ownership.offer(owner.id, project.id, { toMemberId: heirMember, keepAccess: false, confirmName: 'Кафе' });
      await settle();
      assert.deepEqual(sent.at(-1)!.buttons, [`OT:${project.id}`]);
      await bot.onCallback(heir.id, chat, 'q1', `OT:${project.id}`);
      await settle();
      assert.match(sent.at(-1)!.text, /предлагает передать вам проект «Кафе»/);
      assert.match(sent.at(-1)!.text, /потеряет доступ/);
      assert.deepEqual(sent.at(-1)!.buttons, [`OA:${project.id}`, `OD:${project.id}`]);
      await bot.onCallback(heir.id, chat, 'q2', `OD:${project.id}`);
      await settle();
      assert.equal((await prisma!.ownershipTransfer.findFirstOrThrow({ where: { projectId: project.id } })).status, 'declined');
      await bot.onCallback(heir.id, chat, 'q3', `OT:${project.id}`);
      await settle();
      assert.match(sent.at(-1)!.text, /больше нет/);

      // A new offer: «Стать владельцем» asks once more, then the project moves.
      await ownership.offer(owner.id, project.id, { toMemberId: heirMember, keepAccess: true, confirmName: 'Кафе' });
      await bot.onCallback(heir.id, chat, 'q4', `OA:${project.id}`);
      await settle();
      assert.deepEqual(sent.at(-1)!.buttons, [`OY:${project.id}`, `OT:${project.id}`]);
      assert.equal((await prisma!.project.findUniqueOrThrow({ where: { id: project.id } })).ownerUserId, owner.id);
      // Someone else cannot accept it from their chat.
      await bot.onCallback(owner.id, `chat-${randomUUID().slice(0, 8)}`, 'q5', `OY:${project.id}`);
      await settle();
      assert.equal((await prisma!.project.findUniqueOrThrow({ where: { id: project.id } })).ownerUserId, owner.id);
      await bot.onCallback(heir.id, chat, 'q6', `OY:${project.id}`);
      await settle();
      assert.equal((await prisma!.project.findUniqueOrThrow({ where: { id: project.id } })).ownerUserId, heir.id);
      assert.ok(sent.some((item) => /Теперь вы владелец проекта/.test(item.text)));
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
