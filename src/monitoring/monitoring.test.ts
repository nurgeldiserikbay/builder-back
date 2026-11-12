import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { MonitoringService } from './monitoring.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Removes only what it created. */
describe('site monitoring (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT monitor_status FROM site_publications LIMIT 1`;
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

  it('tells the owner once when the site goes down and once when it is back, and sends the weekly report once', { skip }, async () => {
    const mails: Array<{ to: string; subject: string; html: string }> = [];
    const mailServer = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => { const body = JSON.parse(raw); mails.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent }); response.writeHead(201).end('{}'); });
    });
    await new Promise<void>((resolve) => mailServer.listen(0, '127.0.0.1', resolve));
    const saved = { ...process.env };
    Object.assign(process.env, { EMAIL_FROM: 'BuildPath <noreply@test.local>', BREVO_API_KEY: 'test', BREVO_API_URL: `http://127.0.0.1:${(mailServer.address() as { port: number }).port}`, SITES_STATS_TIMEZONE: 'Asia/Almaty' });
    try {
      const email = `owner-${randomUUID()}@test.local`;
      const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), locale: 'ru' } });
      users.push(owner.id);
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'live' } });
      await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
      const site = await prisma!.sitePublication.create({ data: { projectId: project.id, slug: `t-${randomUUID().slice(0, 8)}`, status: 'live', buildVersionId: randomUUID(), publishedAt: new Date(), publishedByUserId: owner.id } });

      const monitoring = new MonitoringService(prisma!);
      let answer = { ok: true, status: 200 as number | null, ms: 50, error: null as string | null };
      const seen: Array<[string, boolean]> = [];
      monitoring.probe = async (url, trusted) => { seen.push([url, trusted]); return answer; };
      const only = async (now: Date) => {
        // Other live sites in a shared development database are checked too; count only this one.
        await monitoring.checkAll(now);
        return prisma!.sitePublication.findUniqueOrThrow({ where: { id: site.id } });
      };
      const t0 = new Date('2026-11-12T10:00:00Z');
      const minutes = (count: number) => new Date(t0.getTime() + count * 60_000);
      assert.equal((await only(t0)).monitorStatus, 'up');
      assert.ok(seen.some(([url, trusted]) => url.includes(site.slug) && trusted));

      answer = { ok: false, status: null, ms: 10_000, error: 'TIMEOUT' };
      assert.equal((await only(minutes(10))).monitorStatus, 'up'); // one failure is not an outage
      const down = await only(minutes(20));
      assert.equal(down.monitorStatus, 'down');
      assert.equal(down.monitorDownSince?.toISOString(), minutes(10).toISOString());
      await only(minutes(30));
      const mine = () => mails.filter((mail) => mail.to === email);
      assert.equal(mine().length, 1);
      assert.match(mine()[0]!.subject, /не открывается/);
      assert.match(mine()[0]!.html, /не ответил за 10 секунд/);

      answer = { ok: true, status: 200, ms: 60, error: null };
      assert.equal((await only(minutes(90))).monitorStatus, 'up');
      assert.equal(mine().length, 2);
      assert.match(mine()[1]!.html, /1 ч 20 мин/);
      const incidents = await prisma!.siteIncident.findMany({ where: { publicationId: site.id } });
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0]!.cause, 'TIMEOUT');
      assert.equal(incidents[0]!.endedAt?.toISOString(), minutes(90).toISOString());

      const status = (await monitoring.status(owner.id, project.id)).data!;
      assert.equal(status.status, 'up');
      assert.equal(status.incidents.length, 1);

      // Weekly report: the first Monday only marks the week; the next one sends; a second run that week sends nothing.
      const monday = new Date('2026-11-16T05:00:00Z'); // 10:00 in Almaty
      await prisma!.siteVisitCount.create({ data: { projectId: project.id, day: new Date('2026-11-12T00:00:00Z'), path: '/', source: 'direct', views: 42 } });
      await monitoring.sendWeeklyReports(new Date('2026-11-12T05:00:00Z')); // Thursday right after launch
      assert.equal(mine().length, 2);
      await monitoring.sendWeeklyReports(monday);
      assert.equal(mine().length, 3);
      assert.match(mine()[2]!.html, /Просмотров страниц: 42/);
      assert.match(mine()[2]!.html, /не открывался 1 раз, всего около 1 ч 20 мин/);
      await monitoring.sendWeeklyReports(new Date('2026-11-16T07:00:00Z'));
      assert.equal(mine().length, 3);

      // The owner can switch the report off.
      assert.equal((await monitoring.setWeeklyReport(owner.id, project.id, false)).data!.weeklyReport, false);
      await prisma!.sitePublication.update({ where: { id: site.id }, data: { weeklyReportWeek: '2026-11-09' } });
      await monitoring.sendWeeklyReports(new Date('2026-11-23T05:00:00Z'));
      assert.equal(mine().length, 3);
    } finally {
      process.env = saved;
      mailServer.close();
    }
  });
});
