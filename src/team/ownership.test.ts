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
    const ownership = new OwnershipService(prisma!, billing, new TeamService(prisma!, billing));
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
      const ownership = new OwnershipService(prisma!, billing, new TeamService(prisma!, billing));
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
  it('hands the project to someone outside the team: an invitation that becomes an offer on joining', { skip }, async () => {
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    const billing = new BillingService(prisma!);
    const team = new TeamService(prisma!, billing);
    const ownership = new OwnershipService(prisma!, billing, team);
    const owner = await user('inv-owner', null); // a plan without a team: handing over still works
    const outsider = await user('inv-outsider');
    const other = await user('inv-other');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Кафе', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });

    await assert.rejects(ownership.inviteNewOwner(owner.id, project.id, { email: outsider.email, keepAccess: false, confirmName: 'Кофе' }), /OWNERSHIP_CONFIRM_NAME/);
    const invited = await ownership.inviteNewOwner(owner.id, project.id, { email: outsider.email, keepAccess: false, confirmName: 'Кафе' });
    assert.equal(invited.data.invitation.role, 'manager');
    await assert.rejects(ownership.inviteNewOwner(owner.id, project.id, { email: other.email, keepAccess: true, confirmName: 'Кафе' }), /OWNERSHIP_INVITE_OPEN/);
    const view = await ownership.view(owner.id, project.id, 'owner');
    assert.equal(view.canOffer, false);
    assert.equal(view.invite?.email, outsider.email);
    const token = invited.data.inviteUrl.split('/').pop()!;
    assert.equal((await team.info(token)).data.ownership, true);
    // Someone else cannot use the link; the right person joins as a manager and gets the offer.
    await assert.rejects(team.accept(other.id, other.email, token), /INVITE_EMAIL_MISMATCH/);
    const joined = await team.accept(outsider.id, outsider.email, token);
    assert.deepEqual(joined.joined, { invitationId: joined.joined!.invitationId, invitedByUserId: owner.id, keepAccess: false });
    assert.equal(await ownership.afterJoin(outsider.id, project.id, joined.joined!), true);
    const offer = await prisma!.ownershipTransfer.findFirstOrThrow({ where: { projectId: project.id, status: 'pending' } });
    assert.equal(offer.toUserId, outsider.id);
    assert.equal(offer.keepAccess, false);
    await ownership.accept(outsider.id, project.id);
    assert.equal((await prisma!.project.findUniqueOrThrow({ where: { id: project.id } })).ownerUserId, outsider.id);
    assert.equal(await prisma!.projectMember.count({ where: { projectId: project.id, userId: owner.id, status: 'active' } }), 0);

    // If something got tied to the project meanwhile, no offer is made and the owner is told.
    const second = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Бар', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: second.id, userId: owner.id, role: 'owner' } });
    const again = await ownership.inviteNewOwner(owner.id, second.id, { email: other.email, keepAccess: true, confirmName: 'Бар' });
    await prisma!.codeRepository.create({ data: { projectId: second.id, provider: 'github', baseUrl: 'https://api.github.com', repoPath: 'o/r', webUrl: 'https://github.com/o/r', defaultBranch: 'main', isPrivate: true, tokenEncrypted: 'x', tokenHint: 'abcd', connectedByUserId: owner.id, verifiedAt: new Date() } });
    const tied = (await ownership.blockers(second.id)).length > 0;
    const joinedAgain = await team.accept(other.id, other.email, again.data.inviteUrl.split('/').pop()!);
    assert.equal(await ownership.afterJoin(other.id, second.id, joinedAgain.joined!), !tied);
    assert.equal(await prisma!.ownershipTransfer.count({ where: { projectId: second.id } }), tied ? 0 : 1);
    assert.ok(tied, 'the repository should block the hand-over in this test');
  });
});
