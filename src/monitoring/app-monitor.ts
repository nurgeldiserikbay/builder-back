// After launch (PRODUCT_LIFECYCLE §4.13): a launched application's /api/health, checked every 10 minutes — by the platform
// for an address on the internet, by the owner's agent for one inside a closed network. The same rule as for sites: two
// failed checks in a row mean «down»; the owner is told once when it goes down and once when it is back.
import type { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { CHECK_INTERVAL_MS, duration, nextState, type MonitorStatus, type Probe } from './monitor-rules.js';

/** Words for what the check saw, for the owner. */
export function appCauseText(cause: string | null): string {
  if (!cause) return tr('нет ответа');
  if (cause === 'TIMEOUT') return tr('не ответило за минуту');
  if (cause === 'DNS') return tr('адрес не находится');
  if (cause === 'TLS') return tr('ошибка сертификата HTTPS');
  if (cause === 'REFUSED') return tr('соединение отклонено');
  if (cause === 'NOT_HEALTH_ANSWER') return tr('адрес отвечает, но не как приложение: /api/health без «ok»');
  if (cause === 'NOT_PUBLIC') return tr('адрес ведёт во внутреннюю сеть');
  if (cause === 'APP_UNREACHABLE') return tr('не отвечает изнутри сети');
  if (cause === 'APP_TIMEOUT') return tr('не ответило за минуту изнутри сети');
  const http = /^HTTP_(\d{3})$/.exec(cause);
  if (http) return tr('ответ сервера {0}', [http[1]]);
  return tr('ошибка');
}

/**
 * Whether a project's application is watched now: an application whose launch was accepted and whose address was
 * checked at least once. The agent's reports count only for an application checked through the agent.
 */
export async function watchedApp(prisma: Pick<PrismaService, 'projectStage' | 'appDeployment'>, projectId: string) {
  const launch = await prisma.projectStage.findFirst({ where: { projectId, stageKey: 'launch' }, select: { status: true } });
  if (launch?.status !== 'approved') return null;
  return prisma.appDeployment.findUnique({ where: { projectId } });
}

/** Applies one check of the application and tells the owner when it went down or came back. */
export async function recordAppCheck(prisma: PrismaService, input: { projectId: string; probe: Probe; via: 'platform' | 'network_agent'; now?: Date }): Promise<'down' | 'recovered' | null> {
  const now = input.now ?? new Date();
  const app = await watchedApp(prisma, input.projectId);
  if (!app || app.checkedVia !== input.via) return null;
  const step = nextState({ status: app.monitorStatus as MonitorStatus, failures: app.monitorFailures, downSince: app.monitorDownSince, alertedAt: app.monitorAlertedAt }, input.probe, now);
  const moved = await prisma.$transaction(async (tx) => {
    // Conditional on the state read: two checks at once (the hourly round and the agent) do not both open an incident.
    const updated = await tx.appDeployment.updateMany({
      where: { projectId: input.projectId, monitorStatus: app.monitorStatus, monitorFailures: app.monitorFailures },
      data: { monitorStatus: step.state.status, monitorFailures: step.state.failures, monitorDownSince: step.state.downSince, monitorAlertedAt: step.state.alertedAt, monitorCheckedAt: now, monitorLastMs: input.probe.ms, monitorLastError: input.probe.error?.slice(0, 40) ?? null },
    });
    if (updated.count !== 1) return false;
    if (step.incident === 'open') await tx.appIncident.create({ data: { projectId: input.projectId, startedAt: step.state.downSince ?? now, cause: (input.probe.error ?? 'ERROR').slice(0, 40), via: input.via } });
    if (step.incident === 'close') await tx.appIncident.updateMany({ where: { projectId: input.projectId, endedAt: null }, data: { endedAt: now } });
    if (step.alert) await tx.projectEvent.create({ data: { projectId: input.projectId, actorUserId: null, type: step.alert === 'down' ? 'app_down' : 'app_recovered', stageKey: 'launch', details: { status: step.state.status, outcome: input.probe.error ?? 'ok' } } });
    return true;
  });
  if (!moved || !step.alert) return null;
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { name: true, ownerUserId: true } });
  if (!project) return null;
  const link = { path: `/projects/${input.projectId}/stages/launch`, label: () => tr('Открыть проект') };
  if (step.alert === 'down') {
    await notifyUser(prisma, project.ownerUserId, { category: 'site', link,
      emailSubject: () => tr('BuildPath: приложение «{0}» не отвечает', [project.name]),
      text: () => tr('Приложение «{0}» не отвечает ({1}). Проверяем каждые 10 минут и напишем, когда оно снова заработает. {2}', [project.name, appCauseText(input.probe.error), app.url]),
    });
  } else {
    const down = duration(now.getTime() - (app.monitorDownSince ?? now).getTime());
    await notifyUser(prisma, project.ownerUserId, { category: 'site', link,
      emailSubject: () => tr('BuildPath: приложение «{0}» снова работает', [project.name]),
      text: () => tr('Приложение «{0}» снова отвечает. Не работало примерно {1} ч {2} мин.', [project.name, down.hours, down.minutes]),
    });
  }
  return step.alert;
}

/** What the launch page shows about watching the application. */
export async function appMonitoringView(prisma: Pick<PrismaService, 'projectStage' | 'appDeployment' | 'appIncident' | 'networkAgent'>, projectId: string, now = new Date()) {
  const app = await watchedApp(prisma, projectId);
  if (!app) return { watched: false as const };
  const incidents = await prisma.appIncident.findMany({ where: { projectId }, orderBy: { startedAt: 'desc' }, take: 5 });
  // Through the agent: the checks come only while the agent runs and is new enough to send them.
  const agent = app.checkedVia === 'network_agent' ? await prisma.networkAgent.findFirst({ where: { projectId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { version: true, lastSeenAt: true } }) : null;
  const stale = !app.monitorCheckedAt || now.getTime() - app.monitorCheckedAt.getTime() > 3 * CHECK_INTERVAL_MS;
  return {
    watched: true as const, url: app.url, via: app.checkedVia, status: app.monitorStatus, downSince: app.monitorDownSince, checkedAt: app.monitorCheckedAt, lastMs: app.monitorLastMs,
    lastError: app.monitorLastError, lastErrorText: app.monitorLastError ? appCauseText(app.monitorLastError) : null, stale,
    agent: agent ? { version: agent.version, lastSeenAt: agent.lastSeenAt, reports: agentReports(agent.version) } : null,
    incidents: incidents.map((item) => ({ startedAt: item.startedAt, endedAt: item.endedAt, cause: item.cause, causeText: appCauseText(item.cause) })),
  };
}

/** The agent sends health checks on its own from version 1.1.0. */
export function agentReports(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return Boolean(match && (Number(match[1]) > 1 || Number(match[2]) >= 1));
}

export type { Probe };
