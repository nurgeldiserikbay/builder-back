// What each stage hands over to the stages built on it, written out item by item. Required items are what the next
// stages cannot work without: acceptance waits for them. Recommended items make the next stages better; they are shown,
// not enforced. The checks are deliberately small and readable — the quality review (stage-review.ts) goes deeper.
import { QUALITY_KEYS } from './spec-extras.js';
import type { Concept } from './concept.js';
import type { Suggestions } from './suggestions.js';
import { tr } from '../i18n/i18n.js';
import type { Brief, Story, ContentArtifact, DesignArtifact, Offer } from './artifacts.js';
import type { ArtifactType } from './catalog.js';
import type { Catalog } from './products.js';
import type { BusinessProcess } from './process.js';
import { measurable, type IdeaReview } from './idea.js';
import type { Schedule } from './schedule.js';
import type { Sitemap } from './sitemap.js';
import type { CustomerPaths } from './paths.js';
import type { TechPlan } from './techplan.js';
import type { ArchitectureDesign } from './architecture.js';
import { contractIssues, type Contracts } from './contracts.js';
import { roadmapIssues, scheduleOf, type Roadmap } from './roadmap.js';
import { testPlanIssues, type TestPlan } from './testplan.js';
import type { AppFeatures, AppScreens } from './webapp.js';

export const OUTPUTS_VERSION = '1.0.0';
export type OutputLevel = 'required' | 'recommended';
interface OutputItem<T> { key: string; text: () => string; level: OutputLevel; met: (content: T, context: OutputContext) => boolean }
export interface OutputContext { features?: AppFeatures | null; design?: ArchitectureDesign | null; contracts?: Contracts | null }

const PLACEHOLDER = /\[[^\]]{1,80}\]/;
const filled = (value: string | null | undefined) => Boolean(value?.trim());

const story: OutputItem<Story>[] = [
  { key: 'essence', level: 'required', text: () => tr('Название и суть в одном предложении — для разбора идеи, концепции и текстов'), met: (x) => filled(x.name) && filled(x.essence) },
  { key: 'audience', level: 'required', text: () => tr('Для кого — из этого вырастают группы пользователей и роли'), met: (x) => filled(x.audience) },
  { key: 'problem', level: 'required', text: () => tr('Какую задачу это решает — с неё начинается разбор идеи'), met: (x) => filled(x.problem) },
  { key: 'materials', level: 'recommended', text: () => tr('Что уже есть — чтобы не начинать с нуля'), met: (x) => filled(x.materials) || filled(x.story) },
];

const brief: OutputItem<Brief>[] = [
  { key: 'who', level: 'required', text: () => tr('Название и чем вы занимаетесь — для текстов и процесса'), met: (b) => filled(b.businessName) && filled(b.whatYouDo) },
  { key: 'audience', level: 'required', text: () => tr('Кто ваши клиенты — для тона и содержания текстов'), met: (b) => filled(b.audience) },
  { key: 'action', level: 'required', text: () => tr('Главное действие и контакт для него — для кнопок и формы'),
    met: (b) => Boolean(b.mainAction) && (b.mainAction === 'call' ? filled(b.phone) : b.mainAction === 'message' ? filled(b.messenger) : b.mainAction === 'email' ? filled(b.email) : b.mainAction === 'visit' ? filled(b.address) : true) },
  { key: 'city', level: 'recommended', text: () => tr('Город — чтобы вас находили рядом'), met: (b) => filled(b.city) || filled(b.address) },
];

const idea: OutputItem<IdeaReview>[] = [
  { key: 'problem', level: 'required', text: () => tr('Проблема и для кого — из них строится бизнес-процесс'), met: (i) => filled(i.problem) && i.segments.some((segment) => filled(segment.name)) },
  { key: 'metrics', level: 'required', text: () => tr('Измеримая цель успеха — по ней выбирают функции первой версии и аналитику'), met: (i) => i.metrics.some((metric) => measurable(metric.text)) },
  { key: 'risks', level: 'recommended', text: () => tr('Риски с решениями — для плана работ'), met: (i) => i.risks.length > 0 && i.risks.every((risk) => risk.decision !== 'open' || risk.impact === 'low') },
  { key: 'value', level: 'recommended', text: () => tr('Почему выберут вас — для текстов и предложений функций'), met: (i) => filled(i.value) },
];

const suggestions: OutputItem<Suggestions>[] = [
  { key: 'decisions', level: 'required', text: () => tr('Решение по каждому предложению — из него ТЗ знает, что входит в первую версию'), met: (s) => s.items.every((item) => Boolean(item.decision)) },
  { key: 'reasons', level: 'recommended', text: () => tr('Причины для «не нужно» — чтобы не спорить об этом заново'), met: (s) => s.items.every((item) => item.decision !== 'no' || filled(item.reason)) },
];

const concept: OutputItem<Concept>[] = [
  { key: 'pitch', level: 'required', text: () => tr('«В двух словах» — с этого начинают читать'), met: (c) => filled(c.pitch) },
  { key: 'questions', level: 'recommended', text: () => tr('Открытые вопросы записаны — для ТЗ и плана'), met: (c) => c.questions.length > 0 },
];

const offer: OutputItem<Offer>[] = [
  { key: 'services', level: 'required', text: () => tr('Хотя бы одна услуга с названием — для текстов, каталога и записи'), met: (o) => o.services.some((service) => filled(service.name)) },
  { key: 'prices', level: 'recommended', text: () => tr('Цены услуг — клиенты спрашивают их первыми'), met: (o) => o.services.length > 0 && o.services.every((service) => filled(service.price)) },
];

const process: OutputItem<BusinessProcess>[] = [
  { key: 'actors', level: 'required', text: () => tr('Клиент и бизнес среди участников — из них получатся роли'), met: (p) => p.actors.some((actor) => actor.kind === 'client') && p.actors.some((actor) => actor.kind !== 'client') },
  { key: 'scenarios', level: 'required', text: () => tr('Сценарии с шагами — из них получатся функции и экраны'), met: (p) => p.scenarios.length > 0 && p.scenarios.every((scenario) => scenario.steps.length > 0) },
  { key: 'data', level: 'required', text: () => tr('Данные с полями — из них получится схема базы данных'), met: (p) => p.data.length > 0 && p.data.every((entity) => entity.fields.length > 0) },
  { key: 'results', level: 'recommended', text: () => tr('У каждого сценария описан результат — по нему проверят работу'), met: (p) => p.scenarios.every((scenario) => filled(scenario.goal)) },
  { key: 'rules', level: 'recommended', text: () => tr('Правила работы, в том числе о личных данных клиентов'), met: (p) => p.rules.length > 0 },
];

const features: OutputItem<AppFeatures>[] = [
  { key: 'roles', level: 'required', text: () => tr('Роли — для экранов и прав доступа'), met: (f) => f.roles.length > 0 },
  { key: 'must', level: 'required', text: () => tr('Обязательные функции с критериями приёмки — по ним делают и проверяют экраны'), met: (f) => f.features.some((feature) => feature.priority === 'must') && f.features.filter((feature) => feature.priority === 'must').every((feature) => feature.acceptance.length > 0) },
  { key: 'data', level: 'recommended', text: () => tr('У каждой функции указаны данные — для карты модулей и архитектуры'), met: (f) => f.features.every((feature) => (feature.data ?? []).length > 0) },
  { key: 'cases', level: 'recommended', text: () => tr('Проверки «Дано / Когда / Тогда» у обязательных функций — из них получится план тестов'), met: (f) => f.features.filter((feature) => feature.priority === 'must').every((feature) => (feature.cases ?? []).length > 0) },
  { key: 'access', level: 'recommended', text: () => tr('Кто что может с какими данными — для архитектуры и проверки безопасности'), met: (f) => (f.access ?? []).length > 0 },
  { key: 'quality', level: 'recommended', text: () => tr('Нефункциональные требования: скорость, нагрузка, где хранятся данные, резервные копии — для архитектуры и оценки работы'), met: (f) => QUALITY_KEYS.filter((key) => f.quality?.[key]).length >= 4 },
];

const screens: OutputItem<AppScreens>[] = [
  { key: 'coverage', level: 'required', text: () => tr('Каждая обязательная функция есть на экране — иначе её не сделают'),
    met: (s, context) => !context.features || context.features.features.filter((feature) => feature.priority === 'must').every((feature) => s.screens.some((screen) => screen.features.includes(feature.key))) },
  { key: 'forms', level: 'recommended', text: () => tr('У форм перечислены поля — разработчик знает, что сохранять'), met: (s) => s.screens.every((screen) => screen.blocks.every((block) => block.kind !== 'form' || block.fields.length > 0)) },
];

const sitemap: OutputItem<Sitemap>[] = [
  { key: 'home', level: 'required', text: () => tr('Главная страница — с неё начинается сайт'), met: (m) => m.pages.some((page) => page.path === '/') },
  { key: 'purpose', level: 'recommended', text: () => tr('У каждой страницы сказано, зачем она, — по этому пишут тексты'), met: (m) => m.pages.every((page) => filled(page.purpose)) },
];

const paths: OutputItem<CustomerPaths>[] = [
  { key: 'actions', level: 'required', text: () => tr('Чем заканчивается каждый путь — к этому действию тексты ведут посетителя'), met: (p) => p.paths.length > 0 && p.paths.every((path) => Boolean(path.action)) },
  { key: 'doubts', level: 'recommended', text: () => tr('Сомнения и ответы — тексты отвечают на них, чтобы посетитель не ушёл'), met: (p) => p.paths.some((path) => filled(path.doubt) && filled(path.answer)) },
];

const content: OutputItem<ContentArtifact>[] = [
  { key: 'blocks', level: 'required', text: () => tr('Первый экран и контакты — без них сайт не собрать'), met: (c) => c.sections.some((section) => section.type === 'hero') && c.sections.some((section) => section.type === 'contacts') },
  { key: 'placeholders', level: 'required', text: () => tr('Нет мест в квадратных скобках — на сайт попадёт только настоящий текст'), met: (c) => !c.sections.some((section) => PLACEHOLDER.test(JSON.stringify(section))) },
  { key: 'seo', level: 'required', text: () => tr('Заголовок для поисковиков'), met: (c) => filled(c.seo.title) },
  { key: 'seoDescription', level: 'recommended', text: () => tr('Описание для поисковиков'), met: (c) => filled(c.seo.description) },
];

const design: OutputItem<DesignArtifact>[] = [
  { key: 'look', level: 'required', text: () => tr('Цвета и шрифт — сборка применит их к сайту'), met: (d) => filled(d.palette) && filled(d.font) },
];

const schedule: OutputItem<Schedule>[] = [
  { key: 'services', level: 'required', text: () => tr('Услуги с длительностью — из них считаются свободные окна'), met: (s) => s.services.length > 0 && s.services.every((service) => service.minutes > 0) },
  { key: 'masters', level: 'required', text: () => tr('Хотя бы один мастер с рабочими днями'), met: (s) => s.masters.some((master) => master.week.some(Boolean)) },
  { key: 'bookable', level: 'recommended', text: () => tr('Запись открыта дольше, чем нужно записываться заранее'), met: (s) => s.rules.minNoticeHours < s.rules.horizonDays * 24 },
];

const catalog: OutputItem<Catalog>[] = [
  { key: 'products', level: 'required', text: () => tr('Товары в наличии с ценой — для витрины и корзины'), met: (c) => c.products.some((product) => product.available && product.price > 0) },
  { key: 'payment', level: 'required', text: () => tr('Способ оплаты — клиент должен знать, как платить'), met: (c) => c.payment.onDelivery || c.payment.transfer },
  { key: 'photos', level: 'recommended', text: () => tr('Фото товаров'), met: (c) => c.products.filter((product) => product.available).every((product) => Boolean(product.imageId)) },
];

const techplan: OutputItem<TechPlan>[] = [
  { key: 'links', level: 'required', text: () => tr('Связи в схеме данных ведут к существующим таблицам'), met: (t) => !Array.isArray(t.dataModel) || t.dataModel.every((entity) => entity.links.every((link) => t.dataModel.some((other) => other.key === link.to))) },
  { key: 'coverage', level: 'recommended', text: () => tr('Для каждого шага процесса решено: делает сайт или вручную'), met: (t) => !(t.coverage ?? []).some((step) => step.status === 'not_built') },
];

const contractCodes = (value: Contracts, context: OutputContext) => new Set(contractIssues(value, context.features ?? null, context.design ?? null).map((issue) => issue.code));
const contracts: OutputItem<Contracts>[] = [
  { key: 'coverage', level: 'required', text: () => tr('Каждая функция ТЗ покрыта операцией — по ним пишут модули'), met: (c, context) => c.operations.length > 0 && !contractCodes(c, context).has('CONTRACT_FEATURE_NOT_COVERED') },
  { key: 'rights', level: 'required', text: () => tr('У операций права не шире матрицы «кто что может» — их проверяет сервер'), met: (c, context) => !['CONTRACT_OPERATION_OPEN', 'CONTRACT_ROLE_NOT_ALLOWED'].some((code) => contractCodes(c, context).has(code)) },
  { key: 'owners', level: 'required', text: () => tr('У каждой записи один модуль-владелец — чтобы модули писали параллельно'), met: (c, context) => !contractCodes(c, context).has('CONTRACT_TWO_OWNERS') },
  { key: 'errors', level: 'recommended', text: () => tr('Ошибки операций описаны — для экранов и тестов'), met: (c) => c.operations.every((operation) => operation.errors.length > 0) },
  { key: 'fallbacks', level: 'recommended', text: () => tr('Для внешних сервисов сказано, что делать при сбое'), met: (c, context) => !['CONTRACT_INTEGRATION_NO_FALLBACK', 'CONTRACT_SERVICE_MISSING'].some((code) => contractCodes(c, context).has(code)) },
];

const roadmapCodes = (value: Roadmap, context: OutputContext) => new Set(roadmapIssues(value, context.features ?? null, context.contracts ?? null).map((issue) => issue.code));
const roadmap: OutputItem<Roadmap>[] = [
  { key: 'order', level: 'required', text: () => tr('Порядок без циклов — по нему модули отдают исполнителям'), met: (r) => r.modules.length > 0 && scheduleOf(r) !== null },
  { key: 'coverage', level: 'required', text: () => tr('Каждая обязательная функция и каждый модуль контрактов в плане'), met: (r, context) => !['ROADMAP_FEATURE_MISSING', 'ROADMAP_CONTRACT_MODULE_MISSING'].some((code) => roadmapCodes(r, context).has(code)) },
  { key: 'estimates', level: 'required', text: () => tr('У задач есть оценки — по ним считаются срок и прогресс'), met: (r) => r.modules.every((module) => module.tasks.length > 0 && module.tasks.every((task) => task.hours > 0)) },
  { key: 'risks', level: 'recommended', text: () => tr('Риски с действиями'), met: (r) => r.risks.length > 0 && r.risks.every((risk) => Boolean(risk.action)) },
];

const testCodes = (value: TestPlan, context: OutputContext) => new Set(testPlanIssues(value, context.features ?? null, context.design ?? null).map((issue) => issue.code));
const testplan: OutputItem<TestPlan>[] = [
  { key: 'functions', level: 'required', text: () => tr('У обязательных функций есть нормальный путь и «кому нельзя» — по ним закрываются задачи'), met: (p, context) => p.cases.length > 0 && !['TESTPLAN_NO_NORMAL', 'TESTPLAN_NO_RIGHTS'].some((code) => testCodes(p, context).has(code)) },
  { key: 'threats', level: 'required', text: () => tr('Каждая угроза архитектуры проверяется'), met: (p, context) => !['TESTPLAN_THREAT_UNCOVERED', 'TESTPLAN_SENSITIVE_UNCOVERED'].some((code) => testCodes(p, context).has(code)) },
  { key: 'expected', level: 'required', text: () => tr('У каждого кейса есть ожидаемый результат'), met: (p) => p.cases.every((item) => Boolean(item.expected)) },
  { key: 'tasks', level: 'recommended', text: () => tr('Кейсы привязаны к задачам плана реализации'), met: (p) => p.cases.filter((item) => item.task).length >= p.cases.length / 2 },
];

const OUTPUTS: Partial<Record<ArtifactType, OutputItem<never>[]>> = {
  story, brief, idea, suggestions, concept, offer, process, features, screens, sitemap, paths, content, design, schedule, catalog, techplan, contracts, roadmap, testplan,
} as unknown as Partial<Record<ArtifactType, OutputItem<never>[]>>;

export interface StageOutputItem { key: string; text: string; level: OutputLevel; met: boolean }

/** The hand-over list of one stage result. Types without one (the site, the hand-over package) return an empty list. */
export function stageOutputs(type: ArtifactType, content: unknown, context: OutputContext = {}): StageOutputItem[] {
  if (!content || typeof content !== 'object') return [];
  return (OUTPUTS[type] ?? []).map((item) => {
    let met = false;
    try { met = (item as OutputItem<unknown>).met(content, context); } catch { met = false; }
    return { key: item.key, text: item.text(), level: item.level, met };
  });
}

export const missingRequired = (items: StageOutputItem[]) => items.filter((item) => item.level === 'required' && !item.met);
