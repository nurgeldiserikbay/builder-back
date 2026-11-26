import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { ProjectsService } from '../projects/projects.service.js';
import { originRefusal } from '../security/origin-check.js';
import { buildAgentPrompt } from '../agent/agent-tasks.js';
import { FEEDBACK_RATE, FeedbackService, feedbackItem, feedbackUrl, readFeedback } from './feedback.service.js';

describe('feedback from a launched application', () => {
  it('reads a message as plain text, and a filled trap field is a bot', () => {
    assert.deepEqual(readFeedback({ kind: 'idea', text: '  Добавьте\u0000 тёмную тему ', contact: 'tg @me', page: '/orders' }), { kind: 'idea', text: 'Добавьте тёмную тему', contact: 'tg @me', page: '/orders' });
    assert.equal(readFeedback({ text: 'x'.repeat(3000) })!.text.length, 2000);
    assert.equal(readFeedback({ text: 'Привет', website: 'http://spam' }), null);
    assert.equal(readFeedback({ text: '<script>x</script>', kind: 'hack' })!.kind, 'problem', 'an unknown kind is a problem, the text stays text');
    assert.throws(() => readFeedback({ text: ' ' }), /FEEDBACK_TEXT_REQUIRED/);
    const item = feedbackItem({ kind: 'problem', text: 'Не открывается заказ\nпосле оплаты', contact: '', page: '/orders/5' });
    assert.equal(item.title, 'Проблема: Не открывается заказ');
    assert.equal(item.priority, 'high');
    assert.match(item.details, /Страница: \/orders\/5/);
  });

  it('the address works from the application\'s own origin, and the agent is told about it only when it is on', () => {
    const allowed = new Set(['https://app.buildpath.kz']);
    const token = 'A'.repeat(32);
    assert.equal(originRefusal({ method: 'POST', path: `/api/v1/feedback/${token}`, headers: { origin: 'https://crm.onrender.com' } }, allowed), null);
    assert.notEqual(originRefusal({ method: 'POST', path: '/api/v1/projects/x/backlog', headers: { origin: 'https://crm.onrender.com' } }, allowed), null);
    assert.equal(feedbackUrl(token, { PUBLIC_API_URL: 'https://api.example.com/' }), `https://api.example.com/api/v1/feedback/${token}`);
    assert.equal(feedbackUrl(token, {}), null);
    const on = buildAgentPrompt({ locale: 'ru', projectName: 'CRM', inputs: {}, instruction: null, feedbackUrl: `https://api.example.com/api/v1/feedback/${token}` });
    assert.match(on.system, /Сообщить о проблеме или идее/);
    assert.ok(on.system.includes(`https://api.example.com/api/v1/feedback/${token}`));
    assert.doesNotMatch(buildAgentPrompt({ locale: 'ru', projectName: 'CRM', inputs: {}, instruction: null }).system, /Feedback form/);
  });
});

describe('feedback inbox (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM feedback_inboxes LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  const env = process.env.PUBLIC_API_URL;
  after(async () => {
    process.env.PUBLIC_API_URL = env;
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('turned on, a message becomes a backlog item; turned off or renewed, the old address answers «not found»', { skip }, async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    const billing = new BillingService(prisma!);
    const service = new FeedbackService(prisma!, new JourneyCore(prisma!, billing));
    const email = `feedback-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'CRM', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;

    assert.deepEqual((await service.get(owner.id, projectId)).data, { enabled: false, url: null, received: 0, lastReceivedAt: null, configured: true });
    const on = (await service.set(owner.id, projectId, { enabled: true })).data;
    const token = on.url!.split('/').at(-1)!;
    assert.match(on.url!, /^https:\/\/api\.example\.com\/api\/v1\/feedback\/[A-Za-z0-9_-]{32}$/);
    assert.equal(await service.urlFor(projectId), on.url);

    await service.receive(token, '10.0.0.1', { kind: 'problem', text: 'Не грузится список заказов', contact: '+7 700', page: '/orders' });
    await service.receive(token, '10.0.0.1', { text: 'бот', website: 'spam' });
    const items = await prisma!.backlogItem.findMany({ where: { projectId, source: 'app_feedback' } });
    assert.equal(items.length, 1, 'the bot left nothing');
    assert.deepEqual([items[0]!.title, items[0]!.priority, items[0]!.status], ['Проблема: Не грузится список заказов', 'high', 'open']);
    assert.equal((await service.get(owner.id, projectId)).data.received, 1);

    // One address cannot flood the backlog.
    for (let index = 0; index < FEEDBACK_RATE.perIp.max; index += 1) await service.receive(token, '10.0.0.2', { text: `сообщение ${index}` });
    await assert.rejects(service.receive(token, '10.0.0.2', { text: 'и ещё' }), /FEEDBACK_TOO_MANY/);

    await service.set(owner.id, projectId, { enabled: false });
    await assert.rejects(service.receive(token, '10.0.0.3', { text: 'после выключения' }), /FEEDBACK_NOT_FOUND/);
    assert.equal(await service.urlFor(projectId), null);
    const renewed = (await service.set(owner.id, projectId, { enabled: true, renew: true })).data;
    assert.notEqual(renewed.url, on.url);
    await assert.rejects(service.receive(token, '10.0.0.3', { text: 'по старому адресу' }), /FEEDBACK_NOT_FOUND/);
    await assert.rejects(service.receive('short', '10.0.0.3', { text: 'неверный адрес' }), /FEEDBACK_NOT_FOUND/);
  });
});
