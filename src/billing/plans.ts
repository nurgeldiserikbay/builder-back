// Versioned plan catalog. Limits are product rules enforced on the server; prices of paid plans are managed by staff (plan_prices).

export const PLAN_CATALOG_VERSION = '1.0.0';
export type PlanKey = 'free' | 'start' | 'business';
export type LimitKey = 'projects' | 'aiPerMonth' | 'liveSites';

export interface PlanDefinition {
  key: PlanKey;
  title: string;
  description: string;
  limits: Record<LimitKey, number>;
  specialists: boolean;
  paid: boolean;
}

export const plans: Record<PlanKey, PlanDefinition> = {
  free: {
    key: 'free', title: 'Бесплатный', description: 'Чтобы попробовать: один сайт в интернете и немного запросов к ИИ.',
    limits: { projects: 2, aiPerMonth: 30, liveSites: 1 }, specialists: false, paid: false,
  },
  start: {
    key: 'start', title: 'Старт', description: 'Для своего дела: несколько сайтов, больше ИИ и приглашение специалистов.',
    limits: { projects: 5, aiPerMonth: 300, liveSites: 3 }, specialists: true, paid: true,
  },
  business: {
    key: 'business', title: 'Бизнес', description: 'Для агентств и тех, кто делает сайты для клиентов.',
    limits: { projects: 25, aiPerMonth: 1500, liveSites: 15 }, specialists: true, paid: true,
  },
};

export const limitLabels: Record<LimitKey, { title: string; unit: string; explanation: string }> = {
  projects: { title: 'Проекты в работе', unit: 'проектов', explanation: 'Проекты, которые не в архиве. Завершённые тоже считаются, пока вы их не архивируете.' },
  aiPerMonth: { title: 'Запросы к ИИ в месяц', unit: 'запросов', explanation: 'Каждая генерация ИИ во всех ваших проектах, включая запросы приглашённых специалистов. Черновики по шаблону не считаются. Счётчик обнуляется 1-го числа (UTC).' },
  liveSites: { title: 'Опубликованные сайты', unit: 'сайтов', explanation: 'Сайты, которые сейчас открываются в интернете.' },
};

export function planOf(key: string | null | undefined, validUntil: Date | null | undefined, now = new Date()): { plan: PlanDefinition; expired: boolean } {
  const known = key && key in plans ? plans[key as PlanKey] : null;
  if (!known) return { plan: plans.free, expired: false };
  if (validUntil && validUntil <= now) return { plan: plans.free, expired: true };
  return { plan: known, expired: false };
}

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type PaidPlanKey = 'start' | 'business';
export const paidPlanKeys: PaidPlanKey[] = ['start', 'business'];
export const MIN_PRICE_KZT = 100;
export const MAX_PRICE_KZT = 10_000_000;

/** Human-readable price: "4 990 ₸ в месяц"; null for a paid plan without a set price ("по запросу" on the client). */
export function priceOf(plan: PlanDefinition, monthlyKzt: number | null | undefined): string | null {
  if (!plan.paid) return 'Бесплатно';
  if (monthlyKzt === null || monthlyKzt === undefined) return null;
  return `${String(monthlyKzt).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₸ в месяц`;
}

/** Upgrade contact must be a link the client can open safely: https (with a real host) or mailto. */
export function validContactUrl(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
