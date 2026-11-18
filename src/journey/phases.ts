// The common path of every project: eight phases from an idea to a working product and its life after launch
// (builder-docs UNIFIED_PATH.md). A project type adds its own stages into the phases; the map shows the owner where
// they are and how much is left. Every stage also carries a guide in plain words: why it matters for the business,
// what comes next, an example of a good result and the terms it uses.
import type { StageKey } from './catalog.js';

export const PHASES_VERSION = '1.0.0';

export type PhaseKey = 'idea' | 'spec' | 'experience' | 'tech' | 'content' | 'build' | 'launch' | 'after';

export interface PhaseDefinition { key: PhaseKey; title: string; short: string }

export const PHASES: PhaseDefinition[] = [
  { key: 'idea', title: 'Идея и бизнес', short: 'Кто ваши клиенты и как работает ваше дело.' },
  { key: 'spec', title: 'ТЗ и первая версия', short: 'Что умеет продукт и что войдёт в первую версию.' },
  { key: 'experience', title: 'Страницы и экраны', short: 'Что увидит клиент и как пройдёт свой путь.' },
  { key: 'tech', title: 'Техническое решение', short: 'Как всё устроено и что останется за вами.' },
  { key: 'content', title: 'Тексты и вид', short: 'Что прочитает клиент и как это выглядит.' },
  { key: 'build', title: 'Сборка и проверка', short: 'Готовый результат и отчёт о проверках.' },
  { key: 'launch', title: 'Запуск', short: 'Сайт работает по своему адресу и принимает клиентов.' },
  { key: 'after', title: 'После запуска', short: 'Заявки, статистика, правки и следующие версии.' },
];

export const STAGE_PHASE: Record<StageKey, PhaseKey> = {
  goal: 'idea', process: 'idea',
  features: 'spec',
  offer: 'experience', products: 'experience', schedule: 'experience', sitemap: 'experience', screens: 'experience',
  techplan: 'tech',
  content: 'content', design: 'content',
  build: 'build', handoff: 'build',
};

export interface StageGuide {
  /** Why the stage matters for the business, in one or two sentences. */
  why: string;
  /** What the result feeds next. */
  next: string;
  /** A short example of a good result. */
  example: string;
  /** Terms the stage uses, explained at first sight. */
  terms: Array<{ term: string; meaning: string }>;
}

export const STAGE_GUIDES: Record<StageKey, StageGuide> = {
  goal: {
    why: 'Если не решить, кто ваш клиент и что он должен сделать, сайт получится «обо всём» и не будет приносить заявки.',
    next: 'По паспорту ИИ пишет тексты и выбирает главную кнопку, а бизнес-процесс строится вокруг главного действия.',
    example: '«Барбершоп Усы: мужчины 25–45 лет в центре Алматы; главное действие — записаться на стрижку».',
    terms: [{ term: 'Главное действие', meaning: 'То одно, что посетитель должен сделать на сайте: позвонить, записаться, оставить заявку.' }],
  },
  process: {
    why: 'Сайт должен работать так же, как ваш бизнес. Здесь видно, что сайт возьмёт на себя, что останется за вами и о чём вы ещё не подумали.',
    next: 'Из процесса вырастают услуги, расписание, архитектура и тексты о правилах для клиентов.',
    example: '«Клиент выбирает услугу и время → получает подтверждение → за день приходит напоминание → мастер отмечает визит». Правило: отмена не позже чем за сутки.',
    terms: [
      { term: 'Сценарий', meaning: 'Путь человека по шагам от начала до результата, например от выбора услуги до визита.' },
      { term: 'Участник', meaning: 'Кто делает шаг: клиент, вы, сотрудник или сам сайт.' },
      { term: 'Схема данных', meaning: 'Какую информацию вы храните — клиентов, записи, заказы — и как она связана.' },
    ],
  },
  offer: {
    why: 'Клиент приходит за конкретной услугой и ценой. Без понятного списка он уходит к тем, у кого всё написано.',
    next: 'Услуги попадут в тексты сайта, а у онлайн-записи — в расписание вместе с длительностью.',
    example: '«Мужская стрижка — 40 минут — от 5 000 ₸».',
    terms: [],
  },
  schedule: {
    why: 'Запись работает сама, только если сайт знает, когда вы свободны. Иначе клиенты запишутся на занятое время.',
    next: 'По расписанию сайт показывает клиентам только свободное время, а архитектура описывает, как хранятся записи.',
    example: '«Мастер Арман: пн–пт 10:00–19:00, шаг записи 30 минут, записаться можно на 14 дней вперёд».',
    terms: [{ term: 'Шаг записи', meaning: 'Через сколько минут начинаются окна для записи: 9:00, 9:30, 10:00.' }],
  },
  products: {
    why: 'Покупатель решает по цене, наличию и тому, как получит заказ. Если этого нет, он не купит.',
    next: 'Из каталога соберутся витрина, корзина и форма заказа.',
    example: '«Торт „Медовик“ 1,5 кг — 9 000 ₸ — под заказ за 2 дня; самовывоз бесплатно, доставка по городу 1 500 ₸».',
    terms: [],
  },
  sitemap: {
    why: 'Когда информации много, её проще найти на отдельных страницах с понятным меню.',
    next: 'Для каждой страницы ИИ напишет свои тексты, а в меню будут ровно эти страницы.',
    example: '«Главная, Услуги, Цены, О клинике, Врачи, Контакты».',
    terms: [{ term: 'Адрес страницы', meaning: 'Часть ссылки после названия сайта, например /uslugi.' }],
  },
  features: {
    why: 'Продукт делают по ТЗ. Чего нет в ТЗ, того не сделают, а без понятного «готово» спорить придётся потом. Здесь же решается, что войдёт в первую версию — с ней вы быстрее начнёте принимать клиентов.',
    next: 'По ТЗ строятся страницы или экраны, архитектура и тексты: сайт не обещает того, что отложено на потом.',
    example: '«Клиент записывается онлайн на свободное время. Готово, когда запись приходит мастеру в Telegram, а клиенту — подтверждение». Онлайн-оплата — позже.',
    terms: [
      { term: 'ТЗ (техническое задание)', meaning: 'Описание того, что должен уметь продукт: по нему работают ИИ, разработчик и проверка.' },
      { term: 'Роль', meaning: 'Кто пользуется продуктом и что ему можно: клиент, мастер, администратор.' },
      { term: 'Критерий «готово»', meaning: 'Проверяемое условие, по которому видно, что функция сделана.' },
      { term: 'Первая версия', meaning: 'То, без чего продукт не работает. Остальное добавляют следующими версиями.' },
    ],
  },
  screens: {
    why: 'Пройти приложение на прототипе дешевле, чем переделывать готовый код.',
    next: 'Экраны и переходы войдут в архитектуру и в пакет для разработки.',
    example: '«Экран „Мои занятия“: список занятий, кнопка „Перенести“ ведёт на выбор времени».',
    terms: [{ term: 'Прототип', meaning: 'Кликабельная модель приложения без настоящих данных: её можно пройти на телефоне.' }],
  },
  techplan: {
    why: 'Здесь видно, что именно сделает система, где хранятся данные и что останется за вами. Это защищает от сюрпризов после запуска.',
    next: 'По архитектуре собирается сайт или код, а разработчик получает точное описание.',
    example: '«Сайт хранит клиентов и записи; оплата пока вручную; уведомления о записях приходят владельцу в Telegram».',
    terms: [
      { term: 'API', meaning: 'Способ, которым программы обмениваются данными, например сайт и приложение мастера.' },
      { term: 'Контракт', meaning: 'Точное описание, на которое могут опираться следующие этапы: пока он не меняется, они работают одновременно.' },
    ],
  },
  content: {
    why: 'Клиент решает по текстам: понятно ли, что вы делаете, сколько это стоит и как к вам попасть.',
    next: 'Тексты войдут в сборку сайта; поправить их можно и после публикации.',
    example: 'Заголовок «Мужские стрижки в центре Алматы — запись онлайн за минуту» вместо «Добро пожаловать».',
    terms: [{ term: 'Описание для поисковиков', meaning: 'Заголовок и пара строк, которые Google показывает в результатах поиска.' }],
  },
  design: {
    why: 'Вид сайта — первое впечатление о бизнесе. Он должен вызывать доверие и легко читаться с телефона.',
    next: 'Стиль применится при сборке ко всем страницам.',
    example: '«Тёмно-зелёный и белый, крупный шрифт, фото работ на первом экране».',
    terms: [{ term: 'Палитра', meaning: 'Набор цветов сайта: основной, фон, цвет кнопок и текста.' }],
  },
  build: {
    why: 'Здесь всё собирается в работающий сайт и проверяется: ссылки, скорость, удобство с телефона.',
    next: 'После сборки сайт публикуется по своему адресу и начинает принимать клиентов.',
    example: '«Все проверки пройдены: форма записи работает, страница открывается за 1,2 секунды».',
    terms: [
      { term: 'Публикация', meaning: 'Сайт становится доступен всем по адресу в интернете.' },
      { term: 'Хостинг', meaning: 'Компьютер в интернете, на котором работает сайт. Если не выбирать, сайт работает на BuildPath.' },
      { term: 'Домен', meaning: 'Адрес сайта, например usy.kz.' },
    ],
  },
  handoff: {
    why: 'Разработчик сделает ровно то, что записано. Полный и понятный пакет экономит недели переписки и переделок.',
    next: 'По пакету ИИ-агент пишет всё приложение — экраны, вход, базу данных и тесты; BuildPath проверяет его и помогает запустить у вас.',
    example: 'Архив: ТЗ с критериями приёмки, права по ролям, схема данных, описание API и прототип.',
    terms: [
      { term: 'Репозиторий (git)', meaning: 'Хранилище кода с историей всех изменений, например на GitHub или GitLab.' },
      { term: 'Стартовый код', meaning: 'Готовая основа приложения, которую разработчик продолжает, а не пишет с нуля.' },
    ],
  },
};

export type PhaseStatus = 'done' | 'current' | 'upcoming';
export interface PhaseView { key: PhaseKey; title: string; short: string; status: PhaseStatus; stageKeys: StageKey[]; done: number; total: number; kind: 'stages' | 'publish' }

/**
 * Phases of a route as the owner sees them: the phases its stages fall into and, for a website, the launch and the
 * life after it (they follow the publication, not a stage). The first unfinished phase is the current one.
 */
export function phasesOf(stages: Array<{ key: StageKey; done: boolean }>, publishing: { applies: boolean; live: boolean } | null): PhaseView[] {
  const out: PhaseView[] = [];
  for (const phase of PHASES) {
    if (phase.key === 'launch' || phase.key === 'after') {
      if (!publishing?.applies) continue;
      const done = phase.key === 'launch' ? publishing.live : false;
      out.push({ ...phase, status: done ? 'done' : 'upcoming', stageKeys: [], done: done ? 1 : 0, total: 1, kind: 'publish' });
      continue;
    }
    const inPhase = stages.filter((stage) => STAGE_PHASE[stage.key] === phase.key);
    if (!inPhase.length) continue;
    const done = inPhase.filter((stage) => stage.done).length;
    out.push({ ...phase, status: done === inPhase.length ? 'done' : 'upcoming', stageKeys: inPhase.map((stage) => stage.key), done, total: inPhase.length, kind: 'stages' });
  }
  const current = out.find((phase) => phase.status !== 'done');
  if (current) current.status = 'current';
  // After launch the life of the product is what goes on.
  const after = out.find((phase) => phase.key === 'after');
  if (after && publishing?.live && out.every((phase) => phase.key === 'after' || phase.status === 'done')) after.status = 'current';
  return out;
}
