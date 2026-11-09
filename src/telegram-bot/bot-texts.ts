// Plain-language texts for the Telegram bot; kept pure for tests.
import type { Brief, ContentArtifact, DesignArtifact, Offer } from '../journey/artifacts.js';
import { fonts, palettes } from '../journey/site-renderer.js';

export const statusEmoji: Record<string, string> = {
  locked: '🔒', ready: '⚪️', awaiting_lead: '⏳', in_progress: '✏️', in_review: '👀', changes_requested: '↩️',
  approved: '✅', stale: '⚠️', imported: '✅', skipped: '➖', blocked: '⛔️',
};

const errorTexts: Record<string, string> = {
  AI_NOT_CONFIGURED: 'ИИ пока не подключён к платформе. Этот этап можно заполнить в приложении.',
  AI_DAILY_LIMIT_REACHED: 'На сегодня лимит запросов к ИИ для проекта исчерпан.',
  AI_BUDGET_EXHAUSTED: 'Лимит запросов к ИИ, который выделил владелец, закончился.',
  AI_OUTPUT_REJECTED: 'ИИ вернул ответ, который не прошёл проверку. Ничего не изменилось — попробуйте сформулировать иначе.',
  AI_PROVIDER_FAILED: 'Сервис ИИ не ответил. Ничего не изменилось — попробуйте позже.',
  AI_PROVIDER_UNAVAILABLE: 'Сервис ИИ недоступен. Ничего не изменилось — попробуйте позже.',
  STAGE_LOCKED: 'Этап ещё закрыт: сначала нужно принять предыдущие.',
  STAGE_IN_REVIEW: 'Этап на приёмке у владельца — менять его пока нельзя.',
  STAGE_ACCEPTED_REOPEN_FIRST: 'Этап уже принят. Чтобы изменить его, откройте этап в приложении и нажмите «Изменить этап».',
  STAGE_INPUTS_NOT_ACCEPTED: 'Сначала нужно принять предыдущие этапы.',
  STAGE_VERSION_CONFLICT: 'Появилась новая версия этапа. Откройте этап заново.',
  REQUIRED_CHECKS_FAILED: 'Есть непройденные обязательные проверки — исправьте их в приложении.',
  BUILD_OUTDATED: 'После сборки изменились тексты или стиль. Соберите сайт заново.',
  STAGE_WRITE_FORBIDDEN: 'У вас нет права менять этот этап.',
  STAGE_ACCEPT_FORBIDDEN: 'Принимать этапы может владелец или менеджер проекта.',
  PROJECT_NOT_ACTIVE: 'Проект завершён. Продолжите его в приложении, чтобы вносить изменения.',
  PROJECT_NOT_FOUND: 'Проект не найден или у вас больше нет к нему доступа.',
  STAGE_NOT_FOUND: 'Этап не найден или у вас больше нет к нему доступа.',
  SUGGEST_FORBIDDEN: 'Предлагать правки может консультант этапа.',
};

export function errorText(code: string): string {
  if (errorTexts[code]) return errorTexts[code];
  if (code.startsWith('STAGE_INCOMPLETE')) return 'Этап заполнен не до конца — посмотрите «Чего не хватает» в карточке этапа.';
  return 'Не получилось выполнить действие. Попробуйте ещё раз или откройте приложение.';
}

const actionLabels: Record<string, string> = { call: 'позвонить', message: 'написать в мессенджер', visit: 'прийти по адресу', email: 'написать на почту', form: 'оставить заявку на сайте' };

/** Short text summary of a stage artifact for a chat message. */
export function artifactSummary(type: string, content: unknown): string {
  if (!content) return '';
  if (type === 'brief') {
    const brief = content as Brief;
    return [brief.businessName && `Название: ${brief.businessName}`, brief.whatYouDo && `Чем занимаетесь: ${brief.whatYouDo}`, brief.audience && `Клиенты: ${brief.audience}`,
      brief.mainAction && `Главное действие: ${actionLabels[brief.mainAction] ?? brief.mainAction}`].filter(Boolean).join('\n');
  }
  if (type === 'offer') {
    const offer = content as Offer;
    return offer.services.slice(0, 8).map((service) => `• ${service.name}${service.price ? ` — ${service.price}` : ''}`).join('\n') + (offer.services.length > 8 ? `\n…и ещё ${offer.services.length - 8}` : '');
  }
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    const hero = artifact.sections.find((section) => section.type === 'hero');
    return [hero && `Первый экран: «${hero.title}» — ${hero.text.slice(0, 200)}`, `Блоки: ${artifact.sections.map((section) => section.title).filter(Boolean).join(' · ')}`].filter(Boolean).join('\n');
  }
  if (type === 'design') {
    const design = content as DesignArtifact;
    return `Цвета: ${palettes.find((item) => item.id === design.palette)?.label ?? design.palette}, шрифт: ${fonts.find((item) => item.id === design.font)?.label ?? design.font}`;
  }
  if (type === 'site') {
    const site = content as { checks?: Array<{ status: string; required: boolean; title: string }> };
    const failed = site.checks?.filter((check) => check.status === 'failed') ?? [];
    return failed.length ? `Не пройдено проверок: ${failed.length} (${failed.map((check) => check.title).join(', ')})` : 'Все обязательные проверки пройдены.';
  }
  return '';
}

export const helpText = [
  'Я помогаю вести проекты BuildPath прямо в Telegram.',
  '',
  '/projects — ваши проекты и этапы',
  '/stop — отключить Telegram от BuildPath',
  '',
  'В карточке этапа можно попросить ИИ что-то изменить, принять этап или отправить его на приёмку. Сложные правки удобнее делать в приложении — кнопка «Открыть в приложении».',
].join('\n');
