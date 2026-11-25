// «Вы это учли?»: situations a business of this kind usually has to decide on, asked in plain words with ready answers.
// The owner knows the business but not the usual practice, so each question carries the answer most businesses choose.
// The chosen answer becomes a rule of the business process — the owner's own decision, never invented by AI.
// Texts are written in Russian; the English dictionary (en.ts) translates them like any platform text.
import { tr, trl, type Locale } from '../i18n/i18n.js';
import type { ProjectTypeKey } from './catalog.js';

export const SITUATIONS_VERSION = '1.0.0';

/** blocking — the site cannot work honestly without an answer; important — clients will ask; minor — good to decide. */
export type SituationLevel = 'blocking' | 'important' | 'minor';

export interface SituationOption {
  value: string;
  label: string;
  /** The rule this answer adds to the business process. */
  rule: string;
  /** What most businesses of this kind choose. One per situation. */
  typical?: boolean;
}

export interface Situation {
  key: string;
  level: SituationLevel;
  question: string;
  why: string;
  types: ProjectTypeKey[];
  options: SituationOption[];
}

const SITES: ProjectTypeKey[] = ['landing', 'company_site', 'multipage', 'store', 'booking'];

export const SITUATIONS: Situation[] = [
  {
    key: 'who_answers', level: 'important', types: SITES,
    question: 'Кто отвечает клиентам, когда приходит заявка, запись или заказ?',
    why: 'Уведомления придут этому человеку. Если ответить некому, клиент уйдёт к другим.',
    options: [
      { value: 'owner', label: 'Я сам', rule: 'На заявки, записи и заказы отвечает владелец.', typical: true },
      { value: 'admin', label: 'Администратор, а я вижу всё', rule: 'На заявки, записи и заказы отвечает администратор; владелец видит их все.' },
    ],
  },
  {
    key: 'response_time', level: 'important', types: ['landing', 'company_site', 'multipage'],
    question: 'Как быстро вы отвечаете на заявку?',
    why: 'Срок ответа напишем рядом с формой: клиент спокойнее ждёт, когда знает, сколько.',
    options: [
      { value: 'hour', label: 'В течение часа в рабочее время', rule: 'Отвечаем на заявки в течение часа в рабочее время.', typical: true },
      { value: 'day', label: 'В тот же рабочий день', rule: 'Отвечаем на заявки в течение рабочего дня.' },
      { value: 'next_day', label: 'На следующий рабочий день', rule: 'Отвечаем на заявки на следующий рабочий день.' },
    ],
  },
  {
    key: 'after_hours', level: 'minor', types: ['landing', 'company_site', 'multipage', 'store'],
    question: 'Клиент пишет ночью или в выходной. Что тогда?',
    why: 'Если честно написать, когда ответите, ночная заявка не превратится в обиду.',
    options: [
      { value: 'next_morning', label: 'Отвечаем утром рабочего дня', rule: 'Заявки в нерабочее время разбираем утром следующего рабочего дня.', typical: true },
      { value: 'always', label: 'Отвечаем в любое время', rule: 'Отвечаем клиентам в любое время, включая выходные.' },
    ],
  },
  {
    key: 'unhappy_client', level: 'minor', types: ['company_site', 'multipage'],
    question: 'Клиент недоволен результатом работы. Как поступаете?',
    why: 'Понятное обещание снимает страх заказать впервые. Обещайте только то, что действительно делаете.',
    options: [
      { value: 'redo', label: 'Бесплатно исправляем недочёты', rule: 'Если клиент недоволен результатом, бесплатно исправляем недочёты.', typical: true },
      { value: 'discuss', label: 'Решаем в каждом случае отдельно', rule: 'Если клиент недоволен результатом, обсуждаем и решаем в каждом случае отдельно.' },
    ],
  },
  {
    key: 'booking_cancel', level: 'blocking', types: ['booking'],
    question: 'Клиент хочет отменить или перенести запись. До какого срока можно?',
    why: 'Без этого правила клиенты отменяют в последний момент, и время пропадает. Точный срок потом поставите в расписании.',
    options: [
      { value: 'hours_24', label: 'Не позже чем за сутки', rule: 'Отменить или перенести запись можно не позже чем за 24 часа до визита.', typical: true },
      { value: 'hours_3', label: 'Не позже чем за 3 часа', rule: 'Отменить или перенести запись можно не позже чем за 3 часа до визита.' },
      { value: 'anytime', label: 'В любое время', rule: 'Отменить или перенести запись можно в любое время.' },
    ],
  },
  {
    key: 'no_show', level: 'important', types: ['booking'],
    question: 'Клиент записался и не пришёл. Что делаете?',
    why: 'Неявки — главная потеря времени у мастеров. Правило помогает не ссориться с клиентами.',
    options: [
      { value: 'warn_then_prepay', label: 'Предупреждаю, после двух раз — только по предоплате', rule: 'Если клиент не пришёл без предупреждения, связываемся с ним; после двух неявок записываем только по предоплате.', typical: true },
      { value: 'prepay', label: 'Всегда беру предоплату', rule: 'Запись подтверждается предоплатой; если клиент не пришёл без предупреждения, предоплата не возвращается.' },
      { value: 'nothing', label: 'Ничего не делаю', rule: 'Если клиент не пришёл, запись просто закрываем.' },
    ],
  },
  {
    key: 'late', level: 'minor', types: ['booking'],
    question: 'Клиент опаздывает. Как поступаете?',
    why: 'Опоздание одного клиента сдвигает всех следующих.',
    options: [
      { value: 'wait_15', label: 'Жду до 15 минут, потом перенос', rule: 'Ждём опоздавшего клиента до 15 минут, дальше переносим запись.', typical: true },
      { value: 'shorten', label: 'Делаю за оставшееся время', rule: 'Если клиент опоздал, делаем услугу за оставшееся время записи, цена не меняется.' },
    ],
  },
  {
    key: 'master_absent', level: 'important', types: ['booking'],
    question: 'Мастер заболел или ушёл в отпуск, а к нему есть записи. Что делаете?',
    why: 'Клиент должен узнать об этом до того, как придёт.',
    options: [
      { value: 'offer_other', label: 'Предлагаю другого мастера или время', rule: 'Если мастер не может работать, заранее предлагаем клиенту другого мастера или другое время.', typical: true },
      { value: 'cancel', label: 'Звоню и отменяю запись', rule: 'Если мастер не может работать, заранее звоним клиенту и отменяем запись.' },
    ],
  },
  {
    key: 'reminder', level: 'minor', types: ['booking'],
    question: 'Напоминать клиенту о записи?',
    why: 'Напоминание за день заметно сокращает неявки.',
    options: [
      { value: 'day_before', label: 'Да, за день', rule: 'Напоминаем клиенту о записи за день до визита.', typical: true },
      { value: 'none', label: 'Не напоминать', rule: 'Клиенту о записи не напоминаем.' },
    ],
  },
  {
    key: 'returns', level: 'blocking', types: ['store'],
    question: 'Клиент хочет вернуть или обменять товар. Как поступаете?',
    why: 'Покупатели ищут это правило перед заказом, без него многие не решаются купить.',
    options: [
      { value: 'days_14', label: 'В течение 14 дней, кроме продуктов и товаров на заказ', rule: 'Товар без следов использования можно вернуть или обменять в течение 14 дней; продукты и товары, сделанные на заказ, не возвращаются.', typical: true },
      { value: 'defect_only', label: 'Только товар с браком', rule: 'Возвращаем и меняем только товар с браком.' },
    ],
  },
  {
    key: 'out_of_stock', level: 'important', types: ['store'],
    question: 'Клиент заказал, а товара не оказалось. Что делаете?',
    why: 'Так бывает даже у аккуратных магазинов. Важно, чтобы клиент узнал об этом от вас, а не в день доставки.',
    options: [
      { value: 'call_replace', label: 'Звоню и предлагаю замену', rule: 'Если товара нет, связываемся с клиентом и предлагаем замену или убираем товар из заказа.', typical: true },
      { value: 'cancel', label: 'Отменяю заказ и сообщаю', rule: 'Если товара нет, отменяем заказ и сообщаем клиенту.' },
    ],
  },
  {
    key: 'order_confirm', level: 'important', types: ['store'],
    question: 'Как клиент узнает, что заказ принят?',
    why: 'Без подтверждения клиент не знает, ждать ли заказ, и звонит или уходит.',
    options: [
      { value: 'within_hour', label: 'Подтверждаю в течение часа', rule: 'Подтверждаем заказ звонком или сообщением в течение часа в рабочее время.', typical: true },
      { value: 'accepted_at_once', label: 'Заказ принят сразу, звоню только при проблемах', rule: 'Заказ считается принятым сразу; связываемся с клиентом, только если что-то не так.' },
    ],
  },
  {
    key: 'delivery_failed', level: 'minor', types: ['store'],
    question: 'Курьер приехал, а клиента нет. Что дальше?',
    why: 'Повторная доставка стоит денег, клиенту лучше знать правило заранее.',
    options: [
      { value: 'reschedule', label: 'Договариваемся о новом времени', rule: 'Если доставка не удалась, договариваемся с клиентом о новом времени; повторная доставка оплачивается отдельно.', typical: true },
      { value: 'pickup', label: 'Заказ ждёт на самовывозе', rule: 'Если доставка не удалась, заказ ждёт клиента на самовывозе 3 дня.' },
    ],
  },
  {
    key: 'lost_access', level: 'important', types: ['web_app'],
    question: 'Пользователь забыл пароль или потерял доступ. Как он вернётся?',
    why: 'Это случается каждый день; без правила к вам будут писать с каждой такой проблемой.',
    options: [
      { value: 'email_link', label: 'Сам, по ссылке на почту', rule: 'Пользователь сам восстанавливает доступ по ссылке, которая приходит на его почту.', typical: true },
      { value: 'admin', label: 'Восстанавливает администратор', rule: 'Доступ восстанавливает администратор по просьбе пользователя.' },
    ],
  },
  {
    key: 'staff_leaves', level: 'important', types: ['web_app'],
    question: 'Сотрудник уволился. Что с его доступом и записями?',
    why: 'Бывший сотрудник не должен видеть данные клиентов, а его работа не должна пропасть.',
    options: [
      { value: 'disable_keep', label: 'Отключаю доступ, записи остаются', rule: 'Когда сотрудник уходит, его доступ сразу отключаем, а созданные им записи остаются в системе.', typical: true },
      { value: 'reassign', label: 'Передаю его записи другому', rule: 'Когда сотрудник уходит, его доступ отключаем, а его записи передаём другому сотруднику.' },
    ],
  },
  {
    key: 'mistake_fix', level: 'minor', types: ['web_app'],
    question: 'Кто-то ошибся и сохранил неверные данные. Можно ли это исправить?',
    why: 'От этого зависит, нужна ли история изменений и кто её видит.',
    options: [
      { value: 'edit_with_history', label: 'Можно исправить, видна история', rule: 'Сохранённые данные можно исправить; каждое изменение записывается в историю с автором и временем.', typical: true },
      { value: 'admin_only', label: 'Исправляет только администратор', rule: 'Исправить сохранённые данные может только администратор.' },
    ],
  },
];

const byKey = new Map(SITUATIONS.map((situation) => [situation.key, situation]));
export const situationOf = (key: string): Situation | undefined => byKey.get(key);
/** The questions of «Вы это учли?» answered «later», as open questions in the project language. */
export const situationQuestions = (keys: string[]): string[] => keys.map((key) => byKey.get(key)).filter((item): item is Situation => Boolean(item)).map((item) => tr(item.question));
export const situationsFor = (type: string | null | undefined): Situation[] => SITUATIONS.filter((situation) => situation.types.includes(type as ProjectTypeKey));

/** Rule texts of every answer in every language, so the platform can tell its own rules from the owner's. */
export function situationRuleTexts(): Set<string> {
  const out = new Set<string>();
  for (const situation of SITUATIONS) for (const option of situation.options) {
    out.add(option.rule);
    out.add(trl('en', option.rule));
  }
  return out;
}

/** The rule of an answer in the given language; an already resolved text in another language is kept as it is. */
export function ruleOf(situation: Situation, value: string, locale: Locale, previous?: string): string | null {
  const option = situation.options.find((item) => item.value === value);
  if (!option) return null;
  const variants = [option.rule, trl('en', option.rule)];
  return previous && variants.includes(previous) ? previous : trl(locale, option.rule);
}
