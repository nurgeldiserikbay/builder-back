import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArtifactValidationError, completenessIssues, importContentText, normalizeContent, pageIssues, templateContent, type Brief, type Offer } from './artifacts.js';
import { normalizeSitemap, pathFor, sitemapChanges, sitemapIssues, templateSitemap } from './sitemap.js';
import { checkSite, renderPages, renderSite } from './site-renderer.js';
import { buildTechPlan } from './techplan.js';
import { templateProcess } from './process.js';
import { projectTypes, routeInputs } from './catalog.js';

const brief: Brief = { businessName: 'Улыбка', whatYouDo: 'Стоматология в Алматы', audience: 'Семьи с детьми', city: 'Алматы', mainAction: 'visit', phone: '+7 701 000 00 00', messenger: null, email: null, address: 'Абая 10', tone: 'friendly' };
const offer: Offer = { services: [{ name: 'Лечение кариеса', description: null, price: 'от 15 000 ₸' }], hours: 'Пн–Сб 9–20' };
const design = { palette: 'ocean', font: 'modern', corners: 'rounded' as const, heroLayout: 'centered' as const };

describe('Карта сайта', () => {
  it('keeps the home page first, makes addresses from menu names and refuses platform addresses', () => {
    assert.equal(pathFor('Услуги и цены'), '/uslugi-i-tseny');
    const map = normalizeSitemap({ pages: [{ key: 'main', title: 'Главная', sections: ['hero', 'hero', 'nope'] }, { key: 'home', title: 'О нас', sections: ['about'] }] });
    assert.deepEqual(map.pages.map((page) => [page.key, page.path]), [['home', '/'], ['page-2', '/o-nas']]);
    assert.deepEqual(map.pages[0]!.sections, ['hero']);
    assert.throws(() => normalizeSitemap({ pages: [{ title: 'Главная' }, { title: 'Запись', path: '/book' }] }), (error: unknown) => error instanceof ArtifactValidationError && error.code === 'PATH_RESERVED:pages.1.path');
    assert.throws(() => normalizeSitemap({ pages: [{ title: 'Главная' }, { title: 'A', path: '/a' }, { title: 'B', path: '/a' }] }), /PATH_DUPLICATE/);
  });

  it('asks for at least two pages, menu names, blocks and contacts', () => {
    const issues = sitemapIssues(normalizeSitemap({ pages: [{ title: '', sections: [] }] })).map((issue) => issue.key);
    assert.deepEqual(issues, ['pages', 'home', 'home', 'contacts']);
    assert.deepEqual(sitemapIssues(templateSitemap(brief, offer)), []);
  });

  it('is part of the multi-page route and feeds texts, architecture and the build', () => {
    const route = projectTypes.multipage.stages;
    assert.deepEqual(route, ['goal', 'process', 'offer', 'sitemap', 'techplan', 'content', 'design', 'build']);
    assert.deepEqual(routeInputs(route, 'content'), ['goal', 'offer', 'sitemap']);
    assert.deepEqual(routeInputs(route, 'techplan'), ['goal', 'process', 'sitemap']);
    assert.ok(routeInputs(route, 'build').includes('sitemap'));
    assert.ok(!routeInputs(projectTypes.landing.stages, 'content').includes('sitemap'));
  });

  it('describes changes between versions', () => {
    const before = templateSitemap(brief, offer);
    const after = normalizeSitemap({ pages: [...before.pages.filter((page) => page.key !== 'faq'), { key: 'prices', title: 'Цены', sections: ['services'] }] });
    assert.deepEqual(sitemapChanges(before, after), ['Добавлена страница «Цены» (/tseny)', 'Убрана страница «Вопросы»']);
  });
});

describe('Multi-page site', () => {
  const map = templateSitemap(brief, offer);
  const content = templateContent(brief, offer, map);

  it('writes a draft page by page and checks it against the map', () => {
    assert.deepEqual([...new Set(content.sections.map((section) => section.page))], ['home', 'services', 'about', 'faq', 'contacts']);
    assert.equal(content.sections[0]!.type, 'hero');
    assert.equal(content.pageSeo?.length, 4);
    const normalized = normalizeContent(JSON.parse(JSON.stringify(content)));
    assert.deepEqual(normalized, content);
    assert.deepEqual(pageIssues(content, map), []);
    const broken = { ...content, sections: content.sections.filter((section) => section.page !== 'about').map((section) => (section.page === 'faq' ? { ...section, page: 'gone' } : section)) };
    assert.deepEqual(pageIssues(broken, map).map((issue) => issue.key), ['about', 'faq', ...broken.sections.filter((section) => section.page === 'gone').map((section) => section.key)]);
    // Template FAQ answers are placeholders the owner has to fill in.
    assert.ok(completenessIssues('content', content, { sitemap: map }).some((issue) => issue.key === 'faq-faq'));
  });

  it('imports pasted texts page by page: a block titled like a menu item starts that page', () => {
    const imported = importContentText('Улыбка\nСемейная стоматология\n\nПочему мы\nБез боли\n\nУслуги\nЛечение и гигиена\n\nКонтакты\nАбая 10', map);
    assert.deepEqual(imported.sections.map((section) => [section.type, section.page]), [['hero', 'home'], ['about', 'home'], ['services', 'services'], ['contacts', 'contacts']]);
    assert.equal(imported.pageSeo?.length, 4);
  });

  it('keeps single-page texts as they were', () => {
    const single = normalizeContent(templateContent(brief, offer));
    assert.ok(single.sections.every((section) => !('page' in section)) && !('pageSeo' in single));
  });

  it('renders every page with a shared menu, its own title and links across pages', () => {
    const pages = renderPages({ brief, offer, content, design, locale: 'ru', draft: false, sitemap: map });
    assert.deepEqual(pages.map((page) => page.path), ['/', '/uslugi', '/o-nas', '/voprosy', '/kontakty']);
    const services = pages[1]!.html;
    assert.match(services, /<title>Услуги — Улыбка<\/title>/);
    assert.match(services, /<a href="\/uslugi" aria-current="page">Услуги<\/a>/);
    assert.match(services, /<a href="\/kontakty">Контакты<\/a>/);
    assert.ok(!services.includes('<script'));
    // «Как нас найти» leads to the contacts block on the contacts page.
    assert.ok(pages[0]!.html.includes('href="/kontakty#contacts"'));
    assert.ok(pages[4]!.html.includes('href="#contacts"'));
    // A page without a first screen gets a heading with its name.
    assert.match(pages[2]!.html, /<header class="hero page-head">.*<h1>О нас<\/h1>/s);
    const preview = renderSite({ brief, offer, content, design, locale: 'ru', draft: true, sitemap: map }, 'about');
    assert.ok(preview.includes('<span aria-current="page">О нас</span>') && !preview.includes('href="/uslugi"'));
    const check = checkSite({ brief, offer, content, design, locale: 'ru', draft: false, sitemap: map }).find((item) => item.id === 'pages');
    assert.equal(check?.status, 'passed');
  });

  it('lists the pages in the architecture', () => {
    const plan = buildTechPlan({ projectType: 'multipage', brief, schedule: null, process: templateProcess('multipage', brief), sitemap: map }, null);
    assert.match(plan.summary, /из 5 страниц/);
    assert.deepEqual(plan.pages.map((page) => page.path), ['/', '/uslugi', '/o-nas', '/voprosy', '/kontakty', '/privacy', '/sitemap.xml']);
    const single = buildTechPlan({ projectType: 'landing', brief, schedule: null, process: null }, null);
    assert.match(single.summary, /одна страница/);
  });
});
