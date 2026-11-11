// «Архитектура» (stage key techplan): what will be built, in plain words for the owner and precise for a developer — the
// parts of the system, the data it keeps, each scenario step by step, which steps of the business process the product
// covers, and the API contract. Derived deterministically from the accepted inputs; the owner adds only notes.
// It is a contract stage: the build relies on it.
import { tr } from '../i18n/i18n.js';
import type { Brief, MainAction } from './artifacts.js';
import { ArtifactValidationError, stableStringify } from './artifacts.js';
import { doable, weekdayShort, type Schedule } from './schedule.js';
import type { Sitemap } from './sitemap.js';
import { tenge, type Catalog } from './products.js';
import type { BusinessProcess, Capability } from './process.js';

export const TECHPLAN_VERSION = '1.1.0';

export interface TechPlanItem { title: string; plain: string; technical: string }
export interface DataEntity { key: string; name: string; plain: string; fields: Array<{ name: string; type: string }>; links: Array<{ to: string; kind: 'one' | 'many'; label: string }> }
export interface Sequence { title: string; participants: string[]; messages: Array<{ from: number; to: number; text: string }> }
/** built — the product does it; manual — people do it outside the site, as intended; not_built — needs a developer or another project type. */
export interface CoverageStep { scenario: string; actor: string; action: string; capability: Capability; status: 'built' | 'manual' | 'not_built'; how: string }
export interface TechPlan {
  planVersion: string;
  kind: 'booking' | 'site' | 'store';
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

/** Descriptions inside the API contracts, written in the current language (longest first so shorter ones never split a longer one). */
const contractTexts = (): Array<[string, string]> => ([
  ["Публичные страницы и формы записи. Одинаковы на хостинге BuildPath и в программе для своего сервера. Страницы работают без JavaScript; формы — application/x-www-form-urlencoded, только с того же адреса (заголовок Origin).", tr("Публичные страницы и формы записи. Одинаковы на хостинге BuildPath и в программе для своего сервера. Страницы работают без JavaScript; формы — application/x-www-form-urlencoded, только с того же адреса (заголовок Origin).")],
  ["Форма заявки на опубликованном сайте BuildPath. Работает без JavaScript; только с того же адреса (заголовок Origin).", tr("Форма заявки на опубликованном сайте BuildPath. Работает без JavaScript; только с того же адреса (заголовок Origin).")],
  ["Начало записи (UTC) — открывает подтверждение, если время свободно", tr("Начало записи (UTC) — открывает подтверждение, если время свободно")],
  ["Шаги записи — услуга, мастер, день и время, подтверждение", tr("Шаги записи — услуга, мастер, день и время, подтверждение")],
  ["Слишком много записей: больше 5 в час с одного адреса", tr("Слишком много записей: больше 5 в час с одного адреса")],
  ["Ошибка в форме — страница подтверждения с пояснением", tr("Ошибка в форме — страница подтверждения с пояснением")],
  ["10–15 цифр, можно с + пробелами скобками и дефисами", tr("10–15 цифр, можно с + пробелами скобками и дефисами")],
  ["Запись создана: Location /book/b/{token}?new=1", tr("Запись создана: Location /book/b/{token}?new=1")],
  ["HTML-страница формы с объяснением ошибки", tr("HTML-страница формы с объяснением ошибки")],
  ["Страница записи клиента (личная ссылка)", tr("Страница записи клиента (личная ссылка)")],
  ["Пропуск шага, когда выбор единственный", tr("Пропуск шага, когда выбор единственный")],
  ["Ловушка для ботов — должна быть пустой", tr("Ловушка для ботов — должна быть пустой")],
  ["Слишком много заявок с одного адреса", tr("Слишком много заявок с одного адреса")],
  ["Заявка принята: страница «Спасибо»", tr("Заявка принята: страница «Спасибо»")],
  ["День в часовом поясе расписания", tr("День в часовом поясе расписания")],
  ["Запись и кнопка отмены до срока", tr("Запись и кнопка отмены до срока")],
  ["Телефон, мессенджер или почта", tr("Телефон, мессенджер или почта")],
  ["Возврат на страницу записи", tr("Возврат на страницу записи")],
  ["Заявки с сайта (BuildPath)", tr("Заявки с сайта (BuildPath)")],
  ["Онлайн-запись (BuildPath)", tr("Онлайн-запись (BuildPath)")],
  ["Номер услуги в расписании", tr("Номер услуги в расписании")],
  ["Отправка не с этого сайта", tr("Отправка не с этого сайта")],
  ["Отменить запись клиентом", tr("Отменить запись клиентом")],
  ["Запрос не с адреса сайта", tr("Запрос не с адреса сайта")],
  ["HTML-страница шага", tr("HTML-страница шага")],
  ["Время уже заняли", tr("Время уже заняли")],
  ["Нет такой записи", tr("Нет такой записи")],
  ["Отправить заявку", tr("Отправить заявку")],
  ["Мастер или any", tr("Мастер или any")],
  ["Создать запись", tr("Создать запись")],
] as Array<[string, string]>);
const inContractLanguage = (yaml: string): string => contractTexts().reduce((text, [ru, local]) => text.split(ru).join(local), yaml);

export function bookingApiContract(): string {
  return inContractLanguage(`openapi: 3.1.0
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
`);
}

const minutes = (value: number) => (value < 60 ? tr("{0} мин", [value]) : tr("{0} ч{1}", [Math.floor(value / 60), value % 60 ? tr(" {0} мин", [value % 60]) : '']));

export function leadApiContract(): string {
  return inContractLanguage(`openapi: 3.1.0
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
                contact: { type: string, maxLength: 120, description: 'Телефон, мессенджер или почта' }
                message: { type: string, maxLength: 1000 }
                consent: { type: string, enum: [yes] }
                website: { type: string, description: Ловушка для ботов — должна быть пустой }
      responses:
        '303': { description: 'Заявка принята: страница «Спасибо»' }
        '400': { description: HTML-страница формы с объяснением ошибки }
        '403': { description: Запрос не с адреса сайта }
        '429': { description: Слишком много заявок с одного адреса }
`);
}

/** What the product does for each step of the owner's process. */
export function coverageOf(kind: 'booking' | 'site' | 'store', mainAction: MainAction | null, process: BusinessProcess): CoverageStep[] {
  const built = (how: string) => ({ status: 'built' as const, how });
  const notBuilt = (how: string) => ({ status: 'not_built' as const, how });
  const bookingOnly = (how: string) => (kind === 'booking' ? built(how) : notBuilt(tr("Это делает тип проекта «Онлайн-запись к мастеру».")));
  const storeOnly = (how: string) => (kind === 'store' ? built(how) : notBuilt(tr("Это делает тип проекта «Небольшой интернет-магазин».")));
  const verdict = (capability: Capability): { status: CoverageStep['status']; how: string } => {
    switch (capability) {
      case 'choose_products': return storeOnly(tr("Каталог на сайте и корзина без регистрации."));
      case 'order': return storeOnly(tr("Форма заказа: способ получения, оплата при получении или переводом."));
      case 'cancel_order': return storeOnly(tr("Личная ссылка клиента на заказ с кнопкой отмены, пока заказ не подтверждён."));
      case 'manage_orders': return storeOnly(tr("Страница «Заказы» в проекте: подтвердить, выполнить, отменить."));
      case 'view_info': return built(tr("Страницы сайта."));
      case 'contact': return built(tr("Кнопки звонка, мессенджера и письма на сайте."));
      case 'request_form': return mainAction === 'form'
        ? built(tr("Форма заявки на сайте, опубликованном на BuildPath."))
        : notBuilt(tr("Форма появится, если в «Цели сайта» выбрать главным действием «Оставить заявку на сайте»."));
      case 'notify_owner': return kind !== 'site' || mainAction === 'form' ? built(tr("Уведомление в Telegram и на почту.")) : notBuilt(tr("Без формы или записи уведомлять не о чем: клиент связывается с вами напрямую."));
      case 'choose_slot': return bookingOnly(tr("Шаги записи: услуга → мастер → день и время, только свободное время."));
      case 'book': return bookingOnly(tr("Форма записи; одно время не займут дважды."));
      case 'cancel_booking': return bookingOnly(tr("Личная ссылка клиента на запись с кнопкой отмены."));
      case 'notify_master': return bookingOnly(tr("Мастеру с приглашением — в Telegram или на почту."));
      case 'remind_client': return bookingOnly(tr("Письмо клиенту перед визитом, если он оставил почту; владельцу — кнопка «Напомнить в WhatsApp»."));
      case 'mark_visit': return bookingOnly(tr("Отметка «пришёл / не пришёл» у владельца и в кабинете мастера."));
      case 'manage_schedule': return bookingOnly(tr("Этап «Расписание и запись» и пересборка сайта."));
      case 'offline': return { status: 'manual', how: tr("Делается вне сайта — так и задумано.") };
      case 'pay_online': return notBuilt(tr("Онлайн-оплаты на сайтах BuildPath пока нет — нужен разработчик (решение «Технологии») или оплата на месте."));
      case 'account': return notBuilt(tr("Личных кабинетов клиентов на сайтах BuildPath пока нет — нужен разработчик (решение «Технологии»)."));
      default: return notBuilt(tr("BuildPath не делает это автоматически — обсудите с разработчиком или делайте вручную."));
    }
  };
  const actorName = new Map(process.actors.map((actor) => [actor.key, actor.name]));
  return process.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({
    scenario: scenario.title, actor: actorName.get(step.actor) ?? step.actor, action: step.action, capability: step.capability, ...verdict(step.capability),
  })));
}

const field = (name: string, type: string) => ({ name, type });

export function buildTechPlan(input: { projectType: string; brief: Brief | null; schedule: Schedule | null; process: BusinessProcess | null; sitemap?: Sitemap | null; store?: Catalog | null }, ownerNotes: string | null): TechPlan {
  const { schedule } = input;
  const name = input.brief?.businessName || tr("ваш бизнес");
  const mainAction = input.brief?.mainAction ?? null;
  const kind = input.projectType === 'booking' && schedule ? 'booking' : input.projectType === 'store' && input.store ? 'store' : 'site';
  const coverage = input.process ? coverageOf(kind, mainAction, input.process) : null;
  const hosting = [
    { option: 'BuildPath', plain: kind === 'booking' ? tr("Работает сразу после публикации; записи хранятся в BuildPath.") : tr("Публикация одной кнопкой; заявки хранятся в BuildPath.") },
    { option: tr("Свой сервер"), plain: kind === 'booking' ? tr("Пакет с программой записи (Node.js, без сторонних библиотек), Caddy и инструкцией; записи — на вашем сервере.") : tr("Готовая страница и настройки веб-сервера Caddy; форма заявок там не работает.") },
    { option: 'GitHub Pages', plain: kind === 'booking' ? tr("Не подходит: там нельзя принимать записи.") : tr("Подходит для страницы; форма заявок там не работает.") },
  ];
  if (kind === 'site') {
    const form = mainAction === 'form';
    const map = input.sitemap ?? null;
    const formTail = form ? tr(" — заявке через форму, которая приходит вам в Telegram или на почту") : '';
    return {
      planVersion: TECHPLAN_VERSION, kind,
      summary: map
        ? tr("Сайт «{0}» из {1} страниц с общим меню, без скриптов: рассказывает о вас и ведёт к главному действию{2}.", [name, map.pages.length, formTail])
        : tr("Сайт «{0}» — одна страница без скриптов: рассказывает о вас и ведёт к главному действию{1}.", [name, formTail]),
      components: [
        map
          ? { title: tr("Страницы и меню"), plain: tr("Страница на каждую строку карты сайта и одинаковое меню на всех страницах. Открываются быстро даже на слабом телефоне."), technical: tr("Статические HTML и CSS без JavaScript, по файлу на страницу; адреса из карты сайта; CSP без inline-скриптов; собирается платформой детерминированно.") }
          : { title: tr("Страница сайта"), plain: tr("Готовая страница из принятых текстов и стиля. Открывается быстро даже на слабом телефоне."), technical: tr("Статический HTML и CSS без JavaScript, CSP без inline-скриптов; собирается платформой детерминированно.") },
        ...(form ? [{ title: tr("Приём заявок"), plain: tr("Сервер BuildPath принимает заявки с формы и хранит их в проекте."), technical: tr("POST /__forms/lead (urlencoded), проверка Origin, ловушка для ботов, лимит заявок с адреса.") }] : []),
        ...(form ? [{ title: tr("Уведомления"), plain: tr("Новая заявка приходит вам в Telegram и/или на почту."), technical: tr("Бот Telegram и почта (Resend); отправка повторяется при сбое.") }] : []),
        { title: tr("Публикация"), plain: tr("Адрес BuildPath или свой домен, HTTPS включается сам."), technical: tr("Отдельный процесс сайтов за Caddy с сертификатами по запросу.") },
      ],
      dataModel: form ? [{ key: 'lead', name: tr("Заявка"), plain: tr("Кто и как просит связаться."), fields: [field(tr("Имя"), tr("текст до 80")), field(tr("Контакт"), tr("текст до 120")), field(tr("Сообщение"), tr("текст до 1000")), field(tr("Согласие"), tr("время")), field(tr("Когда пришла"), tr("время"))], links: [] }] : [],
      sequences: form ? [{ title: tr("Заявка"), participants: [tr("Посетитель"), tr("Сайт"), tr("Сервер BuildPath"), tr("Вы")], messages: [
        { from: 0, to: 1, text: tr("Заполняет форму и даёт согласие") },
        { from: 1, to: 2, text: tr("Отправляет заявку (POST /__forms/lead)") },
        { from: 2, to: 2, text: tr("Проверяет адрес отправки и сохраняет") },
        { from: 2, to: 3, text: tr("Уведомление в Telegram или на почту") },
        { from: 2, to: 0, text: tr("Страница «Спасибо, заявка отправлена»") },
      ] }] : [{ title: tr("Обращение"), participants: [tr("Посетитель"), tr("Сайт"), tr("Вы")], messages: [
        { from: 0, to: 1, text: tr("Открывает сайт и читает") },
        { from: 1, to: 0, text: tr("Показывает главную кнопку") },
        { from: 0, to: 2, text: mainAction === 'call' ? tr("Звонит вам") : mainAction === 'visit' ? tr("Приходит по адресу") : mainAction === 'email' ? tr("Пишет письмо") : tr("Пишет в мессенджер") },
      ] }],
      coverage,
      features: [], roles: [], data: [],
      pages: [
        ...(map ? map.pages.map((page) => ({ path: page.path, title: page.title, plain: page.purpose || tr("Страница сайта.") })) : [{ path: '/', title: tr("Главная"), plain: tr("Ваш сайт.") }]),
        { path: '/privacy', title: tr("Данные"), plain: tr("Какие данные собираются, зачем и как попросить удалить.") },
        ...(map ? [{ path: '/sitemap.xml', title: tr("Карта для поисковиков"), plain: tr("Список всех страниц, чтобы поисковики нашли каждую.") }] : []),
      ],
      notifications: form ? [tr("Вам: новая заявка — в Telegram и/или на почту (настройки публикации).")] : [tr("Сайт ничего не отправляет: клиент связывается с вами напрямую.")],
      hosting,
      limits: [map ? tr("До 7 страниц; разделы и блоки — из набора BuildPath; блога и каталога товаров нет.") : tr("Одна страница; разделы и блоки — из набора BuildPath."), tr("Нет онлайн-оплаты и личных кабинетов клиентов.")],
      api: form ? leadApiContract() : '',
      ownerNotes,
    };
  }
  if (kind === 'store') return storePlan(input.store!, name, coverage, ownerNotes);
  const sched = schedule!;
  const services = sched.services.map((service) => `${service.name} (${minutes(service.minutes)})`).join(', ');
  const masters = sched.masters.map((master) => {
    const days = master.week.map((day, index) => (day ? `${weekdayShort(index)} ${day.from}–${day.to}` : null)).filter(Boolean).join(', ');
    return `${master.name}: ${doable(sched, master).map((service) => service.name).join(', ') || tr("нет услуг")}; ${days || tr("нет рабочих дней")}`;
  });
  const rules = sched.rules;
  return {
    planVersion: TECHPLAN_VERSION, kind,
    summary: tr("Сайт «{0}» с онлайн-записью: клиент выбирает услугу, мастера и свободное время, оставляет имя и телефон и получает личную ссылку на запись. Вы и мастер получаете уведомление и видите записи в BuildPath.", [name]),
    components: [
      { title: tr("Сайт и шаги записи"), plain: tr("Страницы без скриптов: услуга → мастер → день и время → контакты."), technical: tr("Статический HTML/CSS + серверные страницы /book; формы urlencoded, проверка Origin.") },
      { title: tr("Сервер записи"), plain: tr("Считает свободное время и не даёт занять одно время дважды."), technical: tr("BuildPath: PostgreSQL, advisory-lock на сайт и пересчёт слотов в транзакции. Свой сервер: один процесс Node.js и JSON-хранилище с очередью записи.") },
      { title: tr("Записи для владельца и мастеров"), plain: tr("Владелец видит все записи, мастер — только свои; отмечают, пришёл ли клиент."), technical: tr("BuildPath: страницы записей и кабинет мастера по приглашению. Свой сервер: /admin под паролем.") },
      { title: tr("Уведомления и напоминания"), plain: tr("Новые записи и отмены — вам и мастеру; клиенту — письмо перед визитом, если он оставил почту."), technical: tr("Telegram-бот и почта (Resend); напоминания отправляет процесс сайтов раз в 5 минут, каждая запись захватывается перед отправкой.") },
    ],
    dataModel: [
      { key: 'booking', name: tr("Запись"), plain: tr("Кто, к кому и когда записался."), fields: [field(tr("Услуга"), tr("из расписания")), field(tr("Мастер"), tr("из расписания")), field(tr("Начало и конец"), tr("время, UTC")), field(tr("Имя"), tr("текст до 80")), field(tr("Телефон"), tr("текст")), field(tr("Комментарий"), tr("текст до 300")), field(tr("Почта для напоминания"), tr("удаляется после напоминания")), field(tr("Статус"), tr("записан · отменена · пришёл · не пришёл"))], links: [{ to: 'service', kind: 'one', label: tr("услуга") }, { to: 'master', kind: 'one', label: tr("мастер") }] },
      { key: 'service', name: tr("Услуга"), plain: tr("Из расписания: {0}.", [services]), fields: [field(tr("Название"), tr("текст")), field(tr("Длительность"), tr("минуты")), field(tr("Цена"), tr("текст"))], links: [] },
      { key: 'master', name: tr("Мастер"), plain: masters.join('. '), fields: [field(tr("Имя"), tr("текст")), field(tr("Рабочие дни и часы"), tr("по дням недели")), field(tr("Услуги"), tr("список"))], links: [{ to: 'service', kind: 'many', label: tr("делает") }] },
      { key: 'access', name: tr("Доступ мастера"), plain: tr("Приглашение мастеру видеть свои записи."), fields: [field(tr("Почта"), tr("текст")), field(tr("Статус"), tr("приглашён · подключён · закрыт"))], links: [{ to: 'master', kind: 'one', label: tr("для мастера") }] },
    ],
    sequences: [
      { title: tr("Запись"), participants: [tr("Клиент"), tr("Сайт"), tr("Сервер BuildPath"), tr("Мастер и вы")], messages: [
        { from: 0, to: 1, text: tr("Выбирает услугу и мастера") },
        { from: 1, to: 2, text: tr("Запрашивает свободное время (GET /book)") },
        { from: 2, to: 1, text: tr("Свободные варианты, шаг {0} мин", [rules.slotStep]) },
        { from: 0, to: 1, text: tr("Выбирает время, оставляет имя и телефон") },
        { from: 1, to: 2, text: tr("Создаёт запись (POST /__forms/booking)") },
        { from: 2, to: 2, text: tr("Проверяет, что время всё ещё свободно") },
        { from: 2, to: 3, text: tr("Уведомление о новой записи") },
        { from: 2, to: 0, text: tr("Личная ссылка на запись") },
        { from: 2, to: 0, text: tr("Напоминание на почту перед визитом") },
      ] },
      { title: tr("Отмена"), participants: [tr("Клиент"), tr("Сайт"), tr("Сервер BuildPath"), tr("Мастер и вы")], messages: [
        { from: 0, to: 1, text: tr("Открывает свою ссылку не позже чем за {0} ч", [rules.cancelHours]) },
        { from: 1, to: 2, text: tr("Отменяет запись (POST /__forms/booking-cancel)") },
        { from: 2, to: 2, text: tr("Освобождает время") },
        { from: 2, to: 3, text: tr("Уведомление об отмене") },
      ] },
    ],
    coverage,
    features: [
      { title: tr("Свободное время"), plain: tr("Клиент видит только то время, когда мастер работает и свободен на всю длительность услуги. Варианты начала — каждые {0} мин, не раньше чем через {1} ч и не дальше {2} дн.", [rules.slotStep, rules.minNoticeHours, rules.horizonDays]),
        technical: tr("Слоты считаются на сервере из расписания (часовой пояс {0}) и активных записей; пересечения по мастеру исключаются.", [sched.timezone]) },
      { title: tr("Запись без двойного бронирования"), plain: tr("Если два человека выбрали одно время, запишется только первый, второму предложим другое."),
        technical: tr("BuildPath: advisory-lock на сайт в транзакции PostgreSQL с пересчётом слотов. Свой сервер: одна очередь записи в одном процессе.") },
      { title: tr("«Любой свободный мастер»"), plain: tr("Клиент может не выбирать мастера — запишем к тому, у кого в этот день меньше записей."), technical: tr("Выбор мастера с наименьшим числом активных записей за день среди свободных.") },
      { title: tr("Отмена клиентом"), plain: tr("По личной ссылке клиент может отменить запись не позже чем за {0} ч.", [rules.cancelHours]), technical: tr("В ссылке случайный токен 192 бит; хранится только его SHA-256.") },
    ],
    roles: [
      { title: tr("Клиент"), plain: tr("Записывается и отменяет свою запись. Аккаунт не нужен."), technical: tr("Без входа; согласие на обработку данных обязательно; лимит 5 записей в час с одного адреса.") },
      { title: tr("Вы (владелец)"), plain: tr("Меняете расписание, видите все записи и приглашаете мастеров."), technical: tr("Владелец и менеджеры проекта; на своём сервере — пароль ADMIN_PASSWORD.") },
      { title: tr("Мастера"), plain: tr("Видят только свои записи и отмечают визиты. Мастера: {0}.", [sched.masters.map((master) => master.name).join(', ')]), technical: tr("Приглашение по почте на 7 дней, только для этого адреса; не участники проекта.") },
    ],
    data: [
      { title: tr("Хранение"), plain: tr("Записи удаляются автоматически через 12 месяцев после визита; почта клиента — сразу после напоминания."), technical: tr("Срок LEAD_RETENTION_DAYS (по умолчанию 365); IP хранится только как солёный хэш.") },
    ],
    pages: [
      { path: '/', title: tr("Главная"), plain: tr("Ваш сайт с разделом «Онлайн-запись» и кнопками записи.") },
      { path: '/book', title: tr("Запись"), plain: tr("Шаги: услуга → мастер → день и время → контакты.") },
      { path: '/book/b/…', title: tr("Моя запись"), plain: tr("Личная страница клиента с отменой.") },
      { path: '/privacy', title: tr("Данные"), plain: tr("Какие данные собираются, зачем и как попросить удалить.") },
    ],
    notifications: [tr("Вам и мастеру: новая запись и отмена — в Telegram или на почту."), tr("Клиенту: подтверждение на экране, личная ссылка и письмо-напоминание, если он оставил почту. SMS не отправляются.")],
    hosting,
    limits: [tr("Рабочие часы задаются по дням недели: перерывов и выходных на конкретные даты пока нет."), tr("Нет предоплаты и онлайн-оплаты."), tr("На своём сервере нет напоминаний и кабинетов мастеров.")],
    api: bookingApiContract(),
    ownerNotes,
  };
}

function storePlan(store: Catalog, name: string, coverage: CoverageStep[] | null, ownerNotes: string | null): TechPlan {
  const inStock = store.products.filter((product) => product.available && product.price > 0);
  const pay = [store.payment.onDelivery ? tr('при получении') : '', store.payment.transfer ? tr('переводом') : ''].filter(Boolean).join(tr(' или '));
  return {
    planVersion: TECHPLAN_VERSION, kind: 'store',
    summary: tr('Магазин «{0}»: витрина с товарами, корзина и заказ без регистрации и без скриптов. Клиент выбирает способ получения и оплату ({1}), вы получаете заказ в Telegram или на почту и ведёте его на странице «Заказы».', [name, pay || tr('не выбрана')]),
    components: [
      { title: tr('Витрина и корзина'), plain: tr('Каталог на главной странице; корзина хранится в адресе страницы, поэтому не нужны ни регистрация, ни cookies.'), technical: tr('Статический HTML/CSS; /cart?i=товар:количество считается на сервере по принятому каталогу; без JavaScript.') },
      { title: tr('Приём заказов'), plain: tr('Цены берутся из принятого каталога, а не из формы; у заказа свой номер.'), technical: tr('POST /__forms/order (urlencoded), проверка Origin, ловушка для ботов, лимит 5 заказов в час с адреса; номер по порядку под advisory-lock проекта.') },
      { title: tr('Заказы для владельца'), plain: tr('Новые и подтверждённые заказы, звонок клиенту одной кнопкой, статусы «подтверждён», «выполнен», «отменён».'), technical: tr('Страница «Заказы» в BuildPath; переходы статусов проверяются на сервере.') },
      { title: tr('Уведомления'), plain: tr('Новый заказ и отмена клиентом — вам в Telegram и/или на почту.'), technical: tr('Бот Telegram и почта (Resend), на языке вашего аккаунта.') },
    ],
    dataModel: [
      { key: 'order', name: tr('Заказ'), plain: tr('Кто, что и как заказал.'), fields: [field(tr('Номер'), tr('по порядку')), field(tr('Товары'), tr('название, цена, количество — копия на момент заказа')), field(tr('Получение'), tr('способ и цена доставки')), field(tr('Оплата'), tr('при получении · переводом')), field(tr('Имя и телефон'), tr('текст')), field(tr('Адрес'), tr('если доставка')), field(tr('Статус'), tr('новый · подтверждён · выполнен · отменён'))], links: [{ to: 'product', kind: 'many', label: tr('товары') }] },
      { key: 'product', name: tr('Товар'), plain: tr('В каталоге: {0} в наличии из {1}.', [inStock.length, store.products.length]), fields: [field(tr('Название'), tr('текст до 80')), field(tr('Цена'), tr('целые тенге')), field(tr('В наличии'), tr('да · нет')), field(tr('Фото'), tr('из библиотеки проекта'))], links: [] },
      { key: 'delivery', name: tr('Способ получения'), plain: store.delivery.map((option) => `${option.title} — ${option.price ? tenge(option.price) : tr('бесплатно')}`).join('; '), fields: [field(tr('Название'), tr('текст')), field(tr('Цена'), tr('целые тенге')), field(tr('Нужен адрес'), tr('да · нет'))], links: [] },
    ],
    sequences: [
      { title: tr('Заказ'), participants: [tr('Клиент'), tr('Сайт'), tr('Сервер BuildPath'), tr('Вы')], messages: [
        { from: 0, to: 1, text: tr('Кладёт товары в корзину') },
        { from: 1, to: 2, text: tr('Считает корзину по каталогу (GET /cart)') },
        { from: 0, to: 1, text: tr('Выбирает получение и оплату, оставляет имя и телефон') },
        { from: 1, to: 2, text: tr('Создаёт заказ (POST /__forms/order)') },
        { from: 2, to: 3, text: tr('Уведомление о новом заказе') },
        { from: 2, to: 0, text: tr('Личная ссылка на заказ') },
        { from: 3, to: 0, text: tr('Звонит и подтверждает') },
      ] },
    ],
    coverage,
    features: [
      { title: tr('Цены только из каталога'), plain: tr('Клиент не может изменить цену: сервер пересчитывает корзину по принятой версии каталога.'), technical: tr('Состав и цены копируются в заказ; итог = товары + доставка, проверяется ограничением в базе.') },
      ...(store.minOrder ? [{ title: tr('Минимальный заказ'), plain: tr('Оформить заказ можно от {0}.', [tenge(store.minOrder)]), technical: tr('Проверяется и в корзине, и при отправке формы.') }] : []),
      { title: tr('Отмена клиентом'), plain: tr('По личной ссылке клиент может отменить заказ, пока вы его не подтвердили.'), technical: tr('В ссылке случайный токен 192 бит; хранится только его SHA-256.') },
    ],
    roles: [
      { title: tr('Клиент'), plain: tr('Оформляет и отменяет свой заказ. Аккаунт не нужен.'), technical: tr('Без входа; согласие на обработку данных обязательно.') },
      { title: tr('Вы (владелец)'), plain: tr('Меняете каталог, видите все заказы и меняете их статус.'), technical: tr('Владелец и менеджеры проекта.') },
    ],
    data: [
      { title: tr('Хранение'), plain: tr('Заказы удаляются автоматически через 12 месяцев.'), technical: tr('Срок LEAD_RETENTION_DAYS (по умолчанию 365); IP хранится только как солёный хэш.') },
    ],
    pages: [
      { path: '/', title: tr('Главная'), plain: tr('Ваш сайт с каталогом товаров.') },
      { path: '/cart', title: tr('Корзина'), plain: tr('Товары, способ получения и оплаты, контакты.') },
      { path: '/order/…', title: tr('Мой заказ'), plain: tr('Личная страница клиента: состав, итог, статус и отмена.') },
      { path: '/privacy', title: tr('Данные'), plain: tr('Какие данные собираются, зачем и как попросить удалить.') },
    ],
    notifications: [tr('Вам: новый заказ и отмена — в Telegram и/или на почту.'), tr('Клиенту: подтверждение на экране и личная ссылка на заказ. Письма и SMS клиенту не отправляются.')],
    hosting: [
      { option: 'BuildPath', plain: tr('Работает сразу после публикации; заказы хранятся в BuildPath.') },
      { option: tr('Свой сервер'), plain: tr('Пока не подходит: программы для приёма заказов на своём сервере нет.') },
      { option: 'GitHub Pages', plain: tr('Не подходит: там нельзя принимать заказы.') },
    ],
    limits: [tr('До 60 товаров, без вариантов (размер, цвет) и остатков на складе.'), tr('Нет онлайн-оплаты: только при получении или переводом после подтверждения.'), tr('Нет писем клиенту — только страница заказа по ссылке.')],
    api: '',
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
  const items = (list: TechPlanItem[]) => list.flatMap((item) => [`- **${item.title}.** ${item.plain}`, tr("  - Технически: {0}", [item.technical])]);
  return [
    tr("# Архитектура"), '', plan.summary, '',
    ...(plan.components?.length ? [tr("## Из чего состоит"), '', ...items(plan.components), ''] : []),
    ...(plan.dataModel?.length ? [tr("## Данные"), '', ...plan.dataModel.flatMap((entity) => [`- **${entity.name}.** ${entity.plain}`, ...entity.fields.map((item) => `  - ${item.name}: ${item.type}`)]), ''] : []),
    ...(plan.sequences ?? []).flatMap((sequence) => [tr("## Сценарий: {0}", [sequence.title]), '', ...sequence.messages.map((message, index) => `${index + 1}. ${sequence.participants[message.from]} → ${sequence.participants[message.to]}: ${message.text}`), '']),
    ...(plan.coverage?.length ? [tr("## Что из процесса делает сайт"), '', ...plan.coverage.map((step) => `- ${step.status === 'built' ? '✓' : step.status === 'manual' ? '·' : '✗'} ${step.scenario} — ${step.actor}: ${step.action}. ${step.how}`), ''] : []),
    ...(plan.features.length ? [tr("## Что умеет"), '', ...items(plan.features), ''] : []),
    ...(plan.roles.length ? [tr("## Кто пользуется"), '', ...items(plan.roles), ''] : []),
    ...(plan.data.length ? [tr("## Хранение"), '', ...items(plan.data), ''] : []),
    tr("## Страницы"), '', ...plan.pages.map((item) => `- \`${item.path}\` — ${item.title}: ${item.plain}`), '',
    tr("## Уведомления"), '', ...plan.notifications.map((item) => `- ${item}`), '',
    tr("## Где работает"), '', ...plan.hosting.map((item) => `- ${item.option}: ${item.plain}`), '',
    tr("## Ограничения этой версии"), '', ...plan.limits.map((item) => `- ${item}`), '',
    ...(plan.ownerNotes ? [tr("## Заметки владельца"), '', plan.ownerNotes, ''] : []),
    plan.api ? tr("Контракт API — в файле {0}. Версия: {1}.", [plan.kind === 'site' ? 'lead-api.yaml' : 'booking-api.yaml', plan.planVersion]) : tr("Версия: {0}.", [plan.planVersion]), '',
  ].join('\n');
}

/** Same plan apart from the owner's notes (used to tell whether the plan follows the accepted inputs). */
export function sameTechPlan(a: TechPlan, b: TechPlan): boolean {
  const strip = ({ ownerNotes: _notes, ...rest }: TechPlan) => stableStringify(rest);
  return strip(a) === strip(b);
}
