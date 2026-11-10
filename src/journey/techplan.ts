// «Технический план»: what will be built, in plain words for the owner and precise for a developer, with the API contract.
// Derived deterministically from the accepted inputs; the owner adds only notes. It is a contract stage: the build relies on it.
import type { Brief, Offer } from './artifacts.js';
import { ArtifactValidationError, stableStringify } from './artifacts.js';
import { WEEKDAYS, doable, type Schedule } from './schedule.js';

export const TECHPLAN_VERSION = '1.0.0';

export interface TechPlanItem { title: string; plain: string; technical: string }
export interface TechPlan {
  planVersion: string;
  summary: string;
  features: TechPlanItem[];
  roles: TechPlanItem[];
  data: TechPlanItem[];
  pages: Array<{ path: string; title: string; plain: string }>;
  notifications: string[];
  hosting: Array<{ option: string; plain: string }>;
  limits: string[];
  /** OpenAPI 3.1 contract of the booking endpoints the site and the exported app implement. */
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

export function buildTechPlan(input: { brief: Brief | null; offer: Offer | null; schedule: Schedule }, ownerNotes: string | null): TechPlan {
  const { schedule } = input;
  const name = input.brief?.businessName || 'ваш бизнес';
  const services = schedule.services.map((service) => `${service.name} (${minutes(service.minutes)})`).join(', ');
  const masters = schedule.masters.map((master) => {
    const days = master.week.map((day, index) => (day ? `${WEEKDAYS[index]} ${day.from}–${day.to}` : null)).filter(Boolean).join(', ');
    return `${master.name}: ${doable(schedule, master).map((service) => service.name).join(', ') || 'нет услуг'}; ${days || 'нет рабочих дней'}`;
  });
  const rules = schedule.rules;
  return {
    planVersion: TECHPLAN_VERSION,
    summary: `Сайт «${name}» с онлайн-записью: клиент выбирает услугу, мастера и свободное время, оставляет имя и телефон и получает личную ссылку на запись. Вы получаете уведомление и видите все записи в проекте.`,
    features: [
      { title: 'Свободное время', plain: `Клиент видит только то время, когда мастер работает и свободен на всю длительность услуги. Варианты начала — каждые ${rules.slotStep} мин, не раньше чем через ${rules.minNoticeHours} ч и не дальше ${rules.horizonDays} дн.`,
        technical: `Слоты считаются на сервере из расписания (часовой пояс ${schedule.timezone}) и активных записей; пересечения по мастеру исключаются.` },
      { title: 'Запись без двойного бронирования', plain: 'Если два человека выбрали одно время, запишется только первый, второму предложим другое.',
        technical: 'BuildPath: advisory-lock на сайт в транзакции PostgreSQL с пересчётом слотов. Свой сервер: одна очередь записи в одном процессе.' },
      { title: '«Любой свободный мастер»', plain: 'Клиент может не выбирать мастера — запишем к тому, у кого в этот день меньше записей.', technical: 'Выбор мастера с наименьшим числом активных записей за день среди свободных.' },
      { title: 'Отмена клиентом', plain: `По личной ссылке клиент может отменить запись не позже чем за ${rules.cancelHours} ч.`, technical: 'В ссылке случайный токен 192 бит; хранится только его SHA-256.' },
      { title: 'Записи для владельца', plain: 'Список предстоящих и прошедших записей: позвонить, отменить, отметить «пришёл / не пришёл».', technical: 'BuildPath: GET /projects/{id}/bookings. Свой сервер: /admin под паролем (HTTP Basic через HTTPS).' },
    ],
    roles: [
      { title: 'Клиент', plain: 'Записывается и отменяет свою запись. Аккаунт не нужен.', technical: 'Без входа; согласие на обработку данных обязательно; лимит 5 записей в час с одного адреса.' },
      { title: 'Вы (владелец)', plain: 'Меняете расписание и видите все записи.', technical: 'Владелец и менеджеры проекта; на своём сервере — пароль ADMIN_PASSWORD.' },
      { title: 'Мастера', plain: `Пока без своих аккаунтов: записи видит владелец. Мастера: ${schedule.masters.map((master) => master.name).join(', ')}.`, technical: 'Кабинеты мастеров — в следующих версиях.' },
    ],
    data: [
      { title: 'Расписание', plain: `Услуги: ${services}. ${masters.join('. ')}.`, technical: 'Принятая версия этапа «Расписание и запись» встраивается в сборку сайта (meta.booking).' },
      { title: 'Запись', plain: 'Услуга, мастер, время, имя, телефон, комментарий, статус.', technical: 'Таблица bookings (BuildPath) или data/bookings.json (свой сервер); схема Booking в контракте.' },
      { title: 'Хранение', plain: 'Записи удаляются автоматически через 12 месяцев после визита.', technical: 'Срок LEAD_RETENTION_DAYS (по умолчанию 365); IP хранится только как солёный хэш.' },
    ],
    pages: [
      { path: '/', title: 'Главная', plain: 'Ваш сайт с разделом «Онлайн-запись» и кнопками записи.' },
      { path: '/book', title: 'Запись', plain: 'Шаги: услуга → мастер → день и время → контакты.' },
      { path: '/book/b/…', title: 'Моя запись', plain: 'Личная страница клиента с отменой.' },
      { path: '/privacy', title: 'Данные', plain: 'Какие данные собираются, зачем и как попросить удалить.' },
    ],
    notifications: ['Вам: новая запись и отмена клиентом — в Telegram и/или на почту (настройки публикации).', 'Клиенту: подтверждение на экране и личная ссылка. SMS и сообщения клиентам пока не отправляются.'],
    hosting: [
      { option: 'BuildPath', plain: 'Работает сразу после публикации; записи хранятся в BuildPath.' },
      { option: 'Свой сервер', plain: 'Пакет с программой записи (Node.js 22, без сторонних библиотек), Caddy и инструкцией; записи — на вашем сервере.' },
      { option: 'GitHub Pages', plain: 'Не подходит: там нельзя принимать записи.' },
    ],
    limits: ['Рабочие часы задаются по дням недели: перерывов и выходных на конкретные даты пока нет.', 'Нет предоплаты и напоминаний клиентам.', 'Мастера не входят в систему сами.'],
    api: bookingApiContract(),
    ownerNotes,
  };
}

/** A stored plan is checked for shape only; its content is always produced by buildTechPlan. */
export function normalizeTechPlan(raw: unknown): TechPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const plan = raw as TechPlan;
  if (typeof plan.summary !== 'string' || typeof plan.api !== 'string' || !Array.isArray(plan.features)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  return { ...plan, ownerNotes: techPlanNotes(raw) };
}

export function techPlanMarkdown(plan: TechPlan): string {
  const items = (list: TechPlanItem[]) => list.flatMap((item) => [`- **${item.title}.** ${item.plain}`, `  - Технически: ${item.technical}`]);
  return [
    '# Технический план', '', plan.summary, '',
    '## Что умеет', '', ...items(plan.features), '',
    '## Кто пользуется', '', ...items(plan.roles), '',
    '## Данные', '', ...items(plan.data), '',
    '## Страницы', '', ...plan.pages.map((item) => `- \`${item.path}\` — ${item.title}: ${item.plain}`), '',
    '## Уведомления', '', ...plan.notifications.map((item) => `- ${item}`), '',
    '## Где работает', '', ...plan.hosting.map((item) => `- ${item.option}: ${item.plain}`), '',
    '## Ограничения этой версии', '', ...plan.limits.map((item) => `- ${item}`), '',
    ...(plan.ownerNotes ? ['## Заметки владельца', '', plan.ownerNotes, ''] : []),
    `Контракт API — в файле booking-api.yaml. Версия плана: ${plan.planVersion}.`, '',
  ].join('\n');
}

/** Same plan apart from the owner's notes (used to tell whether the plan follows the accepted inputs). */
export function sameTechPlan(a: TechPlan, b: TechPlan): boolean {
  const strip = ({ ownerNotes: _notes, ...rest }: TechPlan) => stableStringify(rest);
  return strip(a) === strip(b);
}
