import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { GROUP_EVENTS, groupLine, TelegramGroupService } from './telegram-group.service.js';

describe('Telegram group lines', () => {
  it('names the project and the stage, never contents', () => {
    assert.equal(groupLine({ type: 'stage_submitted', stageKey: 'design', details: { versionNumber: 3 } }, 'Пекарня', 'landing'), 'Пекарня: этап «Внешний вид» отправлен на приёмку');
    assert.equal(groupLine({ type: 'agent_task_finished', stageKey: 'handoff', details: { status: 'failed' } }, 'Учёт', 'web_app'), 'Учёт: ИИ-агент закончил задачу, но проверки не прошли');
    assert.equal(groupLine({ type: 'site_published', stageKey: null, details: {} }, 'Пекарня', 'landing'), 'Пекарня: сайт опубликован');
    // Not in the list, or a stage event without a stage: nothing.
    assert.equal(groupLine({ type: 'stage_draft_saved', stageKey: 'design', details: {} }, 'P', 'landing'), null);
    assert.equal(groupLine({ type: 'stage_accepted', stageKey: null, details: {} }, 'P', 'landing'), null);
    assert.ok(GROUP_EVENTS.every((type) => !type.includes('payment') && !type.includes('comment')));
  });
});

/** Against DATABASE_URL; skipped without it. */
describe('Telegram groups (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT cursor_at FROM project_telegram_groups LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, name: process.env.TELEGRAM_BOT_USERNAME, base: process.env.TELEGRAM_API_BASE_URL, app: process.env.PUBLIC_APP_URL };
  after(async () => {
    process.env.TELEGRAM_BOT_TOKEN = saved.token; process.env.TELEGRAM_BOT_USERNAME = saved.name; process.env.TELEGRAM_API_BASE_URL = saved.base; process.env.PUBLIC_APP_URL = saved.app;
    for (const [key, value] of Object.entries({ TELEGRAM_BOT_TOKEN: saved.token, TELEGRAM_BOT_USERNAME: saved.name, TELEGRAM_API_BASE_URL: saved.base, PUBLIC_APP_URL: saved.app })) if (value === undefined) delete process.env[key];
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('links a group by a one-time code, sends each event once and unlinks when the bot is removed', { skip }, async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.TELEGRAM_BOT_USERNAME = 'buildpath_test_bot';
    process.env.TELEGRAM_API_BASE_URL = 'http://127.0.0.1:9'; process.env.PUBLIC_APP_URL = 'https://app.example.com';
    const core = new JourneyCore(prisma!, new BillingService(prisma!));
    const groups = new TelegramGroupService(prisma!, core);
    const user = async (label: string) => {
      const email = `${label}-${randomUUID()}@test.local`;
      const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: label } });
      users.push(created.id);
      return created;
    };
    const owner = await user('owner');
    const editor = await user('editor');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Пекарня', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0', locale: 'ru' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: editor.id, role: 'contributor' } });
    await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'design', definitionVersion: '1', position: 0, status: 'ready' } });

    // Only the owner or a manager links; anyone in the project sees whether there is a group.
    await assert.rejects(groups.link(editor.id, project.id), /TELEGRAM_GROUP_FORBIDDEN/);
    assert.equal((await groups.get(editor.id, project.id)).data.canManage, false);
    const { deepLink } = (await groups.link(owner.id, project.id)).data;
    assert.match(deepLink, /^https:\/\/t\.me\/buildpath_test_bot\?startgroup=[A-Za-z0-9_-]{24}$/);
    const code = deepLink.split('=')[1]!;
    assert.ok((await groups.get(owner.id, project.id)).data.waiting);

    // An event before the link never goes to the group.
    await prisma!.projectEvent.create({ data: { projectId: project.id, actorUserId: owner.id, type: 'stage_submitted', stageKey: 'design', details: {} } });
    const chatId = `-100${Date.now()}`;
    // A private chat or a wrong code links nothing.
    assert.equal(await groups.handleGroupUpdate({ message: { text: `/start ${code}`, chat: { id: 5, type: 'private' } } }), false);
    assert.equal(await groups.handleGroupUpdate({ message: { text: '/start wrongwrongwrongwrongwrong', chat: { id: chatId, type: 'supergroup', title: 'Команда' } } }), true);
    assert.equal((await groups.get(owner.id, project.id)).data.group, null);
    await groups.handleGroupUpdate({ message: { text: `/start@buildpath_test_bot ${code}`, chat: { id: chatId, type: 'supergroup', title: 'Команда пекарни' } } });
    const linked = (await groups.get(owner.id, project.id)).data;
    assert.equal(linked.group?.title, 'Команда пекарни');
    await assert.rejects(groups.link(owner.id, project.id), /TELEGRAM_GROUP_LINKED/);
    // The code works once.
    await groups.handleGroupUpdate({ message: { text: `/start ${code}`, chat: { id: '-1009', type: 'group', title: 'Чужая' } } });
    assert.equal((await prisma!.projectTelegramGroup.findUniqueOrThrow({ where: { projectId: project.id } })).chatId, chatId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma!.projectEvent.create({ data: { projectId: project.id, actorUserId: owner.id, type: 'stage_draft_saved', stageKey: 'design', details: {} } });
    await prisma!.projectEvent.create({ data: { projectId: project.id, actorUserId: owner.id, type: 'stage_accepted', stageKey: 'design', details: { versionNumber: 2 } } });
    const sent: Array<{ chat_id: string; text: string; reply_markup?: { inline_keyboard: Array<Array<{ url: string }>> } }> = [];
    const fake = (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await groups.tick(fake);
    const ours = sent.filter((item) => item.chat_id === chatId);
    assert.deepEqual(ours.map((item) => item.text), ['Пекарня: этап «Внешний вид» принят']);
    assert.equal(ours[0]!.reply_markup?.inline_keyboard[0]![0]!.url, `https://app.example.com/projects/${project.id}/stages/design`);
    await groups.tick(fake);
    assert.equal(sent.filter((item) => item.chat_id === chatId).length, 1, 'an event goes once');

    // A failed send is recorded, not retried.
    await prisma!.projectEvent.create({ data: { projectId: project.id, actorUserId: owner.id, type: 'stage_reopened', stageKey: 'design', details: {} } });
    await groups.tick((async () => new Response('{}', { status: 403 })) as unknown as typeof fetch);
    assert.ok((await groups.get(owner.id, project.id)).data.group?.lastFailedAt);
    sent.length = 0;
    await groups.tick(fake);
    assert.equal(sent.filter((item) => item.chat_id === chatId).length, 0);

    // The bot removed from the group: the link ends and is written down.
    await groups.handleGroupUpdate({ my_chat_member: { chat: { id: chatId, type: 'supergroup' }, new_chat_member: { status: 'kicked' } } });
    assert.equal((await groups.get(owner.id, project.id)).data.group, null);
    assert.equal(await prisma!.projectEvent.count({ where: { projectId: project.id, type: { in: ['telegram_group_linked', 'telegram_group_unlinked'] } } }), 2);
    await assert.rejects(groups.unlink(owner.id, project.id), /TELEGRAM_GROUP_NOT_LINKED/);
  });
});
