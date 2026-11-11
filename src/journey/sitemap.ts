// «Карта сайта» (stage key sitemap): the pages of a multi-page site, their addresses, menu names and purpose.
// A contract stage: texts are written page by page from it, the architecture lists the pages, the build makes one page per entry.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError, sectionTypes, type Brief, type Offer, type SectionType } from './artifacts.js';

export interface SitemapPage { key: string; path: string; title: string; purpose: string; sections: SectionType[] }
export interface Sitemap { pages: SitemapPage[] }

export const SITEMAP_LIMITS = { pages: 7, minPages: 2, sections: 8 } as const;
/** Addresses the platform itself uses on published sites. */
export const RESERVED_PATHS = ['book', 'cart', 'order', 'privacy', 'thanks', 'img', 'admin', 'robots.txt', 'sitemap.xml', 'health', 'index.html'];
const KEY = /^[a-z][a-z0-9-]{0,23}$/;
const PATH = /^\/(?:[a-z0-9][a-z0-9-]{0,29})?$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, field: string, max: number): string => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return clean;
};

/** «/uslugi» from a menu name: Latin letters, digits and hyphens; Cyrillic is transliterated. */
export function pathFor(title: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', қ: 'k', ғ: 'g', ү: 'u', ұ: 'u', ң: 'n', ө: 'o', һ: 'h', і: 'i', ә: 'a' };
  const slug = title.toLowerCase().split('').map((char) => map[char] ?? char).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return `/${slug || 'page'}`;
}

export function normalizeSitemap(raw: unknown): Sitemap {
  if (!isRecord(raw) || !Array.isArray(raw.pages)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  if (raw.pages.length < 1 || raw.pages.length > SITEMAP_LIMITS.pages) throw new ArtifactValidationError('FIELD_COUNT:pages');
  const keys = new Set<string>(); const paths = new Set<string>();
  const pages = raw.pages.map((page, index) => {
    if (!isRecord(page)) throw new ArtifactValidationError(`FIELD_INVALID:pages.${index}`);
    // The first page is the home page; its key is always «home», so blocks without a page land there.
    let key = index === 0 ? 'home' : typeof page.key === 'string' && KEY.test(page.key) && page.key !== 'home' && !keys.has(page.key) ? page.key : `page-${index + 1}`;
    while (keys.has(key)) key = `${key}-x`.slice(0, 24);
    keys.add(key);
    const title = text(page.title, `pages.${index}.title`, 30);
    const purpose = text(page.purpose, `pages.${index}.purpose`, 200);
    const first = index === 0;
    let path = first ? '/' : typeof page.path === 'string' ? page.path.trim().toLowerCase() : '';
    if (!first && (!PATH.test(path) || path === '/')) path = pathFor(title || key);
    if (!first && RESERVED_PATHS.includes(path.slice(1))) throw new ArtifactValidationError(`PATH_RESERVED:pages.${index}.path`);
    if (paths.has(path)) throw new ArtifactValidationError(`PATH_DUPLICATE:pages.${index}.path`);
    paths.add(path);
    const sections = (Array.isArray(page.sections) ? page.sections : [])
      .filter((type): type is SectionType => typeof type === 'string' && (sectionTypes as readonly string[]).includes(type))
      .filter((type, position, list) => list.indexOf(type) === position).slice(0, SITEMAP_LIMITS.sections);
    return { key, path, title, purpose, sections };
  });
  return { pages };
}

export interface SitemapIssue { key: string; message: string }

/** What still has to be filled in before the map can be accepted. The first page is always the home page «/». */
export function sitemapIssues(map: Sitemap): SitemapIssue[] {
  const issues: SitemapIssue[] = [];
  if (map.pages.length < SITEMAP_LIMITS.minPages) issues.push({ key: 'pages', message: tr('Добавьте хотя бы ещё одну страницу — иначе подойдёт одностраничный сайт.') });
  map.pages.forEach((page, index) => {
    if (!page.title) issues.push({ key: page.key, message: tr('У страницы {0} нет названия для меню.', [index + 1]) });
    if (!page.sections.length) issues.push({ key: page.key, message: tr('Выберите, какие блоки будут на странице «{0}».', [page.title || index + 1]) });
  });
  if (!map.pages.some((page) => page.sections.includes('contacts'))) issues.push({ key: 'contacts', message: tr('Добавьте блок «Контакты» хотя бы на одну страницу — посетитель должен понять, как с вами связаться.') });
  return issues;
}

/** A typical map from the goal and services, without AI. */
export function templateSitemap(brief: Brief | null, offer: Offer | null): Sitemap {
  const pages: SitemapPage[] = [
    { key: 'home', path: '/', title: tr('Главная'), purpose: tr('Коротко о вас и главная кнопка — чтобы посетитель сразу понял, куда он попал и что делать.'), sections: ['hero', 'benefits', 'cta'] },
    { key: 'services', path: '', title: tr('Услуги'), purpose: tr('Что вы делаете и сколько это стоит.'), sections: offer?.services.length ? ['services', 'cta'] : ['services'] },
    { key: 'about', path: '', title: tr('О нас'), purpose: tr('Кто вы, для кого работаете и как всё устроено.'), sections: ['about', 'steps'] },
    { key: 'faq', path: '', title: tr('Вопросы'), purpose: tr('Ответы на то, что клиенты спрашивают чаще всего.'), sections: ['faq'] },
    { key: 'contacts', path: '', title: tr('Контакты'), purpose: brief?.address ? tr('Адрес, часы работы и как связаться.') : tr('Как с вами связаться.'), sections: ['contacts'] },
  ];
  return normalizeSitemap({ pages });
}

/** Plain-language differences between two versions, for change notices. */
export function sitemapChanges(before: Sitemap, after: Sitemap): string[] {
  const changes: string[] = [];
  const old = new Map(before.pages.map((page) => [page.key, page]));
  const now = new Map(after.pages.map((page) => [page.key, page]));
  for (const page of after.pages) {
    const was = old.get(page.key);
    if (!was) changes.push(tr('Добавлена страница «{0}» ({1})', [page.title, page.path]));
    else if (was.path !== page.path || was.title !== page.title) changes.push(tr('Страница «{0}» теперь «{1}» ({2})', [was.title, page.title, page.path]));
    else if (was.sections.join() !== page.sections.join()) changes.push(tr('Изменены блоки страницы «{0}»', [page.title]));
  }
  for (const page of before.pages) if (!now.has(page.key)) changes.push(tr('Убрана страница «{0}»', [page.title]));
  if (!changes.length && before.pages.map((page) => page.key).join() !== after.pages.map((page) => page.key).join()) changes.push(tr('Изменён порядок страниц в меню'));
  return changes;
}
