// «Расскажите о своём деле»: the owner describes the business; a few plain questions pick the kind of project.
// A newcomer cannot tell a company site from a multi-page one, so they answer about their business, not about websites.
// Deterministic and free: no AI before a project (and its wallet) exists. The description hints the answers; the owner
// confirms them.
import type { ProjectTypeKey } from './catalog.js';

export const TYPE_QUESTIONS_VERSION = '1.0.0';

export type TypeAnswers = { appointments?: boolean; products?: boolean; accounts?: boolean; size?: 'one' | 'few' | 'many' };
export type TypeQuestionKey = keyof TypeAnswers;

export interface TypeQuestion {
  key: TypeQuestionKey;
  question: string;
  hint: string;
  options: Array<{ value: string; label: string }>;
  /** Asked only when the earlier answers have not decided the type. */
  onlyIfNoneOf?: TypeQuestionKey[];
}

export const TYPE_QUESTIONS: TypeQuestion[] = [
  {
    key: 'appointments', question: 'Клиенты записываются к вам на определённое время?',
    hint: 'Например, к мастеру, тренеру, врачу или репетитору.',
    options: [{ value: 'yes', label: 'Да' }, { value: 'no', label: 'Нет' }],
  },
  {
    key: 'products', question: 'Вы продаёте товары, и клиенты выбирают и заказывают их сами?',
    hint: 'Например, торты, одежду, цветы, мебель на заказ.',
    options: [{ value: 'yes', label: 'Да' }, { value: 'no', label: 'Нет' }],
  },
  {
    key: 'accounts', question: 'Нужно, чтобы клиенты или сотрудники входили в личный кабинет и работали в нём?',
    hint: 'Например, учёт заказов, кабинет ученика, внутренний сервис для команды. Обычному сайту это не нужно.',
    options: [{ value: 'yes', label: 'Да' }, { value: 'no', label: 'Нет' }],
  },
  {
    key: 'size', question: 'Сколько нужно рассказать о вашем деле?',
    hint: 'Если сомневаетесь, выбирайте меньше: страницы можно добавить потом.',
    onlyIfNoneOf: ['appointments', 'products', 'accounts'],
    options: [
      { value: 'one', label: 'Хватит одной страницы' },
      { value: 'few', label: 'Несколько разделов: услуги, о нас, отзывы, контакты' },
      { value: 'many', label: 'Много: отдельные страницы услуг, направлений, статей' },
    ],
  },
];

const REASONS: Record<ProjectTypeKey, string> = {
  booking: 'Клиенты приходят к вам на время, поэтому главное на сайте — свободное время и запись без звонков.',
  store: 'Вы продаёте товары, поэтому главное — каталог с ценами, корзина и заказ.',
  web_app: 'Нужен личный кабинет и работа с данными — это уже приложение, а не сайт. ИИ подготовит описание, схемы, прототип и стартовый код, а экраны, вход и базу данных пока доделывает разработчик.',
  landing: 'Рассказать о деле можно на одной странице: так проще, быстрее и понятнее клиенту.',
  company_site: 'Вам нужно несколько разделов — услуги, о компании, отзывы, контакты — на одной удобной странице с меню.',
  multipage: 'Информации много: отдельные страницы для услуг и направлений удобнее, чем одна длинная.',
};

// Words that hint an answer. Only hints: the owner sees the answers pre-selected and can change them.
const HINTS: Array<{ key: Exclude<TypeQuestionKey, 'size'>; words: RegExp }> = [
  { key: 'appointments', words: /запис|приём|прием|мастер|маникюр|барбер|стрижк|салон|массаж|тренер|репетитор|урок|консультац|сеанс|appointment|booking|book a|salon|barber|massage|tutor|lesson/i },
  { key: 'products', words: /продаю|продаём|продаем|продажа|товар|магазин|торт|выпечк|одежд|цвет[ыо]|букет|доставк|заказ[а-я]* (?:торт|товар|цвет)|shop|store|sell|products?\b|cakes?|clothes|flowers/i },
  { key: 'accounts', words: /личн[а-я]* кабинет|учёт|учет|crm|вход для|логин|сотрудник[иа]? (?:вед|заполн|отмеча)|ученик[иа]? (?:вход|смотр)|account|dashboard|portal|log in|login/i },
];

export function hintAnswers(description: string): TypeAnswers {
  const out: TypeAnswers = {};
  for (const hint of HINTS) if (hint.words.test(description)) out[hint.key] = true;
  return out;
}

export interface TypeSuggestion { type: ProjectTypeKey; reason: string; alternatives: ProjectTypeKey[]; missing: TypeQuestionKey[] }

/**
 * The type from the answers: an account area makes it an app, appointments a booking site, products a store; otherwise
 * the amount of information decides between one page, a company site and a multi-page site. `missing` lists questions
 * still needed to decide.
 */
export function suggestType(answers: TypeAnswers): TypeSuggestion | { missing: TypeQuestionKey[] } {
  const yes = (['accounts', 'appointments', 'products'] as const).filter((key) => answers[key] === true);
  const order: Record<(typeof yes)[number], ProjectTypeKey> = { accounts: 'web_app', appointments: 'booking', products: 'store' };
  if (yes.length) {
    // An app outranks a booking site, a booking site a store: the bigger need decides, the others stay alternatives.
    // Whether an account area is needed must be known, since it would change the type.
    if (!yes.includes('accounts') && answers.accounts === undefined) return { missing: ['accounts'] };
    const ranked = (['accounts', 'appointments', 'products'] as const).filter((key) => yes.includes(key)).map((key) => order[key]);
    return { type: ranked[0]!, reason: REASONS[ranked[0]!], alternatives: ranked.slice(1), missing: [] };
  }
  const missing = (['appointments', 'products', 'accounts'] as const).filter((key) => answers[key] === undefined);
  if (missing.length) return { missing };
  if (!answers.size) return { missing: ['size'] };
  const type: ProjectTypeKey = answers.size === 'one' ? 'landing' : answers.size === 'few' ? 'company_site' : 'multipage';
  const alternatives: ProjectTypeKey[] = type === 'landing' ? ['company_site'] : type === 'company_site' ? ['landing', 'multipage'] : ['company_site'];
  return { type, reason: REASONS[type], alternatives, missing: [] };
}

export function parseAnswers(raw: unknown): TypeAnswers {
  const out: TypeAnswers = {};
  if (!raw || typeof raw !== 'object') return out;
  const record = raw as Record<string, unknown>;
  for (const key of ['appointments', 'products', 'accounts'] as const) {
    if (record[key] === true || record[key] === 'yes') out[key] = true;
    else if (record[key] === false || record[key] === 'no') out[key] = false;
  }
  if (record.size === 'one' || record.size === 'few' || record.size === 'many') out.size = record.size;
  return out;
}
