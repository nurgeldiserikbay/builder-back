/**
 * Quality audit of a built site: the pages exactly as they will be published, parsed as HTML and checked by fixed rules.
 * Pure and deterministic — the same build always gives the same findings. What can only be measured in a real browser or on
 * the live server is listed as «not measured», never guessed.
 */
import { parse } from 'parse5';
import { tr } from '../i18n/i18n.js';

export type Category = 'security' | 'accessibility' | 'performance' | 'seo';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Finding = { id: string; category: Category; severity: Severity; title: string; details: string; pages: string[] };
export type Unmeasured = { id: string; category: Category; title: string; why: string };

export const AUDIT_VERSION = '1.0.0';

/** Budgets for one page. Generated pages have no scripts; photos are WebP, served from the sites server. */
export const BUDGETS = { htmlKb: 100, htmlKbHigh: 300, pageKb: 1500, pageKbHigh: 3000, imageKb: 500, externalRequests: 0 };

type Node = { nodeName: string; tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: Node[]; value?: string; content?: Node };
export type AuditPage = { path: string; html: string };
export type AuditInput = { pages: AuditPage[]; imageBytes: Record<string, number>; draft?: boolean };

const attr = (node: Node, name: string): string | null => node.attrs?.find((item) => item.name === name)?.value ?? null;

function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []) {
  visit(node, ancestors);
  const children = node.nodeName === 'template' ? node.content?.childNodes ?? [] : node.childNodes ?? [];
  for (const child of children) walk(child, visit, [...ancestors, node]);
}

function textOf(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textOf).join('');
}

/** Accessible name of a link or button: its text, aria-label, or the alt of an image inside. */
function accessibleName(node: Node): string {
  const label = attr(node, 'aria-label') ?? attr(node, 'title');
  if (label?.trim()) return label.trim();
  let name = textOf(node).trim();
  if (!name) walk(node, (child) => { if (child.tagName === 'img' && attr(child, 'alt')?.trim()) name ||= attr(child, 'alt')!.trim(); });
  return name;
}

const IMAGE_PATH = /^\/img\/([0-9a-f-]{36})\.webp$/i;
const external = (url: string) => /^(https?:)?\/\//i.test(url.trim());

export function auditSite(input: AuditInput): { findings: Finding[]; unmeasured: Unmeasured[]; pages: Array<{ path: string; htmlKb: number; imagesKb: number }> } {
  const found = new Map<string, Finding>();
  const add = (id: string, category: Category, severity: Severity, title: string, details: string, page: string) => {
    const existing = found.get(id);
    if (existing) { if (!existing.pages.includes(page)) existing.pages.push(page); return; }
    found.set(id, { id, category, severity, title, details, pages: [page] });
  };
  const paths = new Set(input.pages.map((page) => page.path));
  const sizes: Array<{ path: string; htmlKb: number; imagesKb: number }> = [];

  for (const page of input.pages) {
    const doc = parse(page.html) as unknown as Node;
    const p = page.path;
    let htmlNode: Node | null = null;
    let title = '';
    let description: string | null = null;
    let viewport: string | null = null;
    let robots: string | null = null;
    let ogTitle = false;
    const headings: number[] = [];
    const ids = new Map<string, number>();
    const labelled = new Set<string>();
    const images = new Set<string>();

    walk(doc, (node) => {
      const tag = node.tagName;
      if (!tag) return;
      const id = attr(node, 'id');
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
      if (tag === 'label' && attr(node, 'for')) labelled.add(attr(node, 'for')!);
      for (const item of node.attrs ?? []) {
        if (/^on[a-z]+$/i.test(item.name)) add('sec-inline-handlers', 'security', 'high', tr('Нет встроенных обработчиков'), tr('На странице есть атрибуты вида onclick: это код внутри разметки, сайт BuildPath его не использует.'), p);
        if (['href', 'src', 'action', 'formaction'].includes(item.name) && /^\s*javascript:/i.test(item.value)) add('sec-javascript-url', 'security', 'critical', tr('Нет ссылок javascript:'), tr('Ссылка или форма запускает код через javascript: — так могут подменить действие.'), p);
      }
    });

    walk(doc, (node, ancestors) => {
      const tag = node.tagName;
      if (!tag) return;
      switch (tag) {
        case 'html': htmlNode = node; break;
        case 'title': title = textOf(node).trim(); break;
        case 'meta': {
          const name = (attr(node, 'name') ?? '').toLowerCase();
          if (name === 'description') description = attr(node, 'content') ?? '';
          if (name === 'viewport') viewport = attr(node, 'content') ?? '';
          if (name === 'robots') robots = (attr(node, 'content') ?? '').toLowerCase();
          if ((attr(node, 'property') ?? '') === 'og:title' && attr(node, 'content')?.trim()) ogTitle = true;
          break;
        }
        case 'script': {
          const type = (attr(node, 'type') ?? '').toLowerCase();
          if (type !== 'application/ld+json') add('sec-scripts', 'security', 'high', tr('Нет скриптов'), tr('На странице есть скрипт. Сайты BuildPath работают без скриптов: так меньше риск и быстрее загрузка.'), p);
          break;
        }
        case 'iframe': add('sec-iframe', 'security', 'medium', tr('Нет встроенных чужих страниц'), tr('На странице встроена другая страница (iframe). Она может следить за посетителями и замедлять сайт.'), p); break;
        case 'form': {
          const action = attr(node, 'action') ?? '';
          if (external(action) || /^\s*javascript:/i.test(action)) add('sec-form-action', 'security', 'critical', tr('Формы отправляются только на ваш сайт'), tr('Форма отправляет данные посетителя на чужой адрес.'), p);
          if (action.trim().toLowerCase().startsWith('http:')) add('sec-mixed-content', 'security', 'high', tr('Всё загружается по HTTPS'), tr('Часть страницы загружается или отправляется по незащищённому http://.'), p);
          break;
        }
        case 'a': {
          const href = attr(node, 'href') ?? '';
          if (attr(node, 'target') === '_blank' && !/\bnoopener\b|\bnoreferrer\b/.test(attr(node, 'rel') ?? '')) add('sec-blank-rel', 'security', 'medium', tr('Ссылки в новом окне безопасны'), tr('Ссылка открывается в новом окне без rel="noopener": открытая страница может подменить ваш сайт.'), p);
          if (!accessibleName(node)) add('a11y-link-name', 'accessibility', 'medium', tr('У ссылок есть текст'), tr('Есть ссылка без текста — программа чтения с экрана не скажет, куда она ведёт.'), p);
          if (href.startsWith('/') && !href.startsWith('//')) {
            const path = href.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
            // Only page links are checked: service paths (data page, booking, cart, images) are served by the sites server.
            const service = /^\/(img|privacy|lead|book|booking|cart|order|store|_)/.test(path);
            if (paths.size > 1 && !service && !paths.has(path) && !paths.has(`${path}/`)) add('seo-broken-link', 'seo', 'high', tr('Ссылки между страницами работают'), tr('Ссылка ведёт на страницу, которой нет на сайте: {0}.', [path]), p);
          }
          break;
        }
        case 'button': if (!accessibleName(node)) add('a11y-button-name', 'accessibility', 'medium', tr('У кнопок есть текст'), tr('Есть кнопка без текста — непонятно, что она делает.'), p); break;
        case 'img': {
          const alt = attr(node, 'alt');
          if (alt === null) add('a11y-img-alt', 'accessibility', 'high', tr('У фото есть описание'), tr('У фото нет атрибута alt: программа чтения с экрана прочитает имя файла.'), p);
          if (!attr(node, 'width') || !attr(node, 'height')) add('perf-img-size-attrs', 'performance', 'low', tr('У фото указан размер'), tr('У фото не указаны ширина и высота — при загрузке страница «прыгает».'), p);
          const src = attr(node, 'src') ?? '';
          if (src.toLowerCase().startsWith('http:')) add('sec-mixed-content', 'security', 'high', tr('Всё загружается по HTTPS'), tr('Часть страницы загружается или отправляется по незащищённому http://.'), p);
          else if (external(src)) add('perf-external', 'performance', 'medium', tr('Всё загружается с вашего сайта'), tr('Страница загружает файлы с чужих сайтов: это медленнее и раскрывает посетителей третьим лицам.'), p);
          const match = IMAGE_PATH.exec(src);
          if (match) images.add(match[1]!.toLowerCase());
          break;
        }
        case 'link': {
          const href = attr(node, 'href') ?? '';
          const rel = (attr(node, 'rel') ?? '').toLowerCase();
          if (/stylesheet|preload|icon|modulepreload/.test(rel)) {
            if (href.toLowerCase().startsWith('http:')) add('sec-mixed-content', 'security', 'high', tr('Всё загружается по HTTPS'), tr('Часть страницы загружается или отправляется по незащищённому http://.'), p);
            else if (external(href)) add('perf-external', 'performance', 'medium', tr('Всё загружается с вашего сайта'), tr('Страница загружает файлы с чужих сайтов: это медленнее и раскрывает посетителей третьим лицам.'), p);
          }
          break;
        }
        case 'input': case 'select': case 'textarea': {
          const type = (attr(node, 'type') ?? '').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) break;
          const id = attr(node, 'id');
          const inLabel = ancestors.some((item) => item.tagName === 'label');
          if (!inLabel && !(id && labelled.has(id)) && !attr(node, 'aria-label')?.trim() && !attr(node, 'aria-labelledby')) {
            add('a11y-form-labels', 'accessibility', 'high', tr('У полей формы есть подписи'), tr('Есть поле без подписи — непонятно, что в него вписать, особенно с программой чтения с экрана.'), p);
          }
          break;
        }
        default:
          if (/^h[1-6]$/.test(tag)) headings.push(Number(tag[1]));
      }
    });

    const lang = htmlNode ? attr(htmlNode, 'lang') : null;
    if (!lang?.trim()) add('a11y-lang', 'accessibility', 'high', tr('Указан язык страницы'), tr('Не указан язык страницы — программа чтения с экрана прочитает текст с неверным произношением.'), p);
    if (!title) add('a11y-title', 'accessibility', 'high', tr('У страницы есть название'), tr('У страницы нет названия во вкладке браузера.'), p);
    const vp = (viewport ?? '') as string;
    if (!vp.includes('width=device-width')) add('a11y-viewport', 'accessibility', 'high', tr('Страница подстроена под телефон'), tr('Нет настройки ширины для телефона — страница откроется мелкой.'), p);
    if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp)) add('a11y-zoom', 'accessibility', 'high', tr('Страницу можно увеличить'), tr('Запрещено увеличение страницы пальцами — людям со слабым зрением будет трудно читать.'), p);
    const h1 = headings.filter((level) => level === 1).length;
    if (h1 !== 1) add('a11y-h1', 'accessibility', 'medium', tr('Один главный заголовок'), h1 === 0 ? tr('На странице нет главного заголовка (h1).') : tr('На странице несколько главных заголовков (h1) — поисковикам и программам чтения с экрана непонятно, о чём она.'), p);
    if (headings.some((level, index) => index > 0 && level > headings[index - 1]! + 1)) add('a11y-heading-order', 'accessibility', 'low', tr('Заголовки идут по порядку'), tr('Уровни заголовков пропускаются (например, после h2 сразу h4) — структуру труднее понять на слух.'), p);
    if ([...ids.values()].some((count) => count > 1)) add('a11y-duplicate-id', 'accessibility', 'medium', tr('Нет повторяющихся id'), tr('На странице повторяются идентификаторы элементов — подписи полей и ссылки на блоки могут работать неверно.'), p);
    const desc = (description ?? '') as string;
    if (!desc.trim()) add('seo-description', 'seo', 'medium', tr('Есть описание для поисковиков'), tr('Нет описания страницы — поисковик покажет случайный кусок текста.'), p);
    if (!input.draft && /noindex/.test((robots ?? '') as string)) add('seo-noindex', 'seo', 'high', tr('Страница открыта для поисковиков'), tr('Страница запрещена для поисковиков (noindex) — её не найдут.'), p);
    if (!ogTitle) add('seo-og', 'seo', 'low', tr('Ссылка красиво выглядит в мессенджерах'), tr('Нет заголовка для превью ссылки (og:title) — в мессенджерах ссылка будет без названия.'), p);

    const htmlKb = Buffer.byteLength(page.html, 'utf8') / 1024;
    const imagesKb = [...images].reduce((sum, id) => sum + (input.imageBytes[id] ?? 0), 0) / 1024;
    sizes.push({ path: p, htmlKb: Math.round(htmlKb), imagesKb: Math.round(imagesKb) });
    if (htmlKb > BUDGETS.htmlKbHigh) add('perf-html', 'performance', 'high', tr('Страница лёгкая'), tr('Код страницы больше {0} КБ — на мобильном интернете она откроется медленно.', [BUDGETS.htmlKbHigh]), p);
    else if (htmlKb > BUDGETS.htmlKb) add('perf-html', 'performance', 'medium', tr('Страница лёгкая'), tr('Код страницы больше {0} КБ — на мобильном интернете она откроется медленнее.', [BUDGETS.htmlKb]), p);
    const total = htmlKb + imagesKb;
    if (total > BUDGETS.pageKbHigh) add('perf-weight', 'performance', 'high', tr('Страница с фото загружается быстро'), tr('Страница вместе с фото больше {0} КБ — на мобильном интернете она будет грузиться долго. Уберите часть фото.', [BUDGETS.pageKbHigh]), p);
    else if (total > BUDGETS.pageKb) add('perf-weight', 'performance', 'medium', tr('Страница с фото загружается быстро'), tr('Страница вместе с фото больше {0} КБ. Подумайте, все ли фото нужны.', [BUDGETS.pageKb]), p);
    if ([...images].some((id) => (input.imageBytes[id] ?? 0) / 1024 > BUDGETS.imageKb)) add('perf-image', 'performance', 'medium', tr('Фото не слишком тяжёлые'), tr('Есть фото больше {0} КБ — загрузите фото поменьше или обрежьте его.', [BUDGETS.imageKb]), p);
  }

  const unmeasured: Unmeasured[] = [
    { id: 'cwv', category: 'performance', title: tr('Скорость у реальных посетителей (Core Web Vitals)'), why: tr('Измеряется в браузерах посетителей на настоящем сайте. До публикации её можно только оценить по весу страниц.') },
    { id: 'headers', category: 'security', title: tr('Защитные заголовки сервера'), why: tr('Их ставит сервер сайтов BuildPath при публикации (запрет встраивания, запрет скриптов, HTTPS). В сборке их нет — проверяются на опубликованном сайте.') },
    { id: 'screen-reader', category: 'accessibility', title: tr('Работа с программами чтения с экрана'), why: tr('Автоматически проверяются подписи, язык и порядок заголовков. Как сайт звучит целиком, проверяет только человек.') },
  ];
  return { findings: [...found.values()], unmeasured, pages: sizes };
}
