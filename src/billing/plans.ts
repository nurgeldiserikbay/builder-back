// Versioned plan catalog. Prices are configuration (PLAN_PRICE_*), limits are product rules enforced on the server.

export const PLAN_CATALOG_VERSION = '1.0.0';
export type PlanKey = 'free' | 'start' | 'business';
export type LimitKey = 'projects' | 'aiPerMonth' | 'liveSites';

export interface PlanDefinition {
  key: PlanKey;
  title: string;
  description: string;
  limits: Record<LimitKey, number>;
  specialists: boolean;
  priceEnv: string | null;
}

export const plans: Record<PlanKey, PlanDefinition> = {
  free: {
    key: 'free', title: 'Бесплатный', description: 'Чтобы попробовать: один сайт в интернете и немного запросов к ИИ.',
    limits: { projects: 2, aiPerMonth: 30, liveSites: 1 }, specialists: false, priceEnv: null,
  },
  start: {
    key: 'start', title: 'Старт', description: 'Для своего дела: несколько сайтов, больше ИИ и приглашение специалистов.',
    limits: { projects: 5, aiPerMonth: 300, liveSites: 3 }, specialists: true, priceEnv: 'PLAN_PRICE_START',
  },
  business: {
    key: 'business', title: 'Бизнес', description: 'Для агентств и тех, кто делает сайты для клиентов.',
    limits: { projects: 25, aiPerMonth: 1500, liveSites: 15 }, specialists: true, priceEnv: 'PLAN_PRICE_BUSINESS',
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

export function priceOf(plan: PlanDefinition, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!plan.priceEnv) return 'Бесплатно';
  const value = env[plan.priceEnv]?.trim();
  return value ? value.slice(0, 60) : null;
}
