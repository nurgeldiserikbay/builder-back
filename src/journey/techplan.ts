// «Архитектура» (stage key techplan): what will be built, in plain words for the owner and precise for a developer — the
// parts of the system, the data it keeps, each scenario step by step, which steps of the business process the product
// covers, and the API contract. Derived deterministically from the accepted inputs; the owner adds only notes.
// It is a contract stage: the build relies on it.
import type { Brief, MainAction } from './artifacts.js';
import { ArtifactValidationError, stableStringify } from './artifacts.js';
import { WEEKDAYS, doable, type Schedule } from './schedule.js';
import type { BusinessProcess, Capability } from './process.js';

export const TECHPLAN_VERSION = '1.1.0';

export interface TechPlanItem { title: string; plain: string; technical: string }
export interface DataEntity { key: string; name: string; plain: string; fields: Array<{ name: string; type: string }>; links: Array<{ to: string; kind: 'one' | 'many'; label: string }> }
export interface Sequence { title: string; participants: string[]; messages: Array<{ from: number; to: number; text: string }> }
/** built — the product does it; manual — people do it outside the site, as intended; not_built — needs a developer or another project type. */
export interface CoverageStep { scenario: string; actor: string; action: string; capability: Capability; status: 'built' | 'manual' | 'not_built'; how: string }
export interface TechPlan {
  planVersion: string;
  kind: 'booking' | 'site';
  summary: string;
  /** Parts of the system and what each does. */
  components: TechPlanItem[];
  /** What the product stores, for the data diagram. */
  dataModel: DataEntity[];
  /** Main scenarios step by step between participants, for the sequence diagrams. */
  sequences: Sequence[];
  /** Steps of the accepted business process and whether the product covers them; null when the route has no process stage. */
  coverage: CoverageStep[] | null;
  features: TechPlanItem[];
  roles: TechPlanItem[];
  data: TechPlanItem[];
  pages: Array<{ path: string; title: string; plain: string }>;
  notifications: string[];
  hosting: Array<{ option: string; plain: string }>;
  limits: string[];
  /** OpenAPI 3.1 contract of the public endpoints the site implements; empty when the site has none. */
  api: string;
  /** The only part the owner writes: wishes for developers or later versions. */
  ownerNotes: string | null;
}

/** The client only sends notes; everything else is recomputed on the server from the accepted inputs. */
export function techPlanNotes(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const notes = (raw as { ownerNotes?: unknown }).ownerNotes;
  if (notes === undefined || notes === null || notes === '') return null;
  if (typeof notes !== 'string') throw new ArtifactValidationError('FIELD_INVALID:ownerNotes');
  const trimmed = notes.replace(/\u0000/g, '').trim();
  if (trimmed.length > 2000) throw new ArtifactValidationError('FIELD_TOO_LONG:ownerNotes');
  return trimmed || null;
}

export function bookingApiContract(): string {
  return `openapi: 3.1.0
info:
  title: Онлайн-запись (BuildPath)
  version: ${TECHPLAN_VERSION}
  description: 'Публичные страницы и формы записи. Одинаковы на хостинге BuildPath и в программе для своего сервера. Страницы работают без JavaScript; формы — application/x-www-form-urlencoded, только с того же адреса (заголовок Origin).'
servers:
  - url: /
security: []
paths:
  /book:
    get:
      operationId: bookingSteps
      summary: Шаги записи — услуга, мастер, день и время, подтверждение
      parameters:
        - { name: s, in: query, schema: { type: integer, minimum: 0 }, description: Номер услуги в расписании }
        - { name: m, in: query, schema: { type: string, pattern: '^(any|[a-z0-9]{2,12})$' }, description: Мастер или any }
        - { name: d, in: query, schema: { type: string, format: date }, description: День в часовом поясе расписания }
        - { name: t, in: query, schema: { type: string, format: date-time }, description: 'Начало записи (UTC) — открывает подтверждение, если время свободно' }
      responses:
        '200': { description: HTML-страница шага }
        '303': { description: 'Пропуск шага, когда выбор единственный' }
  /__forms/booking:
    post:
      operationId: createBooking
      summary: Создать запись
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [s, m, t, name, phone, consent]
              properties:
                s: { type: integer }
                m: { type: string }
                t: { type: string, format: date-time }
                name: { type: string, maxLength: 80 }
                phone: { type: string, description: '10–15 цифр, можно с + пробелами скобками и дефисами' }
                comment: { type: string, maxLength: 300 }
                consent: { type: string, enum: [yes] }
                website: { type: string, description: Ловушка для ботов — должна быть пустой }
      responses:
        '303': { description: 'Запись создана: Location /book/b/{token}?new=1' }
        '400': { description: Ошибка в форме — страница подтверждения с пояснением }
        '403': { description: Отправка не с этого сайта }
        '409': { description: Время уже заняли }
        '429': { description: 'Слишком много записей: больше 5 в час с одного адреса' }
  /book/b/{token}:
    get:
      operationId: viewBooking
      summary: Страница записи клиента (личная ссылка)
      parameters: [{ name: token, in: path, required: true, schema: { type: string, pattern: '^[A-Za-z0-9_-]{32}$' } }]
      responses:
        '200': { description: Запись и кнопка отмены до срока }
        '404': { description: Нет такой записи }
  /__forms/booking-cancel:
    post:
      operationId: cancelBooking
      summary: Отменить запись клиентом
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema: { type: object, required: [token], properties: { token: { type: string } } }
      responses:
        '303': { description: Возврат на страницу записи }
components:
  schemas:
    Booking:
      type: object
      required: [serviceName, minutes, masterName, startsAt, endsAt, clientName, clientPhone, status]
      properties:
        serviceName: { type: string }
        minutes: { type: integer }
        price: { type: [string, 'null'] }
        masterName: { type: string }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        clientName: { type: string }
        clientPhone: { type: string }
        comment: { type: [string, 'null'] }
        status: { type: string, enum: [booked, cancelled_by_client, cancelled_by_owner, done, no_show] }
`;
}

const minutes = (value: number) => (value < 60 ? `${value} мин` : `${Math.floor(value / 60)} ч${value % 60 ? ` ${value % 60} мин` : ''}`);

export function leadApiContract(): string {
  return `openapi: 3.1.0
info:
  title: Заявки с сайта (BuildPath)
  version: ${TECHPLAN_VERSION}
  description: 'Форма заявки на опубликованном сайте BuildPath. Работает без JavaScript; только с того же адреса (заголовок Origin).'
servers:
  - url: /
security: []
paths:
  /__forms/lead:
    post:
      operationId: createLead
      summary: Отправить заявку
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [name, contact, consent]
              properties:
                name: { type: string, maxLength: 80 }
                contact: { type: string, maxLength: 120, description: Телефон, мессенджер или почта }
                message: { type: string, maxLength: 1000 }
                consent: { type: string, enum: [yes] }
                website: { type: string, description: Ловушка для ботов — должна быть пустой }
      responses:
        '303': { description: 'Заявка принята: страница «Спасибо»' }
        '400': { description: HTML-страница формы с объяснением ошибки }
        '403': { description: Запрос не с адреса сайта }
        '429': { description: Слишком много заявок с одного адреса }
`;
}

/** What the product does for each step of the owner's process. */
export function coverageOf(kind: 'booking' | 'site', mainAction: MainAction | null, process: BusinessProcess): CoverageStep[] {
  const built = (how: string) => ({ status: 'built' as const, how });
  const notBuilt = (how: string) => ({ status: 'not_built' as const, how });
  const bookingOnly = (how: string) => (kind === 'booking' ? built(how) : notBuilt('Это делает тип проекта «Онлайн-запись к мастеру».'));
  const verdict = (capability: Capability): { status: CoverageStep['status']; how: string } => {
    switch (capability) {
      case 'view_info': return built('Страницы сайта.');
      case 'contact': return built('Кнопки звонка, мессенджера и письма на сайте.');
      case 'request_form': return mainAction === 'form'
        ? built('Форма заявки на сайте, опубликованном на BuildPath.')
        : notBuilt('Форма появится, если в «Цели сайта» выбрать главным действием «Оставить заявку на сайте».');
      case 'notify_owner': return kind === 'booking' || mainAction === 'form' ? built('Уведомление в Telegram и на почту.') : notBuilt('Без формы или записи уведомлять не о чем: клиент связывается с вами напрямую.');
      case 'choose_slot': return bookingOnly('Шаги записи: услуга → мастер → день и время, только свободное время.');
      case 'book': return bookingOnly('Форма записи; одно время не займут дважды.');
      case 'cancel_booking': return bookingOnly('Личная ссылка клиента на запись с кнопкой отмены.');
      case 'notify_master': return bookingOnly('Мастеру с приглашением — в Telegram или на почту.');
      case 'remind_client': return bookingOnly('Письмо клиенту перед визитом, если он оставил почту; владельцу — кнопка «Напомнить в WhatsApp».');
      case 'mark_visit': return bookingOnly('Отметка «пришёл / не пришёл» у владельца и в кабинете мастера.');
      case 'manage_schedule': return bookingOnly('Этап «Расписание и запись» и пересборка сайта.');
      case 'offline': return { status: 'manual', how: 'Делается вне сайта — так и задумано.' };
      case 'pay_online': return notBuilt('Онлайн-оплаты на сайтах BuildPath пока нет — нужен разработчик (решение «Технологии») или оплата на месте.');
      case 'account': return notBuilt('Личных кабинетов клиентов на сайтах BuildPath пока нет — нужен разработчик (решение «Технологии»).');
      default: return notBuilt('BuildPath не делает это автоматически — обсудите с разработчиком или делайте вручную.');
    }
  };
  const actorName = new Map(process.actors.map((actor) => [actor.key, actor.name]));
  return process.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({
    scenario: scenario.title, actor: actorName.get(step.actor) ?? step.actor, action: step.action, capability: step.capability, ...verdict(step.capability),
  })));
}

const field = (name: string, type: string) => ({ name, type });

export function buildTechPlan(input: { projectType: string; brief: Brief | null; schedule: Schedule | null; process: BusinessProcess | null }, ownerNotes: string | null): TechPlan {
  const { schedule } = input;
  const name = input.brief?.businessName || 'ваш бизнес';
  const mainAction = input.brief?.mainAction ?? null;
  const kind = input.projectType === 'booking' && schedule ? 'booking' : 'site';
  const coverage = input.process ? coverageOf(kind, mainAction, input.process) : null;
  const hosting = [
    { option: 'BuildPath', plain: kind === 'booking' ? 'Работает сразу после публикации; записи хранятся в BuildPath.' : 'Публикация одной кнопкой; заявки хранятся в BuildPath.' },
    { option: 'Свой сервер', plain: kind === 'booking' ? 'Пакет с программой записи (Node.js, без сторонних библиотек), Caddy и инструкцией; записи — на вашем сервере.' : 'Готовая страница и настройки веб-сервера Caddy; форма заявок там не работает.' },
    { option: 'GitHub Pages', plain: kind === 'booking' ? 'Не подходит: там нельзя принимать записи.' : 'Подходит для страницы; форма заявок там не работает.' },
  ];
  if (kind === 'site') {
    const form = mainAction === 'form';
    return {
      planVersion: TECHPLAN_VERSION, kind,
      summary: `Сайт «${name}» — одна страница без скриптов: рассказывает о вас и ведёт к главному действию${form ? ' — заявке через форму, которая приходит вам в Telegram или на почту' : ''}.`,
      components: [
        { title: 'Страница сайта', plain: 'Готовая страница из принятых текстов и стиля. Открывается быстро даже на слабом телефоне.', technical: 'Статический HTML и CSS без JavaScript, CSP без inline-скриптов; собирается платформой детерминированно.' },
        ...(form ? [{ title: 'Приём заявок', plain: 'Сервер BuildPath принимает заявки с формы и хранит их в проекте.', technical: 'POST /__forms/lead (urlencoded), проверка Origin, ловушка для ботов, лимит заявок с адреса.' }] : []),
        ...(form ? [{ title: 'Уведомления', plain: 'Новая заявка приходит вам в Telegram и/или на почту.', technical: 'Бот Telegram и почта (Resend); отправка повторяется при сбое.' }] : []),
        { title: 'Публикация', plain: 'Адрес BuildPath или свой домен, HTTPS включается сам.', technical: 'Отдельный процесс сайтов за Caddy с сертификатами по запросу.' },
      ],
      dataModel: form ? [{ key: 'lead', name: 'Заявка', plain: 'Кто и как просит связаться.', fields: [field('Имя', 'текст до 80'), field('Контакт', 'текст до 120'), field('Сообщение', 'текст до 1000'), field('Согласие', 'время'), field('Когда пришла', 'время')], links: [] }] : [],
      sequences: form ? [{ title: 'Заявка', participants: ['Посетитель', 'Сайт', 'Сервер BuildPath', 'Вы'], messages: [
        { from: 0, to: 1, text: 'Заполняет форму и даёт согласие' },
        { from: 1, to: 2, text: 'Отправляет заявку (POST /__forms/lead)' },
        { from: 2, to: 2, text: 'Проверяет адрес отправки и сохраняет' },
        { from: 2, to: 3, text: 'Уведомление в Telegram или на почту' },
        { from: 2, to: 0, text: 'Страница «Спасибо, заявка отправлена»' },
      ] }] : [{ title: 'Обращение', participants: ['Посетитель', 'Сайт', 'Вы'], messages: [
        { from: 0, to: 1, text: 'Открывает сайт и читает' },
        { from: 1, to: 0, text: 'Показывает главную кнопку' },
        { from: 0, to: 2, text: mainAction === 'call' ? 'Звонит вам' : mainAction === 'visit' ? 'Приходит по адресу' : mainAction === 'email' ? 'Пишет письмо' : 'Пишет в мессенджер' },
      ] }],
      coverage,
      features: [], roles: [], data: [],
      pages: [{ path: '/', title: 'Главная', plain: 'Ваш сайт.' }, { path: '/privacy', title: 'Данные', plain: 'Какие данные собираются, зачем и как попросить удалить.' }],
      notifications: form ? ['Вам: новая заявка — в Telegram и/или на почту (настройки публикации).'] : ['Сайт ничего не отправляет: клиент связывается с вами напрямую.'],
      hosting,
      limits: ['Одна страница; разделы и блоки — из набора BuildPath.', 'Нет онлайн-оплаты и личных кабинетов клиентов.'],
      api: form ? leadApiContract() : '',
      ownerNotes,
    };
  }
  const sched = schedule!;
  const services = sched.services.map((service) => `${service.name} (${minutes(service.minutes)})`).join(', ');
  const masters = sched.masters.map((master) => {
    const days = master.week.map((day, index) => (day ? `${WEEKDAYS[index]} ${day.from}–${day.to}` : null)).filter(Boolean).join(', ');
    return `${master.name}: ${doable(sched, master).map((service) => service.name).join(', ') || 'нет услуг'}; ${days || 'нет рабочих дней'}`;
  });
  const rules = sched.rules;
  return {
    planVersion: TECHPLAN_VERSION, kind,
    summary: `Сайт «${name}» с онлайн-записью: клиент выбирает услугу, мастера и свободное время, оставляет имя и телефон и получает личную ссылку на запись. Вы и мастер получаете уведомление и видите записи в BuildPath.`,
    components: [
      { title: 'Сайт и шаги записи', plain: 'Страницы без скриптов: услуга → мастер → день и время → контакты.', technical: 'Статический HTML/CSS + серверные страницы /book; формы urlencoded, проверка Origin.' },
      { title: 'Сервер записи', plain: 'Считает свободное время и не даёт занять одно время дважды.', technical: 'BuildPath: PostgreSQL, advisory-lock на сайт и пересчёт слотов в транзакции. Свой сервер: один процесс Node.js и JSON-хранилище с очередью записи.' },
      { title: 'Записи для владельца и мастеров', plain: 'Владелец видит все записи, мастер — только свои; отмечают, пришёл ли клиент.', technical: 'BuildPath: страницы записей и кабинет мастера по приглашению. Свой сервер: /admin под паролем.' },
      { title: 'Уведомления и напоминания', plain: 'Новые записи и отмены — вам и мастеру; клиенту — письмо перед визитом, если он оставил почту.', technical: 'Telegram-бот и почта (Resend); напоминания отправляет процесс сайтов раз в 5 минут, каждая запись захватывается перед отправкой.' },
    ],
    dataModel: [
      { key: 'booking', name: 'Запись', plain: 'Кто, к кому и когда записался.', fields: [field('Услуга', 'из расписания'), field('Мастер', 'из расписания'), field('Начало и конец', 'время, UTC'), field('Имя', 'текст до 80'), field('Телефон', 'текст'), field('Комментарий', 'текст до 300'), field('Почта для напоминания', 'удаляется после напоминания'), field('Статус', 'записан · отменена · пришёл · не пришёл')], links: [{ to: 'service', kind: 'one', label: 'услуга' }, { to: 'master', kind: 'one', label: 'мастер' }] },
      { key: 'service', name: 'Услуга', plain: `Из расписания: ${services}.`, fields: [field('Название', 'текст'), field('Длительность', 'минуты'), field('Цена', 'текст')], links: [] },
      { key: 'master', name: 'Мастер', plain: masters.join('. '), fields: [field('Имя', 'текст'), field('Рабочие дни и часы', 'по дням недели'), field('Услуги', 'список')], links: [{ to: 'service', kind: 'many', label: 'делает' }] },
      { key: 'access', name: 'Доступ мастера', plain: 'Приглашение мастеру видеть свои записи.', fields: [field('Почта', 'текст'), field('Статус', 'приглашён · подключён · закрыт')], links: [{ to: 'master', kind: 'one', label: 'для мастера' }] },
    ],
    sequences: [
      { title: 'Запись', participants: ['Клиент', 'Сайт', 'Сервер BuildPath', 'Мастер и вы'], messages: [
        { from: 0, to: 1, text: 'Выбирает услугу и мастера' },
        { from: 1, to: 2, text: 'Запрашивает свободное время (GET /book)' },
        { from: 2, to: 1, text: `Свободные варианты, шаг ${rules.slotStep} мин` },
        { from: 0, to: 1, text: 'Выбирает время, оставляет имя и телефон' },
        { from: 1, to: 2, text: 'Создаёт запись (POST /__forms/booking)' },
        { from: 2, to: 2, text: 'Проверяет, что время всё ещё свободно' },
        { from: 2, to: 3, text: 'Уведомление о новой записи' },
        { from: 2, to: 0, text: 'Личная ссылка на запись' },
        { from: 2, to: 0, text: 'Напоминание на почту перед визитом' },
      ] },
      { title: 'Отмена', participants: ['Клиент', 'Сайт', 'Сервер BuildPath', 'Мастер и вы'], messages: [
        { from: 0, to: 1, text: `Открывает свою ссылку не позже чем за ${rules.cancelHours} ч` },
        { from: 1, to: 2, text: 'Отменяет запись (POST /__forms/booking-cancel)' },
        { from: 2, to: 2, text: 'Освобождает время' },
        { from: 2, to: 3, text: 'Уведомление об отмене' },
      ] },
    ],
    coverage,
    features: [
      { title: 'Свободное время', plain: `Клиент видит только то время, когда мастер работает и свободен на всю длительность услуги. Варианты начала — каждые ${rules.slotStep} мин, не раньше чем через ${rules.minNoticeHours} ч и не дальше ${rules.horizonDays} дн.`,
        technical: `Слоты считаются на сервере из расписания (часовой пояс ${sched.timezone}) и активных записей; пересечения по мастеру исключаются.` },
      { title: 'Запись без двойного бронирования', plain: 'Если два человека выбрали одно время, запишется только первый, второму предложим другое.',
        technical: 'BuildPath: advisory-lock на сайт в транзакции PostgreSQL с пересчётом слотов. Свой сервер: одна очередь записи в одном процессе.' },
      { title: '«Любой свободный мастер»', plain: 'Клиент может не выбирать мастера — запишем к тому, у кого в этот день меньше записей.', technical: 'Выбор мастера с наименьшим числом активных записей за день среди свободных.' },
      { title: 'Отмена клиентом', plain: `По личной ссылке клиент может отменить запись не позже чем за ${rules.cancelHours} ч.`, technical: 'В ссылке случайный токен 192 бит; хранится только его SHA-256.' },
    ],
    roles: [
      { title: 'Клиент', plain: 'Записывается и отменяет свою запись. Аккаунт не нужен.', technical: 'Без входа; согласие на обработку данных обязательно; лимит 5 записей в час с одного адреса.' },
      { title: 'Вы (владелец)', plain: 'Меняете расписание, видите все записи и приглашаете мастеров.', technical: 'Владелец и менеджеры проекта; на своём сервере — пароль ADMIN_PASSWORD.' },
      { title: 'Мастера', plain: `Видят только свои записи и отмечают визиты. Мастера: ${sched.masters.map((master) => master.name).join(', ')}.`, technical: 'Приглашение по почте на 7 дней, только для этого адреса; не участники проекта.' },
    ],
    data: [
      { title: 'Хранение', plain: 'Записи удаляются автоматически через 12 месяцев после визита; почта клиента — сразу после напоминания.', technical: 'Срок LEAD_RETENTION_DAYS (по умолчанию 365); IP хранится только как солёный хэш.' },
    ],
    pages: [
      { path: '/', title: 'Главная', plain: 'Ваш сайт с разделом «Онлайн-запись» и кнопками записи.' },
      { path: '/book', title: 'Запись', plain: 'Шаги: услуга → мастер → день и время → контакты.' },
      { path: '/book/b/…', title: 'Моя запись', plain: 'Личная страница клиента с отменой.' },
      { path: '/privacy', title: 'Данные', plain: 'Какие данные собираются, зачем и как попросить удалить.' },
    ],
    notifications: ['Вам и мастеру: новая запись и отмена — в Telegram или на почту.', 'Клиенту: подтверждение на экране, личная ссылка и письмо-напоминание, если он оставил почту. SMS не отправляются.'],
    hosting,
    limits: ['Рабочие часы задаются по дням недели: перерывов и выходных на конкретные даты пока нет.', 'Нет предоплаты и онлайн-оплаты.', 'На своём сервере нет напоминаний и кабинетов мастеров.'],
    api: bookingApiContract(),
    ownerNotes,
  };
}

/** A stored plan is checked for shape only; its content is always produced by buildTechPlan. */
export function normalizeTechPlan(raw: unknown): TechPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const plan = raw as TechPlan;
  if (typeof plan.summary !== 'string' || typeof plan.api !== 'string' || !Array.isArray(plan.features)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  // Plans made before the architecture view (1.0.0) have no diagrams; they read as empty until the plan is updated.
  if (!Array.isArray(plan.components)) return { ...plan, kind: 'booking', components: [], dataModel: [], sequences: [], coverage: null, ownerNotes: techPlanNotes(raw) };
  return { ...plan, ownerNotes: techPlanNotes(raw) };
}

export function techPlanMarkdown(plan: TechPlan): string {
  const items = (list: TechPlanItem[]) => list.flatMap((item) => [`- **${item.title}.** ${item.plain}`, `  - Технически: ${item.technical}`]);
  return [
    '# Архитектура', '', plan.summary, '',
    ...(plan.components?.length ? ['## Из чего состоит', '', ...items(plan.components), ''] : []),
    ...(plan.dataModel?.length ? ['## Данные', '', ...plan.dataModel.flatMap((entity) => [`- **${entity.name}.** ${entity.plain}`, ...entity.fields.map((item) => `  - ${item.name}: ${item.type}`)]), ''] : []),
    ...(plan.sequences ?? []).flatMap((sequence) => [`## Сценарий: ${sequence.title}`, '', ...sequence.messages.map((message, index) => `${index + 1}. ${sequence.participants[message.from]} → ${sequence.participants[message.to]}: ${message.text}`), '']),
    ...(plan.coverage?.length ? ['## Что из процесса делает сайт', '', ...plan.coverage.map((step) => `- ${step.status === 'built' ? '✓' : step.status === 'manual' ? '·' : '✗'} ${step.scenario} — ${step.actor}: ${step.action}. ${step.how}`), ''] : []),
    ...(plan.features.length ? ['## Что умеет', '', ...items(plan.features), ''] : []),
    ...(plan.roles.length ? ['## Кто пользуется', '', ...items(plan.roles), ''] : []),
    ...(plan.data.length ? ['## Хранение', '', ...items(plan.data), ''] : []),
    '## Страницы', '', ...plan.pages.map((item) => `- \`${item.path}\` — ${item.title}: ${item.plain}`), '',
    '## Уведомления', '', ...plan.notifications.map((item) => `- ${item}`), '',
    '## Где работает', '', ...plan.hosting.map((item) => `- ${item.option}: ${item.plain}`), '',
    '## Ограничения этой версии', '', ...plan.limits.map((item) => `- ${item}`), '',
    ...(plan.ownerNotes ? ['## Заметки владельца', '', plan.ownerNotes, ''] : []),
    plan.api ? `Контракт API — в файле ${plan.kind === 'site' ? 'lead-api.yaml' : 'booking-api.yaml'}. Версия: ${plan.planVersion}.` : `Версия: ${plan.planVersion}.`, '',
  ].join('\n');
}

/** Same plan apart from the owner's notes (used to tell whether the plan follows the accepted inputs). */
export function sameTechPlan(a: TechPlan, b: TechPlan): boolean {
  const strip = ({ ownerNotes: _notes, ...rest }: TechPlan) => stableStringify(rest);
  return strip(a) === strip(b);
}
