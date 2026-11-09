// Versioned, deterministic catalog of project types and stage contracts.
// Every user-visible explanation lives here so the web, Telegram and exports show the same wording.

export const ROUTE_CATALOG_VERSION = '1.1.0';

export type StageKey = 'goal' | 'offer' | 'content' | 'design' | 'build';
export type ArtifactType = 'brief' | 'offer' | 'content' | 'design' | 'site';
export type AiLevel = 'ai_full' | 'ai_draft' | 'ai_assist' | 'none';
export type ProjectTypeKey = 'landing' | 'company_site';

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
    playbook: {
      version: '1.0.0',
      instructions: [
        'Fill only facts present in the user description; leave unknown fields empty rather than inventing them.',
        'Keep wording short and in the project language.',
        'Choose mainAction from the contact channel the user mentions; prefer message when a messenger is given; use form only when the user asks for requests or applications on the site.',
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
    importHint: 'Если тексты уже готовы, вставьте их: каждый блок начните с заголовка на отдельной строке, между блоками — пустая строка.',
    playbook: {
      version: '1.0.0',
      instructions: [
        'Write for the audience from the brief, in the brief tone, in the project language.',
        'Structure: hero with the main action button first, contacts last; 4–7 sections in total.',
        'Do not invent testimonials, numbers of clients, years of experience, awards, prices or guarantees not present in the inputs.',
        'Hero text up to 2 sentences; section text up to 4 sentences; list items up to 2 sentences.',
        'Use square-bracket placeholders like [укажите ...] only when a needed fact is missing, so the owner sees what to add.',
      ],
    },
  },
  design: {
    key: 'design',
    version: '1.0.0',
    title: 'Внешний вид',
    purpose: 'Выберем цвета, шрифт и форму элементов. Посмотреть результат можно сразу в предпросмотре.',
    outcome: 'Стиль сайта: цветовая палитра, шрифт, скругления и расположение первого экрана.',
    artifactType: 'design',
    inputs: ['content'],
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
    inputs: ['content', 'design'],
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
};

export const projectTypes: Record<ProjectTypeKey, ProjectTypeDefinition> = {
  landing: {
    key: 'landing',
    title: 'Одностраничный сайт',
    description: 'Одна страница, которая рассказывает о вас и ведёт к одному действию: позвонить, написать или прийти.',
    goodFor: 'Мастерам, небольшим услугам, мероприятиям, запуску продукта.',
    examples: ['Мастер маникюра', 'Торты на заказ', 'Репетитор', 'Мероприятие'],
    stages: ['goal', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница сайта в виде файла и все тексты проекта.',
  },
  company_site: {
    key: 'company_site',
    title: 'Сайт компании',
    description: 'Подробная страница компании: услуги и цены, о вас, как работаете, контакты и часы работы.',
    goodFor: 'Небольшим компаниям, салонам, студиям, сервисам.',
    examples: ['Автосервис', 'Стоматология', 'Юридическая консультация', 'Студия йоги'],
    stages: ['goal', 'offer', 'content', 'design', 'build'],
    resultExplanation: 'Готовая страница компании в виде файла, список услуг и все тексты проекта.',
  },
};

export function projectTypeOf(key: string | null | undefined): ProjectTypeDefinition | null {
  return key && key in projectTypes ? projectTypes[key as ProjectTypeKey] : null;
}

/** Inputs of a stage limited to stages present in the given route. */
export function routeInputs(route: StageKey[], key: StageKey): StageKey[] {
  const own = stageDefinitions[key].inputs.filter((input) => route.includes(input));
  // Content of a company site also depends on the offer stage.
  if (key === 'content' && route.includes('offer')) own.push('offer');
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
