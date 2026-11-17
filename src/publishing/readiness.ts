// «Готов ли бизнес принимать клиентов?»: the check before a site goes live. The build and its quality report are the
// release gate (they block, as before); everything else is advice with a link to where it is fixed — the owner decides.
import { tr } from '../i18n/i18n.js';
import type { Brief, Offer } from '../journey/artifacts.js';
import type { BusinessProcess } from '../journey/process.js';
import { situationsFor } from '../journey/situations.js';
import type { AppFeatures } from '../journey/webapp.js';
import type { ChannelStatus } from '../notifications/lead-notifier.js';

export const READINESS_VERSION = '1.0.0';

export type ReadinessStatus = 'ok' | 'warn' | 'todo';
export interface ReadinessCheck {
  key: string; status: ReadinessStatus; title: string; text: string;
  /** Where to fix it: a stage of the project, or the publication settings. */
  fix: { stageKey: string } | { publication: 'channels' | 'test' } | null;
}

export interface ReadinessInput {
  projectType: string;
  build: { accepted: boolean; qualityPassed: boolean };
  brief: Brief | null;
  process: BusinessProcess | null;
  spec: AppFeatures | null;
  offer: Offer | null;
  channels: { telegram: 'linked' | 'not_linked' | 'not_configured'; email: boolean };
  /** The last test request the owner sent to themselves, if any. */
  lastTest: { telegram: ChannelStatus; email: ChannelStatus } | null;
  route: string[];
}

export function launchReadiness(input: ReadinessInput): { version: string; checks: ReadinessCheck[]; ready: number; total: number; blocking: boolean } {
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);

  add(input.build.accepted && input.build.qualityPassed
    ? { key: 'build', status: 'ok', title: tr('Сайт собран и проверен'), text: tr('Сборка принята, проверки качества пройдены.'), fix: null }
    : { key: 'build', status: 'todo', title: tr('Сайт собран и проверен'), text: input.build.accepted ? tr('Проверки качества не пройдены: без этого сайт не опубликовать.') : tr('Соберите сайт и примите сборку: без этого его не опубликовать.'), fix: { stageKey: 'build' } });

  const contacts = input.brief ? [input.brief.phone, input.brief.messenger, input.brief.email, input.brief.address].filter(Boolean).length : 0;
  add(contacts
    ? { key: 'contacts', status: 'ok', title: tr('Клиенту есть как с вами связаться'), text: tr('Контактов на сайте: {0}.', [contacts]), fix: null }
    : { key: 'contacts', status: 'warn', title: tr('Клиенту есть как с вами связаться'), text: tr('На сайте нет ни телефона, ни мессенджера, ни почты. Добавьте хотя бы один контакт в цели сайта.'), fix: { stageKey: 'goal' } });

  // Requests reach the owner only through a channel that works; a test request proves it.
  const anyChannel = input.channels.telegram === 'linked' || input.channels.email;
  const delivered = input.lastTest && (input.lastTest.telegram === 'sent' || input.lastTest.email === 'sent');
  add(delivered
    ? { key: 'requests', status: 'ok', title: tr('Заявки доходят до вас'), text: tr('Тестовая заявка пришла: {0}.', [[input.lastTest!.telegram === 'sent' ? 'Telegram' : null, input.lastTest!.email === 'sent' ? tr('почта') : null].filter(Boolean).join(', ')]), fix: null }
    : anyChannel
      ? { key: 'requests', status: 'warn', title: tr('Заявки доходят до вас'), text: input.lastTest ? tr('Тестовая заявка не дошла. Проверьте, что Telegram подключён и почта верна, и отправьте ещё раз.') : tr('Отправьте себе тестовую заявку: так вы увидите, куда придут настоящие.'), fix: { publication: 'test' } }
      : { key: 'requests', status: 'warn', title: tr('Заявки доходят до вас'), text: tr('Уведомления о заявках никуда не придут. Подключите Telegram или включите письма на почту.'), fix: { publication: 'channels' } });

  if (input.route.includes('process')) {
    const answers = new Map((input.process?.situations ?? []).map((item) => [item.key, item.answer]));
    const open = situationsFor(input.projectType).filter((item) => !answers.get(item.key) || answers.get(item.key) === 'later');
    add(open.length
      ? { key: 'situations', status: 'warn', title: tr('Решено, как вы работаете с клиентами'), text: tr('Не решено в «Вы это учли?»: {0}.', [open.map((item) => tr(item.question)).join(' · ')]), fix: { stageKey: 'process' } }
      : { key: 'situations', status: 'ok', title: tr('Решено, как вы работаете с клиентами'), text: tr('На все вопросы «Вы это учли?» есть ответы.'), fix: null });
  }

  if (input.route.includes('features')) {
    const questions = input.spec?.questions ?? [];
    add(questions.length
      ? { key: 'spec', status: 'warn', title: tr('В ТЗ нет открытых вопросов'), text: tr('Открытых вопросов: {0}. Например: {1}', [questions.length, questions[0]!]), fix: { stageKey: 'features' } }
      : { key: 'spec', status: 'ok', title: tr('В ТЗ нет открытых вопросов'), text: tr('Все вопросы ТЗ решены.'), fix: null });
  }

  if (input.route.includes('offer') && input.offer) {
    const noPrice = input.offer.services.filter((service) => !service.price);
    add(noPrice.length
      ? { key: 'prices', status: 'warn', title: tr('У услуг есть цены'), text: tr('Без цены: {0}. Клиенты чаще выбирают, когда видят цену или хотя бы «от».', [noPrice.map((service) => service.name).join(', ')]), fix: { stageKey: 'offer' } }
      : { key: 'prices', status: 'ok', title: tr('У услуг есть цены'), text: tr('Цены указаны у всех услуг.'), fix: null });
  }

  if (input.projectType === 'booking') {
    const cancel = (input.process?.situations ?? []).find((item) => item.key === 'booking_cancel');
    add(cancel && cancel.answer !== 'later'
      ? { key: 'cancellation', status: 'ok', title: tr('Понятно, как отменить запись'), text: cancel.rule ?? tr('Правило отмены задано.'), fix: null }
      : { key: 'cancellation', status: 'warn', title: tr('Понятно, как отменить запись'), text: tr('Не задано, до какого срока клиент может отменить или перенести запись.'), fix: { stageKey: 'process' } });
  }

  const ready = checks.filter((check) => check.status === 'ok').length;
  return { version: READINESS_VERSION, checks, ready, total: checks.length, blocking: checks.some((check) => check.status === 'todo') };
}
