// Plain-language texts for the Telegram bot; kept pure for tests.
import { tr } from '../i18n/i18n.js';
import type { Brief, ContentArtifact, DesignArtifact, Offer } from '../journey/artifacts.js';
import { fonts, palettes } from '../journey/site-renderer.js';

export const statusEmoji: Record<string, string> = {
  locked: '🔒', ready: '⚪️', awaiting_lead: '⏳', in_progress: '✏️', in_review: '👀', changes_requested: '↩️',
  approved: '✅', stale: '⚠️', imported: '✅', skipped: '➖', blocked: '⛔️',
};

const errorTexts = (): Record<string, string> => ({
  AI_NOT_CONFIGURED: tr("ИИ пока не подключён к платформе. Этот этап можно заполнить в приложении."),
  AI_DAILY_LIMIT_REACHED: tr("На сегодня лимит запросов к ИИ для проекта исчерпан."),
  AI_BUDGET_EXHAUSTED: tr("Лимит запросов к ИИ, который выделил владелец, закончился."),
  AI_OUTPUT_REJECTED: tr("ИИ вернул ответ, который не прошёл проверку. Ничего не изменилось — попробуйте сформулировать иначе."),
  AI_PROVIDER_FAILED: tr("Сервис ИИ не ответил. Ничего не изменилось — попробуйте позже."),
  AI_PROVIDER_UNAVAILABLE: tr("Сервис ИИ недоступен. Ничего не изменилось — попробуйте позже."),
  STAGE_LOCKED: tr("Этап ещё закрыт: сначала нужно принять предыдущие."),
  STAGE_IN_REVIEW: tr("Этап на приёмке у владельца — менять его пока нельзя."),
  STAGE_ACCEPTED_REOPEN_FIRST: tr("Этап уже принят. Чтобы изменить его, откройте этап в приложении и нажмите «Изменить этап»."),
  STAGE_INPUTS_NOT_ACCEPTED: tr("Сначала нужно принять предыдущие этапы."),
  STAGE_VERSION_CONFLICT: tr("Появилась новая версия этапа. Откройте этап заново."),
  REQUIRED_CHECKS_FAILED: tr("Есть непройденные обязательные проверки — исправьте их в приложении."),
  QUALITY_GATE_FAILED: tr("Сайт не прошёл проверку перед публикацией. Замечания — на этапе «Сборка» в приложении."),
  BUILD_NOT_QUALITY_CHECKED: tr("Эта сборка сделана до проверки качества. Соберите сайт заново."),
  BUILD_OUTDATED: tr("После сборки изменились тексты или стиль. Соберите сайт заново."),
  STAGE_WRITE_FORBIDDEN: tr("У вас нет права менять этот этап."),
  STAGE_ACCEPT_FORBIDDEN: tr("Принимать этапы может владелец или менеджер проекта."),
  PROJECT_NOT_ACTIVE: tr("Проект завершён. Продолжите его в приложении, чтобы вносить изменения."),
  PROJECT_NOT_FOUND: tr("Проект не найден или у вас больше нет к нему доступа."),
  STAGE_NOT_FOUND: tr("Этап не найден или у вас больше нет к нему доступа."),
  SUGGEST_FORBIDDEN: tr("Предлагать правки может консультант этапа."),
  PLAN_LIMIT_AI: tr("В этом месяце закончились запросы к ИИ по тарифу владельца проекта. Тариф можно расширить в приложении."),
  PLAN_LIMIT_SITES: tr("По тарифу больше нельзя опубликовать сайтов. Тариф можно расширить в приложении."),
  APPROVAL_POLICY_ACTIVE: tr("Этот этап принимают проверяющие: отправьте его на проверку."),
  AUTHOR_CANNOT_APPROVE: tr("Автор версии не одобряет свою версию — это сделают другие проверяющие."),
  NOT_A_REVIEWER: tr("Вы не назначены проверяющим этого этапа."),
  ALREADY_APPROVED: tr("Вы уже одобрили эту версию."),
  STAGE_NOT_IN_REVIEW: tr("Этап сейчас не на проверке."),
  APPROVAL_POLICY_BROKEN: tr("Правило согласования больше нельзя выполнить: кого-то из проверяющих нет в команде. Владелец может изменить его в приложении."),
});

export function errorText(code: string): string {
  const texts = errorTexts();
  if (texts[code]) return texts[code];
  if (code.startsWith('STAGE_INCOMPLETE')) return tr("Этап заполнен не до конца — посмотрите «Чего не хватает» в карточке этапа.");
  return tr("Не получилось выполнить действие. Попробуйте ещё раз или откройте приложение.");
}

const actionLabels = (): Record<string, string> => ({ call: tr("позвонить"), message: tr("написать в мессенджер"), visit: tr("прийти по адресу"), email: tr("написать на почту"), form: tr("оставить заявку на сайте") });

/** Short text summary of a stage artifact for a chat message. */
export function artifactSummary(type: string, content: unknown): string {
  if (!content) return '';
  if (type === 'brief') {
    const brief = content as Brief;
    return [brief.businessName && tr("Название: {0}", [brief.businessName]), brief.whatYouDo && tr("Чем занимаетесь: {0}", [brief.whatYouDo]), brief.audience && tr("Клиенты: {0}", [brief.audience]),
      brief.mainAction && tr("Главное действие: {0}", [actionLabels()[brief.mainAction] ?? brief.mainAction])].filter(Boolean).join('\n');
  }
  if (type === 'offer') {
    const offer = content as Offer;
    return offer.services.slice(0, 8).map((service) => `• ${service.name}${service.price ? ` — ${service.price}` : ''}`).join('\n') + (offer.services.length > 8 ? tr("\n…и ещё {0}", [offer.services.length - 8]) : '');
  }
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    const hero = artifact.sections.find((section) => section.type === 'hero');
    return [hero && tr("Первый экран: «{0}» — {1}", [hero.title, hero.text.slice(0, 200)]), tr("Блоки: {0}", [artifact.sections.map((section) => section.title).filter(Boolean).join(' · ')])].filter(Boolean).join('\n');
  }
  if (type === 'design') {
    const design = content as DesignArtifact;
    return tr("Цвета: {0}, шрифт: {1}", [tr(palettes.find((item) => item.id === design.palette)?.label ?? design.palette), tr(fonts.find((item) => item.id === design.font)?.label ?? design.font)]);
  }
  if (type === 'site') {
    const site = content as { checks?: Array<{ status: string; required: boolean; title: string }> };
    const failed = site.checks?.filter((check) => check.status === 'failed') ?? [];
    return failed.length ? tr("Не пройдено проверок: {0} ({1})", [failed.length, failed.map((check) => check.title).join(', ')]) : tr("Все обязательные проверки пройдены.");
  }
  return '';
}

export const helpText = (): string => [
  tr("Я помогаю вести проекты BuildPath прямо в Telegram."),
  '',
  tr("/projects — ваши проекты и этапы"),
  tr("/stop — отключить Telegram от BuildPath"),
  '',
  tr("В карточке этапа можно попросить ИИ что-то изменить, принять этап или отправить его на приёмку. Сложные правки удобнее делать в приложении — кнопка «Открыть в приложении»."),
].join('\n');
