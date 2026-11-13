import { ConflictException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { sitesConfig } from '../publishing/slug.js';
import { dayIn } from '../sites/visit-counter.js';
import { change } from '../insights/insights-rules.js';
import { CHECK_INTERVAL_MS, duration, nextState, weeklyReportDue, type MonitorStatus, type Probe } from './monitor-rules.js';
import { probeSite } from './site-probe.js';
import { liveCheck, type LiveCheck } from './live-check.js';

/** Only one API instance checks sites at a time. */
const LOCK_KEY = 7_316_005;
const CONCURRENCY = 5;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const zone = () => {
  const value = process.env.SITES_STATS_TIMEZONE;
  try { if (value) { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } } catch { /* fall back */ }
  return 'Asia/Almaty';
};

type Live = { id: string; projectId: string; slug: string; customDomain: string | null; domainStatus: string | null; monitorStatus: string; monitorFailures: number; monitorDownSince: Date | null; monitorAlertedAt: Date | null; project: { name: string; ownerUserId: string } };

/**
 * After launch: every 10 minutes opens each live site at the address visitors use and tells the owner when it stops
 * opening and when it is back; on Mondays sends the week's summary. The check runs inside the API, so if the whole
 * platform is down nobody is told — that needs an outside monitor of the platform itself.
 */
@Injectable()
export class MonitoringService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SiteMonitoring');
  private timer: NodeJS.Timeout | null = null;
  /** Replaced in tests. */
  probe: (url: string, trusted: boolean) => Promise<Probe> = probeSite;
  inspect: (url: string, trusted: boolean) => Promise<LiveCheck> = liveCheck;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.SITE_MONITORING_DISABLED === 'true') return;
    const run = () => { this.tick().catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'SITE_MONITORING_FAILED')); };
    this.timer = setInterval(run, CHECK_INTERVAL_MS);
    this.timer.unref();
    setTimeout(run, 2 * 60_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    const locked = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked[0]?.locked) return { checked: 0, alerts: 0, reports: 0 };
    try {
      const result = await this.checkAll(now);
      const reports = await this.sendWeeklyReports(now);
      if (result.alerts || reports) this.logger.log(`checked ${result.checked}, alerts ${result.alerts}, reports ${reports}`);
      return { ...result, reports };
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  }

  private urlOf(site: Pick<Live, 'slug' | 'customDomain' | 'domainStatus'>): { url: string; trusted: boolean } {
    if (site.domainStatus === 'active' && site.customDomain) return { url: `https://${site.customDomain}/`, trusted: false };
    return { url: new URL('/', sitesConfig().urlFor(site.slug)).toString(), trusted: true };
  }

  async checkAll(now = new Date()) {
    const sites: Live[] = await this.prisma.sitePublication.findMany({
      where: { status: 'live' },
      select: { id: true, projectId: true, slug: true, customDomain: true, domainStatus: true, monitorStatus: true, monitorFailures: true, monitorDownSince: true, monitorAlertedAt: true, project: { select: { name: true, ownerUserId: true } } },
    });
    let alerts = 0;
    for (let index = 0; index < sites.length; index += CONCURRENCY) {
      const batch = sites.slice(index, index + CONCURRENCY);
      const counts = await Promise.all(batch.map((site) => this.checkOne(site, now)));
      alerts += counts.reduce((sum, value) => sum + value, 0);
    }
    return { checked: sites.length, alerts };
  }

  private async checkOne(site: Live, now: Date): Promise<number> {
    const { url, trusted } = this.urlOf(site);
    const probe = await this.probe(url, trusted);
    const step = nextState({ status: site.monitorStatus as MonitorStatus, failures: site.monitorFailures, downSince: site.monitorDownSince, alertedAt: site.monitorAlertedAt }, probe, now);
    await this.prisma.$transaction(async (tx) => {
      // Conditional on the state read, so a site unpublished meanwhile is left alone.
      await tx.sitePublication.updateMany({ where: { id: site.id, status: 'live' }, data: {
        monitorStatus: step.state.status, monitorFailures: step.state.failures, monitorDownSince: step.state.downSince, monitorAlertedAt: step.state.alertedAt,
        monitorCheckedAt: now, monitorLastMs: probe.ms, monitorLastError: probe.error,
      } });
      if (step.incident === 'open') await tx.siteIncident.create({ data: { publicationId: site.id, projectId: site.projectId, startedAt: step.state.downSince ?? now, cause: probe.error ?? 'ERROR' } });
      if (step.incident === 'close') await tx.siteIncident.updateMany({ where: { publicationId: site.id, endedAt: null }, data: { endedAt: now } });
    });
    if (!step.alert) return 0;
    const link = { path: `/projects/${site.projectId}#publish`, label: () => tr('Открыть проект') };
    if (step.alert === 'down') {
      await notifyUser(this.prisma, site.project.ownerUserId, {
        text: () => tr('Сайт «{0}» не открывается ({1}). Проверяем каждые 10 минут и напишем, когда он снова заработает. {2}', [site.project.name, causeText(probe.error), url]),
        emailSubject: () => tr('BuildPath: сайт «{0}» не открывается', [site.project.name]), link,
      });
    } else {
      const down = duration(now.getTime() - (site.monitorDownSince ?? now).getTime());
      await notifyUser(this.prisma, site.project.ownerUserId, {
        text: () => tr('Сайт «{0}» снова открывается. Не работал примерно {1} ч {2} мин.', [site.project.name, down.hours, down.minutes]),
        emailSubject: () => tr('BuildPath: сайт «{0}» снова работает', [site.project.name]), link,
      });
    }
    return 1;
  }

  async sendWeeklyReports(now = new Date()): Promise<number> {
    const timeZone = zone();
    const sites = await this.prisma.sitePublication.findMany({ where: { status: 'live', weeklyReport: true }, select: { id: true, projectId: true, weeklyReportWeek: true, project: { select: { name: true, ownerUserId: true } } } });
    let sent = 0;
    for (const site of sites) {
      const { due, week } = weeklyReportDue(timeZone, site.weeklyReportWeek, now);
      if (!due) continue;
      // Claim the week first, so a retry or a second instance never sends it twice.
      const claimed = await this.prisma.sitePublication.updateMany({ where: { id: site.id, OR: [{ weeklyReportWeek: null }, { weeklyReportWeek: { not: week } }] }, data: { weeklyReportWeek: week } });
      if (!claimed.count) continue;
      // A site published this week starts with next Monday's report, not a partial week.
      if (site.weeklyReportWeek === null) continue;
      const end = new Date(`${week}T00:00:00Z`);
      const start = new Date(end.getTime() - 7 * 86_400_000);
      const before = new Date(start.getTime() - 7 * 86_400_000);
      const [views, previous, leads, bookings, orders, incidents] = await Promise.all([
        this.prisma.siteVisitCount.aggregate({ where: { projectId: site.projectId, day: { gte: start, lt: end } }, _sum: { views: true } }),
        this.prisma.siteVisitCount.aggregate({ where: { projectId: site.projectId, day: { gte: before, lt: start } }, _sum: { views: true } }),
        this.prisma.siteLead.count({ where: { projectId: site.projectId, createdAt: { gte: start, lt: end } } }),
        this.prisma.booking.count({ where: { projectId: site.projectId, createdAt: { gte: start, lt: end } } }),
        this.prisma.storeOrder.count({ where: { projectId: site.projectId, createdAt: { gte: start, lt: end } } }),
        this.prisma.siteIncident.findMany({ where: { publicationId: site.id, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gte: start } }] }, select: { startedAt: true, endedAt: true } }),
      ]);
      const total = views._sum.views ?? 0;
      const diff = change(total, previous._sum.views ?? 0);
      const downMs = incidents.reduce((sum, item) => sum + (Math.min((item.endedAt ?? end).getTime(), end.getTime()) - Math.max(item.startedAt.getTime(), start.getTime())), 0);
      const down = duration(downMs);
      const lines = () => [
        tr('Сайт «{0}» за прошлую неделю:', [site.project.name]),
        tr('Просмотров страниц: {0}{1}', [total, diff === null ? '' : tr(' ({0}{1}% к неделе до этого)', [diff >= 0 ? '+' : '', diff])]),
        tr('Заявок: {0}', [leads]) + (bookings ? tr(', записей: {0}', [bookings]) : '') + (orders ? tr(', заказов: {0}', [orders]) : ''),
        incidents.length ? tr('Сайт не открывался {0} раз, всего около {1} ч {2} мин.', [incidents.length, down.hours, down.minutes]) : tr('Сайт открывался всю неделю без сбоев.'),
      ].join('\n');
      await notifyUser(this.prisma, site.project.ownerUserId, {
        text: lines, emailSubject: () => tr('BuildPath: неделя сайта «{0}»', [site.project.name]),
        link: { path: `/projects/${site.projectId}#publish`, label: () => tr('Подробнее в проекте') },
      });
      sent += 1;
    }
    return sent;
  }

  /** Owner's view: last check and recent outages, plus the weekly report switch. Members of the project only. */
  async status(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    const site = await this.prisma.sitePublication.findUnique({ where: { projectId }, select: { id: true, status: true, monitorStatus: true, monitorCheckedAt: true, monitorDownSince: true, monitorLastMs: true, monitorLastError: true, weeklyReport: true, liveCheck: true } });
    if (!site || site.status !== 'live') return { data: null };
    const since = new Date(Date.now() - 30 * 86_400_000);
    const incidents = await this.prisma.siteIncident.findMany({ where: { publicationId: site.id, OR: [{ endedAt: null }, { endedAt: { gte: since } }] }, orderBy: { startedAt: 'desc' }, take: 20, select: { startedAt: true, endedAt: true, cause: true } });
    return {
      data: {
        status: site.monitorStatus, checkedAt: site.monitorCheckedAt, downSince: site.monitorDownSince, lastMs: site.monitorLastMs, lastError: site.monitorLastError,
        incidents, weeklyReport: site.weeklyReport, canChange: member.role === 'owner' || member.role === 'manager', today: dayIn(zone()),
        liveCheck: liveCheckView(site.liveCheck as LiveCheck | null),
      },
    };
  }

  /** Checks the published address now (owner or manager); at most once a minute per site — a repeat returns the last result. */
  async runLiveCheck(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active', role: { in: ['owner', 'manager'] } }, select: { id: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    const site = await this.prisma.sitePublication.findUnique({ where: { projectId }, select: { id: true, status: true, slug: true, customDomain: true, domainStatus: true, liveCheckedAt: true } });
    if (!site || site.status !== 'live') throw new ConflictException('SITE_NOT_LIVE');
    if (!site.liveCheckedAt || Date.now() - site.liveCheckedAt.getTime() > 60_000) {
      const { url, trusted } = this.urlOf(site);
      const result = await this.inspect(url, trusted);
      await this.prisma.sitePublication.updateMany({ where: { id: site.id }, data: { liveCheck: result as never, liveCheckedAt: new Date() } });
    }
    return this.status(userId, projectId);
  }

  async setWeeklyReport(userId: string, projectId: string, enabled: boolean) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active', role: { in: ['owner', 'manager'] } }, select: { id: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    await this.prisma.sitePublication.updateMany({ where: { projectId }, data: { weeklyReport: enabled } });
    return this.status(userId, projectId);
  }
}

function causeText(cause: string | null): string {
  switch (cause) {
    case 'TIMEOUT': return tr('не ответил за 10 секунд');
    case 'DNS': return tr('домен не находится — проверьте настройки DNS');
    case 'TLS': return tr('ошибка сертификата HTTPS');
    case 'REFUSED': return tr('сервер не принимает соединение');
    case 'NOT_PUBLIC': return tr('домен указывает не на BuildPath');
    default: return cause?.startsWith('HTTP_') ? tr('ответ с ошибкой {0}', [cause.slice(5)]) : tr('ошибка соединения');
  }
}

const liveTexts: Record<string, { title: string; fix: string }> = {
  https: { title: 'Сайт открывается по HTTPS', fix: 'Без HTTPS браузер помечает сайт как небезопасный. Для своего домена дождитесь выпуска сертификата или проверьте DNS.' },
  hsts: { title: 'Браузеру велено всегда открывать сайт по HTTPS (HSTS)', fix: 'Заголовок Strict-Transport-Security ставит сервер сайтов при HTTPS; если его нет — сообщите в поддержку.' },
  http_redirect: { title: 'Адрес с http:// переводит на https://', fix: 'Иначе часть посетителей останется на незащищённой версии.' },
  csp: { title: 'Политика безопасности содержимого (CSP)', fix: 'Запрещает странице загружать чужие скрипты.' },
  frame: { title: 'Сайт нельзя встроить в чужую страницу', fix: 'Защищает от подмены страницы внутри чужого сайта.' },
  nosniff: { title: 'Браузер не угадывает тип файлов', fix: 'Заголовок X-Content-Type-Options: nosniff.' },
  referrer: { title: 'Политика передачи адреса страницы (Referrer-Policy)', fix: 'Не даёт отправлять чужим сайтам полный адрес страницы.' },
  permissions: { title: 'Ограничены камера, микрофон и геолокация', fix: 'Заголовок Permissions-Policy.' },
  robots: { title: 'Файл robots.txt отвечает', fix: 'Поисковики читают из него карту сайта.' },
};

function liveCheckView(check: LiveCheck | null) {
  if (!check) return null;
  return {
    url: check.url, checkedAt: check.checkedAt, reachable: check.reachable, error: check.error ? causeText(check.error) : null, ms: check.ms,
    items: check.items.map((item) => ({ ...item, title: tr(liveTexts[item.id]?.title ?? item.id), fix: item.status === 'failed' ? tr(liveTexts[item.id]?.fix ?? '') : null })),
  };
}
