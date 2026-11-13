// Versioned, deterministic catalog of project types and stage contracts.
// Every user-visible explanation lives here so the web, Telegram and exports show the same wording.

export const ROUTE_CATALOG_VERSION = '1.7.0';

export type StageKey = 'goal' | 'process' | 'offer' | 'products' | 'schedule' | 'sitemap' | 'features' | 'screens' | 'techplan' | 'content' | 'design' | 'build' | 'handoff';
export type ArtifactType = 'brief' | 'process' | 'offer' | 'catalog' | 'schedule' | 'sitemap' | 'features' | 'screens' | 'techplan' | 'content' | 'design' | 'site' | 'handoff';
export type AiLevel = 'ai_full' | 'ai_draft' | 'ai_assist' | 'none';
export type ProjectTypeKey = 'landing' | 'company_site' | 'multipage' | 'store' | 'booking' | 'web_app';

export interface FieldOption { value: string; label: string; hint: string }

export interface FieldDefinition {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'choice' | 'list';
  required: boolean;
  maxLength?: number;
  why: string;
  example: string;
  options?: FieldOption[];
  /** For kind=list: item fields. */
  itemFields?: Array<{ key: string; label: string; maxLength: number; required: boolean; placeholder: string }>;
  maxItems?: number;
}

export interface StageDefinition {
  key: StageKey;
  version: string;
  title: string;
  purpose: string;
  outcome: string;
  artifactType: ArtifactType;
  inputs: StageKey[];
  ai: { level: AiLevel; whatItDoes: string; instructionExamples: string[]; describeHint?: string };
  acceptance: string[];
  acceptExplanation: string;
  importHint: string | null;
  fields?: FieldDefinition[];
  playbook: { version: string; instructions: string[] };
  /**
   * A contract stage fixes what the next stages build on, so they can run at the same time. The owner approves it;
   * a new approved version notifies every stage built on it (change notices).
   */
  contract?: { explanation: string };
}

export interface ProjectTypeDefinition {
  key: ProjectTypeKey;
  title: string;
  description: string;
  goodFor: string;
  examples: string[];
  stages: StageKey[];
  resultExplanation: string;
}

const mainActionOptions: FieldOption[] = [
  { value: 'call', label: 'Позвонить', hint: 'На сайте будет кнопка звонка по вашему номеру.' },
  { value: 'message', label: 'Написать в мессенджер', hint: 'Кнопка откроет чат в Telegram или WhatsApp.' },
  { value: 'visit', label: 'Прийти по адресу', hint: 'Главными будут адрес и часы работы.' },
  { value: 'email', label: 'Написать на почту', hint: 'Кнопка откроет письмо на ваш email.' },
  { value: 'form', label: 'Оставить заявку на сайте', hint: 'Посетитель заполнит короткую форму, заявка придёт вам в Telegram или на почту. Работает, когда сайт опубликован на BuildPath.' },
];

const toneOptions: FieldOption[] = [
  { value: 'friendly', label: 'Дружелюбно', hint: 'Просто и тепло, как разговор с хорошим знакомым.' },
  { value: 'formal', label: 'Официально', hint: 'Сдержанно и по делу, на «Вы».' },
  { value: 'bold', label: 'Смело', hint: 'Коротко, ярко и уверенно.' },
];

export const stageDefinitions: Record<StageKey, StageDefinition> = {
  goal: {
    key: 'goal',
    version: '1.0.0',
    title: 'Цель сайта',
    purpose: 'Поймём, кому нужен сайт и что посетитель должен сделать. От этого зависят все следующие этапы: тексты, кнопки и внешний вид.',
    outcome: 'Короткий паспорт проекта: кто вы, для кого сайт и какое главное действие.',
    artifactType: 'brief',
    inputs: [],
    ai: {
      level: 'ai_full',
      whatItDoes: 'Опишите бизнес своими словами — ИИ заполнит поля. Потом проверьте и поправьте.',
      instructionExamples: ['Мы печём торты на заказ в Алматы, заказывают через WhatsApp', 'Сделай описание короче и проще'],
      describeHint: 'Например: «Я мастер маникюра в Астане, работаю на дому, клиенты записываются через Telegram @nails_aru»',
    },
    acceptance: ['Понятно, чем вы занимаетесь', 'Понятно, кто ваши клиенты', 'Выбрано главное действие и указан контакт для него'],
    acceptExplanation: 'После принятия откроется следующий этап. Паспорт можно будет изменить позже — тогда следующие этапы попросят проверить себя ещё раз.',
    importHint: 'Если у вас уже есть описание бизнеса или ТЗ, вставьте текст — мы разложим его по полям.',
    fields: [
      { key: 'businessName', label: 'Название бизнеса или проекта', kind: 'text', required: true, maxLength: 80, why: 'Покажем его в заголовке сайта и во вкладке браузера.', example: 'Торты от Айгерим' },
      { key: 'whatYouDo', label: 'Чем вы занимаетесь?', kind: 'textarea', required: true, maxLength: 400, why: 'Из этого получится первый экран — то, что посетитель прочитает в первые секунды.', example: 'Печём торты и десерты на заказ к праздникам, доставка по городу' },
      { key: 'audience', label: 'Кто ваши клиенты?', kind: 'textarea', required: true, maxLength: 300, why: 'Тексты будут написаны для этих людей и их задач.', example: 'Родители, которые готовят детский праздник, и компании для корпоративов' },
      { key: 'city', label: 'Город или район (если важно)', kind: 'text', required: false, maxLength: 80, why: 'Поможет клиентам понять, что вы рядом.', example: 'Алматы' },
      { key: 'mainAction', label: 'Что посетитель должен сделать?', kind: 'choice', required: true, why: 'Это главная кнопка сайта. Всё остальное будет вести к ней.', example: 'Написать в мессенджер', options: mainActionOptions },
      { key: 'phone', label: 'Телефон', kind: 'text', required: false, maxLength: 30, why: 'Нужен, если главное действие — звонок. Можно указать и просто для контактов.', example: '+7 701 123 45 67' },
      { key: 'messenger', label: 'Telegram или WhatsApp', kind: 'text', required: false, maxLength: 60, why: 'Нужен, если главное действие — написать в мессенджер. Укажите @имя в Telegram или номер WhatsApp.', example: '@aigerim_cakes или wa:+77011234567' },
      { key: 'email', label: 'Email', kind: 'text', required: false, maxLength: 120, why: 'Нужен, если главное действие — письмо.', example: 'hello@example.kz' },
      { key: 'address', label: 'Адрес', kind: 'text', required: false, maxLength: 160, why: 'Нужен, если к вам приходят лично.', example: 'ул. Абая 10, офис 5' },
      { key: 'tone', label: 'Как говорить с клиентами?', kind: 'choice', required: true, why: 'От этого зависит стиль всех текстов на сайте.', example: 'Дружелюбно', options: toneOptions },
    ],
    contract: { explanation: 'Цель сайта — договорённость для всех следующих этапов. После утверждения по ней одновременно готовятся содержание сайта и внешний вид — их могут делать разные люди или ИИ. Если позже поменять цель, каждый этап, построенный на ней, получит уведомление и решит, что делать.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Fill only facts present in the user description; leave unknown fields empty rather than inventing them.',
        'Keep wording short and in the project language.',
        'Choose mainAction from the contact channel the user mentions; prefer message when a messenger is given; use form only when the user asks for requests or applications on the site.',
      ],
    },
  },
  process: {
    key: 'process',
    version: '1.0.0',
    title: 'Бизнес-процесс',
    purpose: 'Опишем, как работает ваше дело: кто участвует, как клиент проходит путь от первого взгляда до результата, какие правила действуют и какую информацию вы храните. Схемы покажут это наглядно — по ним видно, что будет делать сайт, а что останется за вами.',
    outcome: 'Участники, сценарии по шагам со схемой по ролям, правила и схема данных.',
    artifactType: 'process',
    inputs: ['goal'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ опишет процесс по паспорту проекта: участников, сценарии, правила и данные. Проверьте схему — поправьте шаги, которые у вас идут иначе.',
      instructionExamples: ['Добавь сценарий переноса записи', 'Клиенты сначала пишут в WhatsApp, а потом приходят', 'Предоплата 30% перед визитом'],
    },
    acceptance: ['Участники и сценарии такие, как на самом деле', 'Правила записаны так, как вы их применяете', 'Понятно, какую информацию вы храните'],
    acceptExplanation: 'Процесс станет основой архитектуры: она покажет, какие шаги сделает сайт, а какие нужно делать вручную или заказывать отдельно.',
    importHint: null,
    contract: { explanation: 'Бизнес-процесс — договорённость о том, как работает дело. Архитектура строится по нему; если процесс изменится, архитектура получит уведомление и покажет, что поменялось.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Describe the real process of this business from the brief, in plain words, in the project language.',
        'Actors: the client, the business (owner), staff if any, the site as «system», external services only if mentioned. At most 6.',
        'Scenarios: 1–4 main ones (the client journey first), each 2–8 short steps in order; each step is one action by one actor.',
        'Tag every step with the closest capability; use «offline» for things people do outside the site and «other» if nothing fits. Never mark pay_online or account unless the user asked for them.',
        'Rules: business rules the user stated or that follow directly from the brief (cancellation, prepayment, working hours). Do not invent numbers.',
        'Data: the information the business keeps (client, booking, request, service…) with 2–6 simple fields in plain words and links between them.',
      ],
    },
  },
  offer: {
    key: 'offer',
    version: '1.0.0',
    title: 'Услуги и цены',
    purpose: 'Перечислим, что именно вы предлагаете. Сайт компании без списка услуг вызывает вопросы у клиентов.',
    outcome: 'Список услуг с коротким описанием и, по желанию, ценой; часы работы.',
    artifactType: 'offer',
    inputs: ['goal'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'Перечислите услуги как удобно — ИИ оформит список. Цены ИИ не придумывает: только те, что вы указали.',
      instructionExamples: ['Добавь услугу «Доставка по городу», бесплатно от 20 000 ₸', 'Опиши услуги короче'],
      describeHint: 'Например: «Торты от 15 000 тенге за кг, капкейки по 1 500, доставка 2 000»',
    },
    acceptance: ['Перечислены основные услуги', 'У каждой услуги есть понятное описание', 'Цены указаны только реальные или не указаны вовсе'],
    acceptExplanation: 'Услуги попадут в тексты сайта на следующем этапе.',
    importHint: 'Вставьте прайс-лист или список услуг текстом — по одной услуге на строку.',
    fields: [
      { key: 'services', label: 'Услуги', kind: 'list', required: true, maxItems: 12, why: 'Из них получится раздел «Услуги» на сайте.', example: 'Торт на заказ — от 15 000 ₸/кг',
        itemFields: [
          { key: 'name', label: 'Название', maxLength: 80, required: true, placeholder: 'Торт на заказ' },
          { key: 'description', label: 'Описание', maxLength: 300, required: false, placeholder: 'Бисквит, крем и начинка на выбор' },
          { key: 'price', label: 'Цена', maxLength: 40, required: false, placeholder: 'от 15 000 ₸/кг' },
        ] },
      { key: 'hours', label: 'Часы работы', kind: 'text', required: false, maxLength: 120, why: 'Покажем рядом с контактами.', example: 'Пн–Сб, 9:00–19:00' },
    ],
    playbook: {
      version: '1.0.0',
      instructions: [
        'Never invent prices, discounts, guarantees or certifications; keep price empty unless the user stated it.',
        'One service per item, name up to 6 words, description one sentence.',
      ],
    },
  },
  schedule: {
    key: 'schedule',
    version: '1.0.0',
    title: 'Расписание и запись',
    purpose: 'Настроим онлайн-запись: сколько длится каждая услуга, кто из мастеров её делает и в какие дни и часы к вам можно записаться. Клиент увидит только свободное время.',
    outcome: 'Длительность услуг, мастера с рабочими часами и правила записи: шаг времени, за сколько можно записаться и до какого срока отменить.',
    artifactType: 'schedule',
    inputs: ['offer'],
    ai: {
      level: 'none',
      whatItDoes: 'Здесь ИИ не нужен: расписание — это ваши факты. Мы заполнили услуги из прошлого этапа и типичный рабочий день — поправьте под себя.',
      instructionExamples: [],
    },
    acceptance: ['У каждой услуги указана настоящая длительность', 'У каждого мастера верные рабочие дни и часы', 'Правила записи и отмены вас устраивают'],
    acceptExplanation: 'После сборки и публикации клиенты смогут записываться на свободное время. Изменения расписания вступят в силу, когда вы примете новую версию и пересоберёте сайт.',
    importHint: null,
    playbook: { version: '1.0.0', instructions: [] },
  },
  products: {
    key: 'products',
    version: '1.0.0',
    title: 'Каталог товаров',
    purpose: 'Перечислим, что вы продаёте, по какой цене, как клиент получит заказ и как заплатит. Из этого соберутся витрина, корзина и форма заказа.',
    outcome: 'Товары с ценой и наличием, способы получения с ценой доставки, способы оплаты и минимальный заказ.',
    artifactType: 'catalog',
    inputs: ['goal'],
    ai: {
      level: 'none',
      whatItDoes: 'Каталог заполняете вы: цены и наличие ИИ не придумывает. Можно вставить список товаров готовым текстом — по товару на строку, цена через тире.',
      instructionExamples: [],
    },
    acceptance: ['Цены и наличие верные', 'Способы получения и их цена такие, как на самом деле', 'Понятно, как клиент платит'],
    acceptExplanation: 'После публикации клиенты смогут собрать корзину и оформить заказ по этим ценам. Изменения цен вступят в силу, когда вы примете новую версию и пересоберёте сайт.',
    importHint: 'Вставьте список товаров: по одному на строку, цена через тире. Например: «Мыло ручной работы — 2 500».',
    playbook: { version: '1.0.0', instructions: [] },
  },
  sitemap: {
    key: 'sitemap',
    version: '1.0.0',
    title: 'Карта сайта',
    purpose: 'Решим, из каких страниц состоит сайт: что будет в меню, по какому адресу каждая страница и зачем она посетителю. Схема покажет, как страницы связаны и какие блоки на каждой.',
    outcome: 'Список страниц с адресом, названием в меню, задачей и блоками; схема сайта.',
    artifactType: 'sitemap',
    inputs: ['goal', 'offer'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ предложит страницы по паспорту проекта и услугам. Уберите лишние, добавьте свои и выберите блоки для каждой страницы.',
      instructionExamples: ['Добавь страницу с примерами работ', 'Сделай отдельную страницу для каждой услуги', 'Объедини «О нас» и «Вопросы»'],
    },
    acceptance: ['В меню только нужные страницы', 'У каждой страницы понятная задача', 'Контакты есть хотя бы на одной странице'],
    acceptExplanation: 'Тексты будут писаться по страницам этой карты, а сборка сделает по странице на каждую строку. Если карту изменить, тексты и архитектура получат уведомление.',
    importHint: null,
    contract: { explanation: 'Карта сайта — договорённость о страницах. Тексты, архитектура и сборка строятся по ней; когда карта меняется, они получают уведомление и показывают, что поменялось.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Propose 3–6 pages for this business; the first page is the home page with path «/».',
        'Each page: a short menu title (1–2 words), a path in Latin letters like /services, one sentence on what the visitor gets there, and 1–5 block types from the list.',
        'The home page starts with «hero». Put «contacts» on a contacts page or on the home page. Do not create pages the business has nothing for (no reviews, portfolio or blog unless the inputs mention them).',
      ],
    },
  },
  features: {
    key: 'features',
    version: '1.0.0',
    title: 'Функции и роли',
    purpose: 'Запишем, кто будет пользоваться приложением и что каждый должен уметь в нём делать. У каждой функции — критерии приёмки: по ним вы и разработчик поймёте, что она готова.',
    outcome: 'Роли, функции с приоритетом и критериями приёмки, требования к данным и интеграции.',
    artifactType: 'features',
    inputs: ['goal', 'process'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ предложит роли и функции по бизнес-процессу и напишет критерии приёмки. Проверьте, что ничего лишнего, и отметьте, что нужно в первой версии.',
      instructionExamples: ['Добавь роль бухгалтера, который видит только счета', 'Оплата — позже, не в первой версии', 'Клиент должен видеть историю своих заявок'],
    },
    acceptance: ['Роли такие, как на самом деле', 'Обязательные функции первой версии отмечены', 'У каждой функции есть понятный критерий приёмки'],
    acceptExplanation: 'Функции станут основой экранов и архитектуры. Если позже их изменить, экраны и архитектура получат уведомление.',
    importHint: null,
    contract: { explanation: 'Функции и роли — договорённость о том, что делает приложение. Экраны и архитектура строятся по ним.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Describe the web application from the brief and the business process, in plain words, in the project language.',
        'Roles: the people who sign in (clients, staff, the owner as administrator). 1–6. Keys: short latin snake_case.',
        'Features: 3–20 concrete things a role does in the app; each with the roles that use it, priority must/should/later and 1–5 acceptance criteria a non-technical owner can check.',
        'Mark as must only what the first version cannot work without. Payments, integrations and analytics are should or later unless the user asked for them.',
        'sensitivity: personal when the app keeps people\'s contacts; payments or health only when stated. integrations: only services the user named.',
      ],
    },
  },
  screens: {
    key: 'screens',
    version: '1.0.0',
    title: 'Экраны и прототип',
    purpose: 'Опишем экраны приложения для каждой роли: что на них видно и куда с них можно перейти. По описанию сразу строится кликабельный прототип — его можно пройти на телефоне до начала разработки.',
    outcome: 'Список экранов по ролям с блоками и переходами и кликабельный прототип.',
    artifactType: 'screens',
    inputs: ['features'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ предложит экраны для каждой роли по функциям: блоки (списки, формы, карточки) и переходы. Пройдите прототип и поправьте, что неудобно.',
      instructionExamples: ['На главной клиента сразу покажи его активные заявки', 'Добавь экран профиля', 'Объедини два экрана настроек в один'],
    },
    acceptance: ['У каждой роли есть свои экраны', 'Обязательные функции видны на экранах', 'Вы прошли прототип и переходы понятны'],
    acceptExplanation: 'Экраны и прототип войдут в пакет для разработки.',
    importHint: null,
    playbook: {
      version: '1.0.0',
      instructions: [
        'Design the screens of the web application from the accepted features, for each role; plain words in the project language.',
        'Each role starts on a home screen. 2–6 screens per role, at most 20 in total. Keys: short latin snake_case, unique.',
        'Each screen: role key, a short purpose, the feature keys it serves, 1–6 blocks (kind list, table, form, details, text, actions, stats, search; title; field names) and links to other screen keys.',
        'Every must feature must appear on at least one screen. Do not invent features that are not in the list.',
      ],
    },
  },
  techplan: {
    key: 'techplan',
    version: '1.0.0',
    title: 'Архитектура',
    purpose: 'Покажем, как будет устроено то, что мы соберём: из чего состоит система, какие данные хранятся, как идёт каждый сценарий по шагам и какие шаги вашего процесса сделает сайт. Для разработчиков здесь же — точное описание (контракт API).',
    outcome: 'Схема данных, сценарии по шагам, что покрывает сайт из вашего процесса, страницы, ограничения и контракт API.',
    artifactType: 'techplan',
    inputs: ['goal', 'process', 'schedule', 'sitemap', 'products', 'features', 'screens'],
    ai: {
      level: 'none',
      whatItDoes: 'Архитектуру составляет платформа по принятым этапам, без ИИ: так она всегда совпадает с тем, что будет собрано. Вы можете добавить заметки для разработчиков.',
      instructionExamples: [],
    },
    acceptance: ['Понятно, что будет на сайте и как идут сценарии', 'Шаги, которые сайт не делает, вас устраивают или записаны в заметках', 'Ограничения этой версии вас устраивают'],
    acceptExplanation: 'Архитектура станет договорённостью для сборки. Если позже изменить процесс или расписание, она попросит обновиться.',
    importHint: null,
    contract: { explanation: 'Архитектура — договорённость о том, что собирается. Сборка проверяет, что она соответствует версии плана. Когда меняется процесс или расписание, архитектура получает уведомление и обновляется по новым данным.' },
    playbook: { version: '1.0.0', instructions: [] },
  },
  content: {
    key: 'content',
    version: '1.0.0',
    title: 'Структура и тексты',
    purpose: 'Соберём разделы сайта и напишем тексты для ваших клиентов. Это то, что посетитель будет читать.',
    outcome: 'Список блоков сайта с заголовками и текстами, а также описание для поисковиков.',
    artifactType: 'content',
    inputs: ['goal'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ напишет все тексты по паспорту проекта. Чтобы изменить один блок — нажмите «Изменить с ИИ» прямо на нём.',
      instructionExamples: ['Сделай первый экран короче', 'Добавь блок с частыми вопросами про доставку', 'Пиши без канцелярита, проще'],
    },
    acceptance: ['Есть первый экран с главной кнопкой', 'Есть блок с контактами', 'Нет незаполненных мест в квадратных скобках', 'Тексты не обещают того, чего вы не делаете'],
    acceptExplanation: 'Принятые тексты пойдут в сборку сайта. Блоки, которые вы правили руками, ИИ без вашей просьбы не перепишет.',
    importHint: 'Если тексты уже готовы, вставьте их: каждый блок начните с заголовка на отдельной строке, между блоками — пустая строка. На многостраничном сайте блок с заголовком, как у страницы в меню («Услуги», «Контакты»), начинает эту страницу.',
    playbook: {
      version: '1.0.0',
      instructions: [
        'Write for the audience from the brief, in the brief tone, in the project language.',
        'Single-page site: hero with the main action button first, contacts last; 4–7 sections in total.',
        'Do not invent testimonials, numbers of clients, years of experience, awards, prices or guarantees not present in the inputs.',
        'Hero text up to 2 sentences; section text up to 4 sentences; list items up to 2 sentences.',
        'Use square-bracket placeholders like [укажите ...] (Russian) or [add ...] (English) only when a needed fact is missing, so the owner sees what to add.',
        'If the confirmed inputs contain a sitemap: write the blocks of every page in map order, with the block types the map lists for it, and set page to the page key (the home page is «home»); 4–7 blocks on the home page, 1–5 on the others; fill pageSeo for every page except home. Otherwise set page to null and return an empty pageSeo.',
      ],
    },
  },
  design: {
    key: 'design',
    version: '1.1.0',
    title: 'Внешний вид',
    purpose: 'Выберем цвета, шрифт и форму элементов. Посмотреть результат можно сразу в предпросмотре.',
    outcome: 'Стиль сайта: цветовая палитра, шрифт, скругления и расположение первого экрана.',
    artifactType: 'design',
    // The style depends on the business and tone from the goal, not on the texts: it runs in parallel with them.
    inputs: ['goal'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ подберёт стиль под ваш бизнес и тон. Или выберите сами — все варианты проверены на читаемость.',
      instructionExamples: ['Хочу что-то нежное и светлое', 'Сделай строже, для юристов'],
    },
    acceptance: ['Сайт читается на телефоне', 'Стиль подходит вашим клиентам'],
    acceptExplanation: 'После принятия можно собрать сайт.',
    importHint: null,
    playbook: {
      version: '1.0.0',
      instructions: ['Pick only from the allowed presets; match palette and font to the business type and tone.'],
    },
  },
  build: {
    key: 'build',
    version: '1.0.0',
    title: 'Сборка и проверка',
    purpose: 'Соберём сайт из принятых текстов и стиля и проверим его. Если что-то не так, вернитесь к нужному этапу — сборку можно повторить.',
    outcome: 'Готовая страница сайта, отчёт проверок и файлы для скачивания.',
    artifactType: 'site',
    // schedule exists only on the online booking route; inputs are limited to the stages of the route.
    inputs: ['content', 'design', 'schedule', 'techplan', 'sitemap', 'products'],
    ai: {
      level: 'none',
      whatItDoes: 'Сборку делает платформа по правилам, без ИИ: так результат всегда одинаковый и проверяемый.',
      instructionExamples: [],
    },
    acceptance: ['Все обязательные проверки пройдены', 'Вы посмотрели сайт в предпросмотре на телефоне'],
    acceptExplanation: 'Принятая сборка попадёт в результат проекта: его можно скачать и передать на хостинг.',
    importHint: null,
    playbook: { version: '1.0.0', instructions: [] },
  },
  handoff: {
    key: 'handoff',
    version: '1.0.0',
    title: 'Пакет для разработки',
    purpose: 'Соберём всё, что нужно разработчику: техническое задание с критериями приёмки, права по ролям, схему данных, черновик контракта API и прототип экранов. Код приложения BuildPath не пишет — его делает разработчик по этому пакету.',
    outcome: 'Архив с ТЗ, правами, схемой данных, контрактом API и прототипом; проверка полноты.',
    artifactType: 'handoff',
    inputs: ['goal', 'process', 'features', 'screens', 'techplan'],
    ai: {
      level: 'none',
      whatItDoes: 'Пакет собирает платформа по принятым этапам, без ИИ: он всегда совпадает с тем, о чём вы договорились.',
      instructionExamples: [],
    },
    acceptance: ['Обязательные проверки полноты пройдены', 'Вы посмотрели ТЗ и прототип'],
    acceptExplanation: 'Принятый пакет можно скачать и передать разработчику. Пригласите разработчика на этот этап, если хотите вести работу в BuildPath.',
    importHint: null,
    playbook: { version: '1.0.0', instructions: [] },
  },
};

export const projectTypes: Record<ProjectTypeKey, ProjectTypeDefinition> = {
  landing: {
    key: 'landing',
    title: 'Одностраничный сайт',
    description: 'Одна страница, которая рассказывает о вас и ведёт к одному действию: позвонить, написать или прийти.',
    goodFor: 'Мастерам, небольшим услугам, мероприятиям, запуску продукта.',
    examples: ['Мастер маникюра', 'Торты на заказ', 'Репетитор', 'Мероприятие'],
    stages: ['goal', 'process', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница сайта в виде файла и все тексты проекта.',
  },
  company_site: {
    key: 'company_site',
    title: 'Сайт компании',
    description: 'Подробная страница компании: услуги и цены, о вас, как работаете, контакты и часы работы.',
    goodFor: 'Небольшим компаниям, салонам, студиям, сервисам.',
    examples: ['Автосервис', 'Стоматология', 'Юридическая консультация', 'Студия йоги'],
    stages: ['goal', 'process', 'offer', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница компании в виде файла, список услуг и все тексты проекта.',
  },
  multipage: {
    key: 'multipage',
    title: 'Многостраничный сайт',
    description: 'Несколько страниц с меню: главная, услуги, о вас, вопросы, контакты — у каждой свой адрес и своё описание для поисковиков.',
    goodFor: 'Компаниям с несколькими направлениями услуг, клиникам, школам, сервисам, которым тесно на одной странице.',
    examples: ['Стоматология', 'Языковая школа', 'Ремонт квартир', 'Юридическая фирма'],
    stages: ['goal', 'process', 'offer', 'sitemap', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный сайт из нескольких страниц с меню, файлы всех страниц, карта сайта и все тексты проекта.',
  },
  store: {
    key: 'store',
    title: 'Небольшой интернет-магазин',
    description: 'Витрина с товарами, корзина и заказ без регистрации: клиент выбирает товары и способ получения, а вы получаете заказ в Telegram и видите все заказы в проекте.',
    goodFor: 'Небольшим магазинам и мастерским: до 60 товаров, самовывоз или доставка, оплата при получении или переводом.',
    examples: ['Кондитерская', 'Цветы', 'Мыло ручной работы', 'Кофе в зёрнах'],
    stages: ['goal', 'process', 'products', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный магазин с витриной, корзиной и формой заказа, каталог и все тексты проекта. Заказы принимаются, когда сайт опубликован на BuildPath. Онлайн-оплаты пока нет.',
  },
  booking: {
    key: 'booking',
    title: 'Онлайн-запись к мастеру',
    description: 'Сайт с записью: клиент выбирает услугу, мастера и свободное время, а вы получаете запись в Telegram и видите все записи в проекте.',
    goodFor: 'Салонам красоты, барбершопам, массажу, тренерам, репетиторам — всем, кто работает по времени.',
    examples: ['Барбершоп', 'Маникюр', 'Массаж', 'Автомойка'],
    stages: ['goal', 'process', 'offer', 'schedule', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный сайт с онлайн-записью, список услуг, расписание и все тексты проекта. Запись работает, когда сайт опубликован на BuildPath.',
  },
  web_app: {
    key: 'web_app',
    title: 'Веб-приложение',
    description: 'Приложение со входом, ролями и своей логикой: кабинет клиента, учёт заявок, внутренняя система. BuildPath доведёт его до полного пакета для разработчика — функции, экраны с прототипом, архитектуру и контракт API.',
    goodFor: 'Тем, кому нужен личный кабинет, учёт или внутренний сервис, и кто будет заказывать разработку.',
    examples: ['Кабинет клиента сервиса', 'Учёт заявок и выездов', 'Запись на курсы с кабинетом ученика', 'Внутренняя система для сотрудников'],
    stages: ['goal', 'process', 'features', 'screens', 'techplan', 'handoff'],
    resultExplanation: 'Пакет для разработки: техническое задание, права по ролям, схема данных, контракт API и кликабельный прототип. Код приложения пишет разработчик — BuildPath его не создаёт и не публикует.',
  },
};

export function projectTypeOf

(key: string | null | undefined): ProjectTypeDefinition | null {
  return key && key in projectTypes ? projectTypes[key as ProjectTypeKey] : null;
}

/** Inputs of a stage limited to stages present in the given route. */
export function routeInputs(route: StageKey[], key: StageKey): StageKey[] {
  const own = stageDefinitions[key].inputs.filter((input) => route.includes(input));
  // Content of a company site also depends on the offer stage.
  if (key === 'content' && route.includes('offer')) own.push('offer');
  // Texts of a multi-page site are written page by page from the map.
  if (key === 'content' && route.includes('sitemap')) own.push('sitemap');
  // The storefront texts mention what the store sells.
  if (key === 'content' && route.includes('products')) own.push('products');
  return own;
}

export function routeDependents(route: StageKey[], key: StageKey): StageKey[] {
  const result = new Set<StageKey>();
  const visit = (current: StageKey) => {
    for (const candidate of route) {
      if (!result.has(candidate) && routeInputs(route, candidate).includes(current)) {
        result.add(candidate);
        visit(candidate);
      }
    }
  };
  visit(key);
  return route.filter((candidate) => result.has(candidate));
}

export function routeAncestors(route: StageKey[], key: StageKey): StageKey[] {
  const result = new Set<StageKey>();
  const visit = (current: StageKey) => {
    for (const input of routeInputs(route, current)) {
      if (!result.has(input)) { result.add(input); visit(input); }
    }
  };
  visit(key);
  return route.filter((candidate) => result.has(candidate));
}

export const statusExplanations: Record<string, { label: string; explanation: string }> = {
  locked: { label: 'Закрыт', explanation: 'Откроется, когда будут приняты этапы, от которых он зависит.' },
  ready: { label: 'Можно начинать', explanation: 'Всё нужное для этапа готово.' },
  awaiting_lead: { label: 'Ожидает ведущего', explanation: 'Приглашённый специалист ещё не принял приглашение.' },
  in_progress: { label: 'В работе', explanation: 'Есть черновик. Проверьте его и примите, когда всё устраивает.' },
  in_review: { label: 'На приёмке', explanation: 'Версия отправлена владельцу на проверку.' },
  changes_requested: { label: 'Нужны правки', explanation: 'Владелец попросил изменить результат.' },
  approved: { label: 'Принят', explanation: 'Результат этапа принят и передан дальше.' },
  stale: { label: 'Нужно проверить', explanation: 'Изменился предыдущий этап. Проверьте, подходит ли результат, или обновите его.' },
  imported: { label: 'Свои материалы', explanation: 'Вы принесли готовый результат. Платформа его не создавала.' },
  skipped: { label: 'Пропущен', explanation: 'Этап необязателен и пропущен.' },
  blocked: { label: 'Заблокирован', explanation: 'Есть препятствие, которое нужно устранить.' },
};
