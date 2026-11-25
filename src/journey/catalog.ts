// Versioned, deterministic catalog of project types and stage contracts.
// Every user-visible explanation lives here so the web, Telegram and exports show the same wording.

export const ROUTE_CATALOG_VERSION = '1.16.0';

export type StageKey = 'goal' | 'idea' | 'process' | 'suggestions' | 'concept' | 'offer' | 'products' | 'schedule' | 'sitemap' | 'features' | 'screens' | 'techplan' | 'contracts' | 'roadmap' | 'testplan' | 'content' | 'design' | 'build' | 'handoff' | 'launch';
export type ArtifactType = 'brief' | 'idea' | 'process' | 'suggestions' | 'concept' | 'offer' | 'catalog' | 'schedule' | 'sitemap' | 'features' | 'screens' | 'techplan' | 'contracts' | 'roadmap' | 'testplan' | 'content' | 'design' | 'site' | 'handoff' | 'launch';
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
  /**
   * The owner or a manager may skip the stage with a written reason (PRODUCT_LIFECYCLE.md §5): the stages after it then
   * go on without it. `why` says when skipping is fine. The stage can be taken up again later.
   */
  optional?: { why: string };
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
  idea: {
    key: 'idea',
    version: '1.0.0',
    title: 'Разбор идеи',
    purpose: 'Доведём идею до ясности и найдём дыры раньше, чем на них потрачены деньги: какую проблему решаем и для кого, почему выберут вас, как люди справляются сейчас, как продукт зарабатывает, какие риски вы принимаете сознательно и как поймём, что всё работает.',
    outcome: 'Проблема и группы пользователей, ценность, альтернативы, как продукт зарабатывает, риски с решениями, измеримые цели успеха и ограничения.',
    artifactType: 'idea',
    inputs: ['goal'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ разложит идею по полям и честно пометит, чего вы не сказали. Альтернативы, которые предложит ИИ, попадут в документы, только когда вы их подтвердите.',
      instructionExamples: ['Главный риск — мастера не захотят работать через приложение', 'Цель: 50 заказов в месяц через полгода', 'Конкуренты — заказ по телефону и Instagram'],
    },
    acceptance: ['Понятно, какую проблему решаем и для кого', 'Есть измеримая цель успеха', 'По каждому важному риску принято решение'],
    acceptExplanation: 'Разбор станет основой бизнес-процесса и ТЗ: функции будут вытекать из проблемы и целей, а риски — учитываться в плане.',
    importHint: 'Если у вас уже есть описание идеи, бизнес-план или презентация — вставьте текст: мы разложим его по полям и покажем, чего не хватает.',
    optional: { why: 'Можно пропустить, если идея уже проверена — например, бизнес давно работает и вы переносите его в интернет. Позже к разбору можно вернуться.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Work only from the brief, the conversation and the user instruction, in the project language and in plain words.',
        'Never invent facts, numbers or market data. What the user did not say stays an empty string; add it to risks as an open question when it matters.',
        'problem: the pain of the clients in one or two sentences, not a description of the product.',
        'segments: 1–3 groups of people who use or pay, each with what they need.',
        'value: why these people would choose this over how they cope today.',
        'alternatives: how people solve it now (a competitor, a phone call, Instagram, doing nothing). Ones the user named have source «owner»; ones you suggest have source «ai» and confirmed false.',
        'revenue: how it earns (price, subscription, commission) or what it saves for an internal tool — only from what the user said.',
        'risks: assumptions that may be wrong and things that can go wrong, with impact high/medium/low; decision «open» unless the user said how they handle it.',
        'metrics: 1–3 measurable goals with a number and a period, only from what the user said; if none, leave empty.',
        'constraints: deadline, budget, legal requirements and where data must be stored — only if mentioned.',
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
    inputs: ['goal', 'idea'],
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
      version: '1.2.0',
      instructions: [
        'Describe the real process of this business from the brief, in plain words, in the project language.',
        'Actors: the client, the business (owner), staff if any, the site as «system», external services only if mentioned. At most 6.',
        'Scenarios: 1–4 main ones (the client journey first), each 2–8 short steps in order; each step is one action by one actor.',
        'Tag every step with the closest capability; use «offline» for things people do outside the site and «other» if nothing fits. Never mark pay_online or account unless the user asked for them.',
        'Rules: business rules the user stated or that follow directly from the brief (cancellation, prepayment, working hours). Do not invent numbers.',
        'Data: the information the business keeps (client, booking, request, service…) with 2–6 simple fields in plain words and links between them.',
        'When the data keeps people\'s contacts or other personal details, add a rule: they are kept with consent, only for the stated purpose, and deleted on request. With online payment, add a step that confirms the payment and a rule for refunds.',
        'Every actor takes part in at least one step; every scenario has a goal saying how it ends; every link points to an entity in the list.',
        'The current result may hold «situations»: the owner\'s answers to platform questions. The platform adds their rules itself; keep the situations as they are and do not repeat or reword their rules in rules.',
      ],
    },
  },
  suggestions: {
    key: 'suggestions',
    version: '1.0.0',
    title: 'Предложения функций',
    purpose: 'Подскажем, что обычно бывает в таких продуктах: напоминания, онлайн-оплата, уведомления, отчёты. Каждое предложение объясняет, что оно даёт и из какого шага вашего процесса вытекает. Вы решаете: в первую версию, потом или не нужно.',
    outcome: 'Список возможностей с решением по каждой: в первую версию, потом или не нужно, — и причиной.',
    artifactType: 'suggestions',
    inputs: ['idea', 'process'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ отберёт из каталога то, что подходит вашему процессу и целям, и объяснит каждое предложение. Решаете вы — ИИ ничего не добавляет в продукт сам.',
      instructionExamples: ['Предложи, что поможет клиентам возвращаться', 'Что нужно для работы с несколькими филиалами?', 'Онлайн-оплата пока не нужна'],
    },
    acceptance: ['По каждому предложению принято решение', 'Понятно, что входит в первую версию, а что отложено'],
    acceptExplanation: 'Выбранное «в первую версию» станет обязательными функциями ТЗ, «потом» — функциями на потом. Если ТЗ уже есть, оно получит уведомление об изменении.',
    importHint: 'Есть свой список желаемых функций? Вставьте текст — каждая строка станет предложением, по которому вы примете решение.',
    optional: { why: 'Можно пропустить, если вы точно знаете, что войдёт в первую версию. Позже к предложениям можно вернуться.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Suggest capabilities the product may need, from the idea review and the business process, in plain words and in the project language.',
        'Choose from the catalog first (see below). Use its key as catalogKey and key, keep its title, and source «catalog». Suggest a catalog item only if the project type and the process fit it.',
        'You may add up to 4 suggestions of your own with source «ai» and catalogKey null — only when a step of the process or a goal of the idea clearly needs it.',
        'basis: for every suggestion, the scenario step («Сценарий «Запись»: клиент выбирает время») or the goal of the idea it follows from. No basis — no suggestion.',
        'value: what it gives the business, one sentence. effort: small, medium or large. support for your own items: code or not_yet (never promise «site»); payments, SMS, messengers and analytics are account.',
        'decision: leave an empty string — the owner decides. Keep the decisions the owner already made.',
        'Never suggest what the process already has. 3–12 suggestions in total.',
        'Catalog (key: title — value): reminders, cancel_booking, pay_online, prepay_booking, owner_alerts, order_alerts, status_updates, client_account, staff_roles, reports, export, search, messenger, faq, reviews, analytics.',
      ],
    },
  },
  concept: {
    key: 'concept',
    version: '1.0.0',
    title: 'Концепция продукта',
    purpose: 'Соберём один документ, который поймёт любой: инвестор, партнёр, разработчик, новый сотрудник. Платформа сама собирает его из принятых этапов — идеи, процесса со схемами и первой версии; от вас — пара фраз «в двух словах», словарь и открытые вопросы.',
    outcome: 'Документ с оглавлением, схемами процесса и данных, словарём и открытыми вопросами — его можно скачать в Word, PDF или Markdown.',
    artifactType: 'concept',
    inputs: ['goal', 'idea', 'process', 'suggestions'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ напишет «в двух словах», подберёт термины для словаря и соберёт открытые вопросы. Разделы из принятых этапов он не переписывает. Проверка ИИ читает документ глазами постороннего и говорит, что непонятно.',
      instructionExamples: ['Пиши для инвестора: коротко и про деньги', 'Добавь в словарь «предоплата»', 'Объясни проще, без терминов'],
    },
    acceptance: ['Документ понятен человеку, который не участвовал в проекте', 'Каждый термин объяснён в словаре', 'Открытые вопросы записаны, а не спрятаны'],
    acceptExplanation: 'Документ можно показать партнёрам и разработчику. Если позже изменятся идея или процесс, концепция получит уведомление и соберётся заново.',
    importHint: 'Есть своё описание продукта или презентация? Вставьте текст — первые абзацы станут «в двух словах», остальное вы разложите сами.',
    optional: { why: 'Можно пропустить, если документ для других людей пока не нужен. Позже его можно собрать в любой момент.' },
    playbook: {
      version: '1.0.0',
      instructions: [
        'Write only the owner\'s parts of the product concept document, in plain words and in the project language. The sections from accepted stages are assembled by the platform; do not rewrite them.',
        'pitch: 2–3 sentences — what the product is, for whom and which problem it solves. Only facts from the inputs; no market numbers, no praise.',
        'glossary: words from the inputs an outsider may not know (ТЗ, CRM, сегмент, личный кабинет, names of roles or data special to this business), each with a one-sentence plain meaning. 0–15 terms.',
        'questions: decisions still open in the inputs — risks without a decision, missing revenue or goals, «later» answers, undecided suggestions. Phrase each as a question. Do not answer them.',
        'notes: leave as is unless the user asks.',
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
    version: '2.1.0',
    title: 'ТЗ',
    purpose: 'Запишем техническое задание: что должен уметь ваш продукт, кто им пользуется и что войдёт в первую версию. У каждой функции — понятное «готово»: по нему вы, ИИ и разработчик поймёте, что она сделана.',
    outcome: 'Кратко о продукте, роли, функции с приоритетом и критериями «готово», общие требования, ограничения и открытые вопросы.',
    artifactType: 'features',
    inputs: ['goal', 'process', 'suggestions'],
    ai: {
      level: 'ai_full',
      whatItDoes: 'ИИ составит ТЗ по цели и бизнес-процессу: роли, функции с критериями «готово», требования и ограничения — и предложит, что сделать в первой версии, а что потом. Вы решаете, что войдёт в первую версию.',
      instructionExamples: ['Онлайн-оплату — позже, не в первой версии', 'Добавь роль администратора, который видит все заявки', 'Клиент должен видеть историю своих записей'],
    },
    acceptance: ['Функции такие, как нужно вашему делу', 'Отмечено, что войдёт в первую версию', 'У каждой функции есть понятный критерий «готово»'],
    acceptExplanation: 'ТЗ станет основой следующих этапов: страниц или экранов, архитектуры и текстов. Если позже его изменить, они получат уведомление.',
    importHint: 'Есть своё ТЗ? Загрузите его — ИИ разложит его по разделам этапа и покажет, чего не хватает.',
    contract: { explanation: 'ТЗ — договорённость о том, что делает продукт и что входит в первую версию. Следующие этапы строятся по нему.' },
    playbook: {
      version: '2.1.0',
      instructions: [
        'Write the specification (ТЗ) of the product from the brief and the business process, in plain words a non-technical owner understands, in the project language.',
        'summary: 1–3 sentences — what the product is, for whom and which task it solves.',
        'Roles: the people who use the product. For a web application, those who sign in (clients, staff, the owner as administrator). For a website, its visitors (clients) and the people who take the requests, bookings or orders (the owner, staff); visitors do not sign in. 1–6. Keys: short latin snake_case.',
        'Features: 3–20 concrete things a role does; each with the roles that use it, priority must/should/later and 1–5 acceptance criteria the owner can check («готово, когда…»).',
        'First version: mark as must only what the product cannot work without; the rest is should or later. Payments, integrations, loyalty programs and analytics are should or later unless the owner asked for them in the first version.',
        'A website does only what the capabilities of its kind allow (the process marks steps the site cannot do as offline or unsupported): put such wishes into later and name them in limits, never promise them in must.',
        'sensitivity: personal when the product keeps people\'s contacts; payments or health only when stated. integrations: only services the owner named.',
        'With personal or health data, add a must feature for consent (at sign-up in an app, in the form on a website) and deleting the data on request. With payments, a feature for payment confirmation, receipt and refund. With several roles in an app, one acceptance criterion says each role sees only what it is allowed to.',
        'Every role uses at least one feature; features name only roles from the list.',
        'data: keys of the records from the business process data that the feature creates, changes or shows, plus «user» for accounts in an app. Every record of the process is used by at least one feature.',
        'requirements: up to 10 general requirements in plain words (works on a phone, languages, how fast a page opens, what data is kept and how long) — only those that follow from the inputs.',
        'limits: up to 10 limits and assumptions: what this version does not do and what was decided later in the process (situations answered «later»).',
        'questions: up to 10 open questions the owner still has to decide; do not invent answers to them.',
        'story for every must and should feature: «Как {роль}, я хочу {действие}, чтобы {польза}» in one sentence.',
        'cases: 1–3 checks per must feature in the form given / when / then, concrete enough to test by hand: one usual path and one where something goes wrong (wrong input, no free time, no access). They become test cases.',
        'sources: where each feature comes from — «step:<scenario key>.<step key>» for every step of the process it covers, «suggestion:<key>» for a choice made in feature suggestions, «rule:privacy» or «rule:signin» for those platform rules, «owner» when only the user asked for it. Every step of the process the product does itself (not offline) is covered by some feature.',
        'access: one row per role and data the role uses: actions view/create/edit/delete, scope own (only their own records: clients) or all. A client never gets «all» on other people\'s personal data; on a website visitors only create.',
        'quality (non-functional, plain words, empty string when not stated): speed, users (how many at once), languages, devices, accessibility, dataLocation, backups, retention. Fill only from the inputs; devices and languages may follow from the project.',
        'services: outside services the product needs (payments, SMS, email, messengers, accounting), each with what for and accessBy: owner (the owner\'s own account), platform or developer. integrations: their names.',
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
      version: '1.1.0',
      instructions: [
        'Design the screens of the web application from the accepted features, for each role; plain words in the project language.',
        'Each role starts on a home screen. 2–6 screens per role, at most 20 in total. Keys: short latin snake_case, unique.',
        'Each screen: role key, a short purpose, the feature keys it serves, 1–6 blocks (kind list, table, form, details, text, actions, stats, search; title; field names) and links to other screen keys.',
        'Every must feature must appear on at least one screen. Do not invent features that are not in the list.',
        'Every screen of a role can be reached by links from that role\'s home screen; links go only to screens of the same role and to existing keys; every form lists its fields.',
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
  contracts: {
    key: 'contracts',
    version: '1.0.0',
    title: 'Контракты',
    purpose: 'Договоримся о границах, по которым разные люди или ИИ-агенты могут писать части приложения одновременно и не ломать друг друга: какие модули есть и какими данными владеет каждый, какие операции даёт сервер, кто может их вызывать и какие ошибки бывают, какие события и уведомления отправляются и что делать, если внешний сервис не отвечает.',
    outcome: 'Модули, операции API с правами и ошибками, события, интеграции; файлы openapi.yaml и первая миграция базы.',
    artifactType: 'contracts',
    inputs: ['process', 'features', 'techplan'],
    ai: {
      level: 'none',
      whatItDoes: 'Первый вариант платформа строит сама из схемы данных архитектуры, матрицы «кто что может» и функций ТЗ. Вы со специалистом правите его и подтверждаете.',
      instructionExamples: [],
    },
    acceptance: ['Каждая функция ТЗ покрыта операцией', 'Права операций не шире матрицы «кто что может»', 'У операций описаны ошибки', 'У каждой записи один модуль-владелец', 'Для внешних сервисов сказано, что делать при сбое'],
    acceptExplanation: 'Контракты станут договорённостью для разработки: модули пишутся по ним параллельно. Изменить их можно только новой версией — тогда этапы после получат уведомление.',
    importHint: null,
    contract: { explanation: 'Контракт — то, на что опираются все, кто пишет код: пока он не меняется, модули можно делать одновременно. Любое изменение — новая версия с уведомлением тем, кто на неё опирается.' },
    playbook: { version: '1.0.0', instructions: [] },
  },
  roadmap: {
    key: 'roadmap',
    version: '1.0.0',
    title: 'План реализации',
    purpose: 'Разделим работу на модули по контрактам и решим, в каком порядке их делать: что можно параллельно, что идёт в первую версию, сколько это часов и запросов к ИИ и кто делает каждый модуль. После утверждения план становится рабочим инструментом: у каждой задачи — статус, исполнитель и срок, а прогресс считается по оценкам.',
    outcome: 'Модули с задачами, граф зависимостей с критическим путём, выпуски, оценка часов и запросов к ИИ, исполнители, риски; затем — ход работ.',
    artifactType: 'roadmap',
    inputs: ['idea', 'features', 'techplan', 'contracts'],
    ai: {
      level: 'none',
      whatItDoes: 'Первый вариант платформа строит сама по контрактам, ТЗ и схеме данных: модуль на каждый модуль контрактов, задачи из операций, функций, событий и интеграций, порядок — из связей данных. Граф, критический путь и срок пересчитываются сами.',
      instructionExamples: [],
    },
    acceptance: ['В зависимостях нет циклов', 'Каждая обязательная функция в каком-то модуле', 'У каждого модуля есть исполнитель и оценка', 'Срок и бюджет вас устраивают'],
    acceptExplanation: 'Утверждённый план — договорённость о порядке работ и бюджете. Дальше в нём отмечают ход работ: статусы задач, исполнителей и сроки.',
    importHint: null,
    playbook: { version: '1.0.0', instructions: [] },
  },
  testplan: {
    key: 'testplan',
    version: '1.0.0',
    title: 'План проверки',
    purpose: 'Решим заранее, как проверим приложение, — до того, как написан код. Каждый кейс — инструкция: кто действует, что делает по шагам и что должно и не должно получиться. Есть нормальный путь, ошибки, крайние случаи, недобросовестный пользователь, права, безопасность, личные данные, сбои, нагрузка и устройства. Кейсы привязаны к задачам плана: задача готова, только когда её кейсы пройдены.',
    outcome: 'Кейсы по классам с шагами и ожидаемым результатом, связь с функциями, правами, угрозами и задачами плана; итог простыми словами.',
    artifactType: 'testplan',
    inputs: ['process', 'features', 'techplan', 'contracts', 'roadmap'],
    ai: {
      level: 'none',
      whatItDoes: 'Первый вариант платформа строит сама: из историй ТЗ, матрицы прав, ответов «Вы это учли?», угроз архитектуры, интеграций контрактов и нефункциональных требований. Специалист по тестированию или безопасности может проверить и дополнить.',
      instructionExamples: [],
    },
    acceptance: ['У каждой обязательной функции есть нормальный путь и «кому нельзя»', 'Каждая угроза архитектуры проверяется', 'У каждого кейса есть ожидаемый результат', 'Вы прочитали «Что мы проверим — простыми словами»'],
    acceptExplanation: 'Утверждённый план проверки — договорённость о том, что считается «работает». По нему пишутся автотесты, а задачи плана реализации становятся готовыми, только когда их кейсы пройдены.',
    importHint: null,
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
      version: '1.2.0',
      instructions: [
        'Write for the audience from the brief, in the brief tone, in the project language.',
        'Single-page site: hero with the main action button first, contacts last; 4–7 sections in total.',
        'Do not invent testimonials, numbers of clients, years of experience, awards, prices or guarantees not present in the inputs.',
        'Hero text up to 2 sentences; section text up to 4 sentences; list items up to 2 sentences.',
        'Use square-bracket placeholders like [укажите ...] (Russian) or [add ...] (English) only when a needed fact is missing, so the owner sees what to add.',
        'If the confirmed inputs contain a specification (ТЗ, features): describe only what the features with priority must or should do; never promise features with priority later or what its limits exclude.',
        'If the confirmed inputs contain a business process: tell visitors, in plain words, the rules from its rules list that matter to them before they book, order or write (cancellation, prepayment, returns, delivery, answer time), for example in a FAQ block or next to the main action. Use only those rules; never add other conditions.',
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
    purpose: 'Соберём всё, что нужно для кода: техническое задание с критериями приёмки, права по ролям, схему данных, черновик контракта API и прототип экранов. По пакету ИИ-агент пишет всё приложение — экраны, вход, базу данных и тесты, — а BuildPath проверяет его и отправляет в ваш репозиторий. Разработчик может продолжить с этого же пакета.',
    outcome: 'Архив с ТЗ, правами, схемой данных, контрактом API и прототипом; проверка полноты.',
    artifactType: 'handoff',
    inputs: ['goal', 'process', 'features', 'screens', 'techplan', 'contracts', 'roadmap', 'testplan'],
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
  launch: {
    key: 'launch',
    version: '1.0.0',
    title: 'Подготовка к запуску',
    purpose: 'Проверим, что приложение можно открыть людям и сбой не останется незамеченным. Часть проверяет платформа: кейсы плана проверки, ваша приёмка сценариев, адрес приложения по HTTPS и настоящая база данных. Остальное вы отмечаете сами: домен, юридические тексты, почта, резервные копии, мониторинг, перенос данных, цифры успеха, проверка безопасности.',
    outcome: 'Чек-лист запуска: проверки платформы и ваши отметки с причинами; принятый этап — решение запускать.',
    artifactType: 'launch',
    inputs: ['idea', 'features', 'techplan', 'testplan', 'handoff'],
    ai: {
      level: 'none',
      whatItDoes: 'Проверки делает платформа по плану проверки и проверке развёртывания, без ИИ. Пункты чек-листа отмечаете вы.',
      instructionExamples: [],
    },
    acceptance: ['Блокирующие кейсы пройдены, главные сценарии приняты, замечаний нет', 'Приложение отвечает по HTTPS и работает с базой данных', 'Резервные копии и мониторинг настроены', 'Если чего-то нет — риск принят письменно'],
    acceptExplanation: 'Принятый этап — ваше решение открыть приложение людям. Если что-то не готово, его можно принять только с письменным объяснением, и оно сохранится в журнале.',
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
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница сайта в виде файла и все тексты проекта.',
  },
  company_site: {
    key: 'company_site',
    title: 'Сайт компании',
    description: 'Подробная страница компании: услуги и цены, о вас, как работаете, контакты и часы работы.',
    goodFor: 'Небольшим компаниям, салонам, студиям, сервисам.',
    examples: ['Автосервис', 'Стоматология', 'Юридическая консультация', 'Студия йоги'],
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'offer', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница компании в виде файла, список услуг и все тексты проекта.',
  },
  multipage: {
    key: 'multipage',
    title: 'Многостраничный сайт',
    description: 'Несколько страниц с меню: главная, услуги, о вас, вопросы, контакты — у каждой свой адрес и своё описание для поисковиков.',
    goodFor: 'Компаниям с несколькими направлениями услуг, клиникам, школам, сервисам, которым тесно на одной странице.',
    examples: ['Стоматология', 'Языковая школа', 'Ремонт квартир', 'Юридическая фирма'],
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'offer', 'sitemap', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный сайт из нескольких страниц с меню, файлы всех страниц, карта сайта и все тексты проекта.',
  },
  store: {
    key: 'store',
    title: 'Небольшой интернет-магазин',
    description: 'Витрина с товарами, корзина и заказ без регистрации: клиент выбирает товары и способ получения, а вы получаете заказ в Telegram и видите все заказы в проекте.',
    goodFor: 'Небольшим магазинам и мастерским: до 60 товаров, самовывоз или доставка, оплата при получении или переводом.',
    examples: ['Кондитерская', 'Цветы', 'Мыло ручной работы', 'Кофе в зёрнах'],
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'products', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный магазин с витриной, корзиной и формой заказа, каталог и все тексты проекта. Заказы принимаются, когда сайт опубликован на BuildPath. Онлайн-оплаты пока нет.',
  },
  booking: {
    key: 'booking',
    title: 'Онлайн-запись к мастеру',
    description: 'Сайт с записью: клиент выбирает услугу, мастера и свободное время, а вы получаете запись в Telegram и видите все записи в проекте.',
    goodFor: 'Салонам красоты, барбершопам, массажу, тренерам, репетиторам — всем, кто работает по времени.',
    examples: ['Барбершоп', 'Маникюр', 'Массаж', 'Автомойка'],
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'offer', 'schedule', 'techplan', 'content', 'design', 'build'],
    resultExplanation: 'Опубликованный сайт с онлайн-записью, список услуг, расписание и все тексты проекта. Запись работает, когда сайт опубликован на BuildPath.',
  },
  web_app: {
    key: 'web_app',
    title: 'Веб-приложение',
    description: 'Приложение со входом, ролями и своей логикой: кабинет клиента, учёт заявок, внутренняя система. BuildPath доведёт его до полного пакета — функции, экраны с прототипом, архитектуру и контракт API, — а ИИ-агент напишет по нему код приложения.',
    goodFor: 'Тем, кому нужен личный кабинет, учёт или внутренний сервис.',
    examples: ['Кабинет клиента сервиса', 'Учёт заявок и выездов', 'Запись на курсы с кабинетом ученика', 'Внутренняя система для сотрудников'],
    stages: ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'screens', 'techplan', 'contracts', 'roadmap', 'testplan', 'handoff', 'launch'],
    resultExplanation: 'Пакет для разработки — техническое задание, права по ролям, схема данных, контракт API и кликабельный прототип — и код всего приложения, который пишет ИИ-агент и проверяет платформа. Запускаете вы: на своём Render или сервере.',
  },
};

/**
 * A stage as one project type sees it. The goal form speaks of a site («посетитель», «главная кнопка сайта»); for an
 * application that wording led the AI to pick a messenger button for a repair service whose owner spoke of requests. The
 * shape of the result stays the same, only the words and the AI's guidance change.
 */
/** A stage's title as the project type names it («Цель приложения» for an application). */
export function stageTitle(key: StageKey, typeKey: string | null | undefined): string {
  return stageFor(key, typeKey).title;
}

export function stageFor(key: StageKey, typeKey: string | null | undefined): StageDefinition {
  const definition = stageDefinitions[key];
  if (typeKey === 'web_app' && key === 'techplan') {
    return {
      ...definition,
      purpose: 'Решим, как будет устроено приложение. Платформа подготовит первый вариант по процессу и ТЗ, а вы со специалистом его поправите: схему данных с типами полей и связями, компоненты из каталога, решения с вариантами, угрозы и меры против них, окружения. Сценарии по шагам и контракт API для разработчика строятся из этого сами.',
      outcome: 'Схема данных, компоненты, решения, угрозы и меры, окружения, сценарии по шагам и контракт API.',
      acceptance: ['Все данные из ТЗ есть в схеме', 'Все интеграции из ТЗ стали компонентами', 'У денег и личных данных описаны угрозы и меры', 'По требованиям ТЗ приняты решения'],
      acceptExplanation: 'Архитектура станет договорённостью для разработки: по ней строятся контракты и план. Если позже изменится ТЗ, она получит уведомление.',
    };
  }
  if (typeKey === 'web_app' && key === 'process') {
    return {
      ...definition,
      purpose: 'Опишем, как работает ваше дело: кто участвует, как заявка или заказ проходит путь от клиента до результата, какие правила действуют и какую информацию вы храните. Схемы покажут это наглядно — по ним видно, что будет делать приложение, а что останется за вами.',
      acceptExplanation: 'Процесс станет основой ТЗ и архитектуры: по нему видно, какие шаги сделает приложение, а какие останутся ручными.',
      playbook: {
        ...definition.playbook,
        instructions: [
          ...definition.playbook.instructions,
          'This is a web application, not a site: the «system» actor is the application. Tag app actions with create_request (a client creates a request or order), assign (someone assigns a person to it), change_status (a status changes or work is marked done) and manage_staff (staff and their access); use offline only for work done outside the application.',
        ],
      },
    };
  }
  if (key !== 'goal' || typeKey !== 'web_app') return definition;
  const appFieldWhy: Record<string, string> = {
    businessName: 'Покажем его в приложении и во вкладке браузера.',
    whatYouDo: 'Из этого приложение объяснит клиенту, чем вы помогаете, а ИИ поймёт, какие данные нужны.',
    audience: 'Экраны и тексты приложения будут сделаны для этих людей и их задач.',
    tone: 'От этого зависит стиль текстов в приложении.',
  };
  const appActions: Partial<Record<string, { label: string; hint: string }>> = {
    form: { label: 'Оставить заявку в приложении', hint: 'Клиент создаёт заявку или заказ в приложении, вы и сотрудники ведёте её там до конца.' },
    message: { label: 'Написать вам в мессенджер', hint: 'Приложение подскажет клиенту написать в Telegram или WhatsApp.' },
    call: { label: 'Позвонить вам', hint: 'Приложение покажет номер для звонка.' },
  };
  return {
    ...definition,
    title: 'Цель приложения',
    purpose: 'Поймём, кому нужно приложение и с чего клиент начинает работу с вами. От этого зависят следующие этапы: процесс, функции, экраны и код.',
    outcome: 'Короткий паспорт проекта: кто вы, кто пользуется приложением и с чего начинается работа.',
    contract: { explanation: 'Цель приложения — договорённость для всех следующих этапов: процесса, ТЗ, экранов и кода. Если позже поменять цель, каждый этап, построенный на ней, получит уведомление и решит, что делать.' },
    fields: (definition.fields ?? []).map((field) => field.key !== 'mainAction' ? { ...field, why: appFieldWhy[field.key] ?? field.why } : {
      ...field,
      label: 'С чего клиент начинает работу с вами?',
      why: 'Это первое действие клиента в приложении. Вокруг него строятся процесс и экраны.',
      example: 'Оставить заявку в приложении',
      options: (field.options ?? []).map((option) => ({ ...option, ...(appActions[option.value] ?? {}) })),
    }),
    playbook: {
      ...definition.playbook,
      instructions: [
        ...definition.playbook.instructions.filter((rule) => !rule.startsWith('Choose mainAction')),
        'This is a web application, not a site. Choose mainAction «form» when clients create requests, orders or bookings that the business then handles (assigns, changes status, completes); choose message, call, email or visit only when the user says clients just contact them that way.',
      ],
    },
  };
}

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
  // Texts tell visitors the rules that matter to them (cancellation, returns, answer time) from the accepted process.
  if (key === 'content' && route.includes('process')) own.push('process');
  // Texts describe what the first version does: functions the ТЗ puts off are not promised to visitors.
  if (key === 'content' && route.includes('features')) own.push('features');
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
  skipped: { label: 'Пропущен', explanation: 'Этап необязателен и пропущен — причина записана. К нему можно вернуться.' },
  blocked: { label: 'Заблокирован', explanation: 'Есть препятствие, которое нужно устранить.' },
};
