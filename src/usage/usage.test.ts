import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { buildAgentPrompt, usageRule } from '../agent/agent-tasks.js';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { ProjectsService } from '../projects/projects.service.js';
import { originRefusal } from '../security/origin-check.js';
import { cleanAction, cleanPath, dayOf, OTHER, readUsage, USAGE_LIMITS, usageReport, usageUrl, UsageService, visitorHash } from './usage.service.js';

const browser = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('usage analytics of a launched application', () => {
  it('keeps only the screen, without ids, query strings or anything that may tell who it is', () => {
    assert.equal(cleanPath('/orders/12345?tab=open#x'), '/orders/:id');
    assert.equal(cleanPath('/Clients/3f2b8c1e-5a7d-4e2f-9b1c-0d4e5f6a7b8c/edit/'), '/clients/:id/edit');
    assert.equal(cleanPath('/reset/eyJhbGciOiJIUzI1NiJ9abc123'), '/reset/:id');
    assert.equal(cleanPath('/users/anna@mail.kz'), '/users/:id');
    assert.equal(cleanPath('/'), '/');
    assert.equal(cleanPath('/заявки'), '/заявки');
    assert.equal(cleanPath('https://evil.example/x'), null);
    assert.equal(cleanPath('/<script>'), null);
    assert.equal(cleanPath(42), null);
    assert.equal(cleanPath(`/${'a'.repeat(200)}`)!.length, USAGE_LIMITS.path);
    assert.equal(cleanAction('  Заявка  отправлена '), 'заявка отправлена');
    assert.equal(cleanAction('x'.repeat(41)), null);
    assert.equal(cleanAction('email: anna@mail.kz'), null);
    assert.deepEqual(readUsage({ kind: 'view', name: '/orders/7' }), { kind: 'view', name: '/orders/:id' });
    assert.deepEqual(readUsage({ name: '/' }), { kind: 'view', name: '/' });
    assert.deepEqual(readUsage({ kind: 'action', name: 'Заказ оформлен' }), { kind: 'action', name: 'заказ оформлен' });
    assert.equal(readUsage({ kind: 'click', name: '/' }), null);
    assert.equal(readUsage(null), null);
  });

  it('counts a visitor by a hash that depends on the day\'s salt, so the same person cannot be followed across days', () => {
    const a = visitorHash('salt-1', 'c1', '10.0.0.1', browser);
    assert.equal(a.length, 32);
    assert.equal(visitorHash('salt-1', 'c1', '10.0.0.1', browser), a);
    assert.notEqual(visitorHash('salt-2', 'c1', '10.0.0.1', browser), a);
    assert.notEqual(visitorHash('salt-1', 'c2', '10.0.0.1', browser), a);
    assert.ok(!a.includes('10.0.0.1'));
  });

  it('the report has every day of the period, totals, the most opened screens and the actions', () => {
    const today = dayOf(new Date('2026-11-27T15:00:00Z'));
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const report = usageReport([
      { day: day('2026-11-27'), kind: 'view', name: '/', count: 5 }, { day: day('2026-11-27'), kind: 'view', name: '/orders', count: 8 },
      { day: day('2026-11-27'), kind: 'visitors', name: '', count: 3 }, { day: day('2026-11-25'), kind: 'view', name: '/', count: 2 },
      { day: day('2026-11-25'), kind: 'action', name: 'заказ оформлен', count: 1 },
    ], 7, today);
    assert.equal(report.days.length, 7);
    assert.equal(report.days[0]!.day, '2026-11-21');
    assert.deepEqual(report.days.at(-1), { day: '2026-11-27', views: 13, visitors: 3, actions: 0 });
    assert.deepEqual(report.totals, { views: 15, visitors: 3, actions: 1 });
    assert.deepEqual(report.screens, [{ name: '/orders', count: 8 }, { name: '/', count: 7 }]);
    assert.deepEqual(report.actions, [{ name: 'заказ оформлен', count: 1 }]);
  });

  it('the agent adds the counting lines only when the owner turned analytics on, and sends nothing about the person', () => {
    const rule = usageRule('https://api.example.com/api/v1/usage/tok');
    assert.match(rule, /sendBeacon\("https:\/\/api\.example\.com\/api\/v1\/usage\/tok"/);
    assert.match(rule, /no ids, emails, names/);
    assert.match(rule, /build:demo\) send nothing/);
    const base = { locale: 'ru', projectName: 'CRM', inputs: {}, instruction: null };
    assert.doesNotMatch(buildAgentPrompt(base).system, /Usage analytics/);
    assert.match(buildAgentPrompt({ ...base, usageUrl: 'https://api.example.com/api/v1/usage/tok' }).system, /Usage analytics/);
    assert.equal(usageUrl('tok', {}), null);
    assert.equal(usageUrl('tok', { PUBLIC_API_URL: 'https://api.example.com/' }), 'https://api.example.com/api/v1/usage/tok');
    // The public address is called from the application's own origin.
    assert.equal(originRefusal({ method: 'POST', url: '/api/v1/usage/AAAAAAAAAAAAAAAAAAAAAAAAAAAA', originalUrl: '/api/v1/usage/AAAAAAAAAAAAAAAAAAAAAAAAAAAA', path: '/api/v1/usage/AAAAAAAAAAAAAAAAAAAAAAAAAAAA', headers: { origin: 'https://app.example.com' } } as never, new Set(['https://buildpath.example'])), null);
  });
});

describe('usage analytics (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM usage_collectors LIMIT 1`; } catch { prisma = null; }
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

  it('turned on, views, visitors and actions are counted by day; bots and unknown addresses are not', { skip }, async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    const billing = new BillingService(prisma!);
    const service = new UsageService(prisma!, new JourneyCore(prisma!, billing));
    const email = `usage-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const create = (projectType: string) => new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'CRM', startMode: 'build', locale: 'ru', projectType } as never).then((result) => result.data.id);
    const projectId = await create('web_app');
    await assert.rejects(service.get(owner.id, await create('landing'), '7'), /USAGE_NOT_FOR_PROJECT/);

    const empty = (await service.get(owner.id, projectId, '7')).data;
    assert.equal(empty.enabled, false);
    assert.equal(empty.url, null);
    assert.deepEqual(empty.totals, { views: 0, visitors: 0, actions: 0 });
    assert.equal(await service.urlFor(projectId), null);
    const on = (await service.set(owner.id, projectId, { enabled: true })).data;
    assert.match(on.url!, /^https:\/\/api\.example\.com\/api\/v1\/usage\/[A-Za-z0-9_-]{32}$/);
    assert.equal(await service.urlFor(projectId), on.url);
    const token = on.url!.split('/').at(-1)!;

    // Salts of earlier runs: the order of days below is made up, a real clock only moves forward.
    await prisma!.usageSalt.deleteMany({});
    // Yesterday: one person, two screens. Today: two people, one of them twice; an action; a bot; garbage.
    const yesterday = new Date(Date.now() - 86_400_000);
    await service.receive(token, '10.0.0.1', browser, { kind: 'view', name: '/' }, yesterday);
    await service.receive(token, '10.0.0.1', browser, { kind: 'view', name: '/orders' }, yesterday);
    const now = new Date();
    await service.receive(token, '10.0.0.1', browser, { kind: 'view', name: '/' }, now);
    await service.receive(token, '10.0.0.1', browser, { kind: 'view', name: '/orders/15' }, now);
    await service.receive(token, '10.0.0.2', browser, { kind: 'view', name: '/orders/16' }, now);
    await service.receive(token, '10.0.0.2', browser, { kind: 'action', name: 'Заказ оформлен' }, now);
    await service.receive(token, '10.0.0.3', 'Googlebot/2.1', { kind: 'view', name: '/' }, now);
    await service.receive(token, '10.0.0.3', browser, { kind: 'view', name: 'not a path' }, now);
    await service.receive(token, '10.0.0.3', '', { kind: 'view', name: '/' }, now);
    await assert.rejects(service.receive('A'.repeat(32), '10.0.0.1', browser, { name: '/' }), /USAGE_NOT_FOUND/);

    const report = (await service.get(owner.id, projectId, '7')).data;
    assert.deepEqual(report.days.at(-1), { day: dayOf(now).toISOString().slice(0, 10), views: 3, visitors: 2, actions: 1 });
    assert.deepEqual(report.days.at(-2), { day: dayOf(yesterday).toISOString().slice(0, 10), views: 2, visitors: 1, actions: 0 });
    assert.deepEqual(report.screens, [{ name: '/', count: 2 }, { name: '/orders/:id', count: 2 }, { name: '/orders', count: 1 }]);
    assert.deepEqual(report.actions, [{ name: 'заказ оформлен', count: 1 }]);
    assert.equal((await service.get(owner.id, projectId, '30')).data.days.length, 30);
    // A new day deleted yesterday's salt and visitor hashes: only today's are left, and no addresses at all.
    const salts = await prisma!.usageSalt.findMany();
    assert.ok(salts.every((salt) => salt.day.getTime() === dayOf(now).getTime()));
    const hashes = await prisma!.usageVisitor.findMany({ where: { collectorId: (await prisma!.usageCollector.findUniqueOrThrow({ where: { projectId } })).id } });
    assert.equal(hashes.length, 2);
    assert.ok(hashes.every((row) => row.day.getTime() === dayOf(now).getTime() && !row.hash.includes('10.0.0')));

    // Past the daily limit of distinct screens the rest is counted together.
    const collectorId = (await prisma!.usageCollector.findUniqueOrThrow({ where: { projectId } })).id;
    for (let index = 0; index < USAGE_LIMITS.names + 2; index += 1) await service.receive(token, `10.1.0.${index % 200}`, browser, { kind: 'view', name: `/page-${index}` }, now);
    const names = await prisma!.usageDay.findMany({ where: { collectorId, day: dayOf(now), kind: 'view' } });
    assert.equal(names.length, USAGE_LIMITS.names + 1);
    assert.ok(names.some((row) => row.name === OTHER && row.count >= 2));

    // Turned off or renewed: the old address stops counting, what was counted stays.
    const renewed = (await service.set(owner.id, projectId, { renew: true })).data;
    assert.notEqual(renewed.url, on.url);
    await assert.rejects(service.receive(token, '10.0.0.1', browser, { name: '/' }), /USAGE_NOT_FOUND/);
    await service.set(owner.id, projectId, { enabled: false });
    await assert.rejects(service.receive(renewed.url!.split('/').at(-1)!, '10.0.0.1', browser, { name: '/' }), /USAGE_NOT_FOUND/);
    assert.equal(await service.urlFor(projectId), null);
    assert.ok((await service.get(owner.id, projectId, '7')).data.totals.views > 0);
    await assert.rejects(service.set(owner.id, projectId, {}), /INVALID_BODY/);
    const events = await prisma!.projectEvent.findMany({ where: { projectId, type: 'usage_collector_changed' } });
    assert.equal(events.length, 3);
  });
});
