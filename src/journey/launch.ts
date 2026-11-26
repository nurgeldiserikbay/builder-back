// «Подготовка к запуску» of a web application (builder-docs PRODUCT_LIFECYCLE.md §4.11): what must be true before people
// use it. Part is checked by the platform — the test plan's own rule (blocking cases passed, main scenarios accepted, no
// open remarks) and the deployment the owner gave (it answers over HTTPS on a real database). The rest the owner confirms
// item by item, or says why it is not needed: domain, legal texts, outgoing mail, backups, monitoring, data from an old
// system, measuring the goals of success, a security audit. A failed platform check blocks the launch unless the owner
// accepts the risk in writing — the same written explanation as for any blocking finding.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import type { ArchitectureDesign } from './architecture.js';
import type { IdeaReview } from './idea.js';
import type { AppFeatures } from './webapp.js';
import { HOSTING_SUBDOMAIN } from '../choices/cards.js';

export const LAUNCH_VERSION = '1.0.0';
export const LAUNCH_ITEMS = ['domain', 'legal', 'email', 'backups', 'monitoring', 'migration', 'analytics', 'audit'] as const;
export type LaunchItemKey = (typeof LAUNCH_ITEMS)[number];
export type LaunchItemStatus = 'todo' | 'done' | 'not_needed';
export interface LaunchItem { key: LaunchItemKey; status: LaunchItemStatus; note: string }
export interface LaunchChecklist { items: LaunchItem[] }

export function normalizeLaunch(raw: unknown): LaunchChecklist {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const given = Array.isArray(value.items) ? value.items : [];
  return {
    items: LAUNCH_ITEMS.map((key) => {
      const item = given.find((one) => one && typeof one === 'object' && (one as Record<string, unknown>).key === key) as Record<string, unknown> | undefined;
      const note = typeof item?.note === 'string' ? item.note.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (note.length > 400) throw new ArtifactValidationError(`FIELD_TOO_LONG:items.${key}.note`);
      const status = item?.status === 'done' || item?.status === 'not_needed' ? item.status : 'todo';
      return { key, status, note };
    }),
  };
}

/** What the platform knows when the checklist is read: the test plan's state and the last deployment check. */
export interface LaunchFacts {
  readiness: { blocking: { total: number; passed: number }; scenarios: { total: number; works: number }; openRemarks: number } | null;
  deployment: { url: string; ok: boolean; database: string | null; checkedAt: string; checkedVia?: string } | null;
  features: AppFeatures | null;
  idea: IdeaReview | null;
  design: ArchitectureDesign | null;
  /** The «Адрес приложения» decision: own domain or the hosting's address; null when not decided. */
  domainChoice?: 'own_domain' | 'host_address' | null;
  /** Module stages of the accepted plan (§4.9) that are not accepted yet; absent for projects without them. */
  modulesOpen?: string[];
}

export interface LaunchItemInfo { key: LaunchItemKey; title: string; why: string; required: boolean }

/** The items in the owner's words, with why each matters for this project; «required» ones cannot be «не нужно». */
export function launchItems(facts: LaunchFacts): LaunchItemInfo[] {
  const sensitive = (facts.features?.sensitivity ?? 'normal') !== 'normal';
  const money = facts.features?.sensitivity === 'payments' || (facts.design?.components ?? []).some((item) => item.kind === 'payments');
  const mail = (facts.design?.components ?? []).some((item) => item.kind === 'email');
  const metrics = (facts.idea?.metrics ?? []).map((item) => item.text).filter(Boolean);
  return [
    { key: 'domain', title: tr('Свой адрес сайта'), why: facts.domainChoice === 'own_domain' ? tr('В решении «Адрес приложения» выбран свой домен: подключите его у хостинга и проверьте приложение по нему.') : tr('Адрес вида имя.onrender.com работает, но клиенты больше доверяют своему домену. Сертификат HTTPS хостинг выпускает сам.'), required: facts.domainChoice === 'own_domain' },
    { key: 'legal', title: tr('Политика конфиденциальности, согласие и условия'), why: sensitive ? tr('Приложение хранит личные данные: по закону нужны политика и согласие, а при оплате — оферта.') : tr('Если вы собираете хоть какие-то данные людей, нужна политика конфиденциальности.'), required: sensitive },
    { key: 'email', title: tr('Почта для писем приложения'), why: mail ? tr('Приложение отправляет письма: нужен почтовый сервис (например, Resend) и подтверждённый домен отправителя, иначе письма уйдут в спам.') : tr('Нужна, если приложение отправляет письма: восстановление пароля, уведомления.'), required: mail },
    { key: 'backups', title: tr('Резервные копии и проверка восстановления'), why: tr('Копии базы делаются по расписанию, и хотя бы раз вы восстановили из копии в тестовом окружении.'), required: true },
    { key: 'monitoring', title: tr('Кто узнаёт о сбое'), why: tr('Сервис проверки доступности (например, UptimeRobot) раз в несколько минут открывает /api/health и пишет вам, если приложение не отвечает.'), required: true },
    { key: 'migration', title: tr('Данные из старой системы'), why: tr('Если клиенты, заказы или записи уже есть в таблицах или другой программе — перенесите их до запуска.'), required: false },
    { key: 'analytics', title: tr('Как поймём, что всё работает'), why: metrics.length ? tr('Цели успеха из разбора идеи: {0}. Решите, где их считать.', [metrics.join('; ')]) : tr('Решите, какие цифры покажут, что приложение помогает: заявки, повторные клиенты, время ответа.'), required: false },
    { key: 'audit', title: tr('Проверка безопасности специалистом'), why: money || sensitive ? tr('Автоматические проверки не заменяют аудит. Для денег и личных данных мы рекомендуем специалиста по безопасности; без него будет видно «проверено автоматически, аудит не проводился».') : tr('Для приложения без денег и личных данных достаточно автоматических проверок.'), required: false },
  ];
}

export interface LaunchIssue { code: string; severity: 'blocking' | 'important' | 'minor'; target: string; message: string; fix: string }

export function launchIssues(value: LaunchChecklist, facts: LaunchFacts): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  const readiness = facts.readiness;
  if (!readiness) issues.push({ code: 'LAUNCH_NO_TESTPLAN', severity: 'blocking', target: 'tests', message: tr('План проверки не утверждён: непонятно, что считать «работает».'), fix: tr('Утвердите план проверки.') });
  else {
    if (readiness.blocking.passed < readiness.blocking.total) issues.push({ code: 'LAUNCH_TESTS_NOT_PASSED', severity: 'blocking', target: 'tests', message: tr('Блокирующие кейсы пройдены не все: {0} из {1}.', [readiness.blocking.passed, readiness.blocking.total]), fix: tr('Доведите кейсы до «работает» в плане проверки или примите риск письменно.') });
    if (readiness.scenarios.works < readiness.scenarios.total) issues.push({ code: 'LAUNCH_SCENARIOS_NOT_ACCEPTED', severity: 'blocking', target: 'tests', message: tr('Вы приняли не все главные сценарии: {0} из {1}.', [readiness.scenarios.works, readiness.scenarios.total]), fix: tr('Пройдите сценарии в тестовой версии и отметьте их в «Приёмке владельцем».') });
    if (readiness.openRemarks > 0) issues.push({ code: 'LAUNCH_OPEN_REMARKS', severity: 'blocking', target: 'tests', message: tr('Открытых замечаний по сценариям: {0}.', [readiness.openRemarks]), fix: tr('Когда замечания поправят, отметьте сценарии «Работает».') });
  }
  // Not blocking: the test plan's cases already decide whether the whole works; a module left open is still worth knowing.
  if (facts.modulesOpen?.length) issues.push({ code: 'LAUNCH_MODULES_NOT_ACCEPTED', severity: 'important', target: 'modules', message: tr('Не приняты модули: {0}.', [facts.modulesOpen.join(', ')]), fix: tr('Примите модули на их этапах или объясните, почему запускаете без них.') });
  const deployment = facts.deployment;
  if (!deployment || !deployment.ok) issues.push({ code: 'LAUNCH_NOT_DEPLOYED', severity: 'blocking', target: 'deployment', message: deployment ? tr('Приложение по адресу {0} не ответило при последней проверке.', [deployment.url]) : tr('Не указан адрес, где работает приложение.'), fix: tr('Разверните приложение и проверьте адрес в «Пакете для разработки», блок «Запуск у вас».') });
  else {
    if (!deployment.url.startsWith('https://')) issues.push({ code: 'LAUNCH_NO_HTTPS', severity: 'blocking', target: 'deployment', message: tr('Приложение открывается без HTTPS: пароли и данные пойдут открытым текстом.'), fix: tr('Включите HTTPS у хостинга и проверьте адрес с https://.') });
    // Own domain chosen, but the checked address is still the hosting's: people would be given the wrong address.
    let host = '';
    try { host = new URL(deployment.url).hostname; } catch { host = ''; }
    if (facts.domainChoice === 'own_domain' && HOSTING_SUBDOMAIN.test(host)) issues.push({ code: 'LAUNCH_DOMAIN_NOT_CHECKED', severity: 'important', target: 'domain', message: tr('Выбран свой домен, а проверен адрес хостинга {0}.', [host]), fix: tr('Подключите домен у хостинга и проверьте приложение по нему в «Пакете для разработки», блок «Запуск у вас».') });
    if (deployment.database !== 'postgres') issues.push({ code: 'LAUNCH_MEMORY_DATABASE', severity: 'blocking', target: 'deployment', message: tr('Приложение работает без базы данных: всё введённое пропадёт при перезапуске.'), fix: tr('Укажите DATABASE_URL у хостинга, выполните миграцию и проверьте адрес снова.') });
  }
  for (const item of launchItems(facts)) {
    const answer = value.items.find((one) => one.key === item.key)!;
    if (answer.status === 'todo') issues.push({ code: 'LAUNCH_ITEM_OPEN', severity: item.required ? 'important' : 'minor', target: item.key, message: tr('Не решено: {0}.', [item.title]), fix: item.required ? tr('Сделайте и отметьте «Готово».') : tr('Отметьте «Готово» или «Не нужно» с причиной.') });
    else if (answer.status === 'not_needed' && item.required) issues.push({ code: 'LAUNCH_ITEM_REQUIRED', severity: 'important', target: item.key, message: tr('«{0}» для этого приложения нужно.', [item.title]), fix: item.why });
    else if (answer.status === 'not_needed' && !answer.note) issues.push({ code: 'LAUNCH_ITEM_NO_REASON', severity: 'minor', target: item.key, message: tr('Не написано, почему не нужно: {0}.', [item.title]), fix: tr('Одной фразой: почему это не нужно сейчас.') });
  }
  const audit = value.items.find((one) => one.key === 'audit')!;
  if ((facts.features?.sensitivity ?? 'normal') !== 'normal' && audit.status !== 'done') issues.push({ code: 'LAUNCH_NO_AUDIT', severity: 'minor', target: 'audit', message: tr('Проверено автоматически, аудит безопасности не проводился.'), fix: tr('Для денег и личных данных мы рекомендуем специалиста по безопасности.') });
  return issues;
}

export function launchMarkdown(value: LaunchChecklist, facts: LaunchFacts): string {
  const marks: Record<LaunchItemStatus, string> = { done: '✓', not_needed: '—', todo: '☐' };
  return [
    `# ${tr('Подготовка к запуску')}`, '',
    ...(facts.deployment ? [`${tr('Адрес')}: ${facts.deployment.url} — ${facts.deployment.ok ? tr('отвечает') : tr('не отвечает')}`, ''] : []),
    ...(facts.readiness ? [tr('Блокирующие кейсы: {0} из {1}; главные сценарии: {2} из {3}; открытых замечаний: {4}.', [facts.readiness.blocking.passed, facts.readiness.blocking.total, facts.readiness.scenarios.works, facts.readiness.scenarios.total, facts.readiness.openRemarks]), ''] : []),
    ...launchItems(facts).map((item) => { const answer = value.items.find((one) => one.key === item.key)!; return `- ${marks[answer.status]} ${item.title}${answer.note ? ` — ${answer.note}` : ''}`; }), '',
  ].join('\n');
}

export function launchChanges(before: LaunchChecklist, after: LaunchChecklist): string[] {
  return after.items.filter((item) => { const was = before.items.find((one) => one.key === item.key); return !was || was.status !== item.status || was.note !== item.note; }).map((item) => tr('Изменён пункт: {0}', [item.key]));
}
