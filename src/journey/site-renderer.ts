// Deterministic renderer: typed brief/content/design -> one self-contained, script-free HTML page.
import type { Brief, ContentArtifact, DesignArtifact, Offer, SiteMeta } from './artifacts.js';

export interface Palette { id: string; label: string; hint: string; background: string; surface: string; text: string; muted: string; accent: string; accentText: string }
export interface FontPreset { id: string; label: string; hint: string; stack: string; headingWeight: number }

export const palettes: Palette[] = [
  { id: 'forest', label: 'Лес', hint: 'Спокойный зелёный: природа, здоровье, уют.', background: '#f7f8f4', surface: '#ffffff', text: '#17251f', muted: '#4f5f57', accent: '#255b42', accentText: '#ffffff' },
  { id: 'ocean', label: 'Океан', hint: 'Надёжный синий: услуги, сервис, финансы.', background: '#f4f7fb', surface: '#ffffff', text: '#10213a', muted: '#4a5a70', accent: '#1d4ed8', accentText: '#ffffff' },
  { id: 'sunset', label: 'Закат', hint: 'Тёплый и аппетитный: еда, праздники, дети.', background: '#fff8f2', surface: '#ffffff', text: '#2b1a12', muted: '#6b4f40', accent: '#b4471d', accentText: '#ffffff' },
  { id: 'graphite', label: 'Графит', hint: 'Строгий и деловой: юристы, IT, производство.', background: '#f5f5f4', surface: '#ffffff', text: '#1c1917', muted: '#57534e', accent: '#1c1917', accentText: '#ffffff' },
  { id: 'berry', label: 'Ягода', hint: 'Нежный и яркий: красота, мода, творчество.', background: '#fdf4f8', surface: '#ffffff', text: '#2e1020', muted: '#6b4459', accent: '#9d174d', accentText: '#ffffff' },
];

export const fonts: FontPreset[] = [
  { id: 'modern', label: 'Современный', hint: 'Чистый и универсальный.', stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', headingWeight: 800 },
  { id: 'classic', label: 'Классический', hint: 'С засечками, солидно и элегантно.', stack: 'Georgia, "Times New Roman", "PT Serif", serif', headingWeight: 700 },
  { id: 'friendly', label: 'Дружелюбный', hint: 'Мягкий и округлый.', stack: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif', headingWeight: 700 },
];

export const corners = [
  { id: 'rounded', label: 'Скруглённые', hint: 'Мягкие формы.' },
  { id: 'sharp', label: 'Прямые', hint: 'Строгие формы.' },
] as const;

export const heroLayouts = [
  { id: 'centered', label: 'По центру', hint: 'Заголовок и кнопка по центру экрана.' },
  { id: 'left', label: 'Слева', hint: 'Текст выровнен по левому краю.' },
] as const;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function paragraphs(text: string): string {
  return text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
}

export interface ContactLinks { phone: string | null; messenger: string | null; messengerLabel: string | null; email: string | null }

export function contactLinks(brief: Brief): ContactLinks {
  const digits = (brief.phone ?? '').replace(/[^\d+]/g, '');
  const phone = /^\+?\d{6,15}$/.test(digits) ? `tel:${digits}` : null;
  let messenger: string | null = null;
  let messengerLabel: string | null = null;
  const raw = (brief.messenger ?? '').trim();
  const whatsapp = raw.match(/^(?:wa:|whatsapp:?\s*)?\+?(\d{6,15})$/i);
  const telegram = raw.match(/^(?:https?:\/\/t\.me\/|@)?([a-zA-Z][a-zA-Z0-9_]{4,31})$/);
  if (/^(?:wa:|whatsapp)/i.test(raw) && whatsapp) { messenger = `https://wa.me/${whatsapp[1]}`; messengerLabel = 'WhatsApp'; }
  else if (telegram) { messenger = `https://t.me/${telegram[1]}`; messengerLabel = 'Telegram'; }
  else if (whatsapp) { messenger = `https://wa.me/${whatsapp[1]}`; messengerLabel = 'WhatsApp'; }
  const email = brief.email && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(brief.email) ? `mailto:${brief.email}` : null;
  return { phone, messenger, messengerLabel, email };
}

export function primaryActionHref(brief: Brief): string | null {
  const links = contactLinks(brief);
  switch (brief.mainAction) {
    case 'call': return links.phone;
    case 'message': return links.messenger;
    case 'email': return links.email;
    case 'visit': return '#contacts';
    case 'form': return '#request';
    default: return null;
  }
}

/** WCAG relative-luminance contrast ratio. */
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const value = hex.replace('#', '');
    const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export interface ImageInfo { alt: string; width: number; height: number }
export interface RenderInput {
  brief: Brief; offer: Offer | null; content: ContentArtifact; design: DesignArtifact; locale: string; draft: boolean;
  /** Photos referenced by content sections; rendered as /img/<id>.webp. */
  images?: Record<string, ImageInfo>;
}

function photo(id: string | null, images: Record<string, ImageInfo> | undefined, eager: boolean): string {
  const image = id ? images?.[id] : undefined;
  if (!id || !image) return '';
  return `<img class="photo" src="/img/${escapeHtml(id)}.webp" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
}

export function renderSite(input: RenderInput): string {
  const { brief, offer, content, design } = input;
  const palette = palettes.find((item) => item.id === design.palette) ?? palettes[0];
  const font = fonts.find((item) => item.id === design.font) ?? fonts[0];
  const radius = design.corners === 'sharp' ? '2px' : '16px';
  const align = design.heroLayout === 'left' ? 'left' : 'center';
  const actionHref = primaryActionHref(brief);
  const links = contactLinks(brief);

  const sectionHtml = content.sections.map((section) => {
    const button = section.buttonLabel && actionHref
      ? `<a class="button" href="${escapeHtml(actionHref)}"${actionHref.startsWith('http') ? ' rel="noopener" target="_blank"' : ''}>${escapeHtml(section.buttonLabel)}</a>` : '';
    const items = section.items?.length
      ? `<ul class="items">${section.items.map((item) => `<li><h3>${escapeHtml(item.title)}</h3>${item.text ? paragraphs(item.text) : ''}</li>`).join('')}</ul>` : '';
    if (section.type === 'hero') {
      const brand = section.title.trim() === brief.businessName.trim() ? '' : `<p class="brand">${escapeHtml(brief.businessName)}</p>`;
      return `<header class="hero" id="${escapeHtml(section.key)}"><div class="wrap">${brand}<h1>${escapeHtml(section.title)}</h1>${paragraphs(section.text)}${button}${photo(section.imageId, input.images, true)}</div></header>`;
    }
    if (section.type === 'contacts') {
      const rows: string[] = [];
      if (links.phone && brief.phone) rows.push(`<li><span>Телефон</span><a href="${escapeHtml(links.phone)}">${escapeHtml(brief.phone)}</a></li>`);
      if (links.messenger && links.messengerLabel) rows.push(`<li><span>${links.messengerLabel}</span><a href="${escapeHtml(links.messenger)}" rel="noopener" target="_blank">${escapeHtml(brief.messenger ?? '')}</a></li>`);
      if (links.email && brief.email) rows.push(`<li><span>Email</span><a href="${escapeHtml(links.email)}">${escapeHtml(brief.email)}</a></li>`);
      if (brief.address) rows.push(`<li><span>Адрес</span><strong>${escapeHtml(brief.address)}${brief.city ? `, ${escapeHtml(brief.city)}` : ''}</strong></li>`);
      if (offer?.hours) rows.push(`<li><span>Часы работы</span><strong>${escapeHtml(offer.hours)}</strong></li>`);
      const form = brief.mainAction === 'form' ? leadForm() : '';
      return `<section class="section contacts" id="contacts"><div class="wrap"><h2>${escapeHtml(section.title)}</h2>${paragraphs(section.text)}${form}${rows.length ? `<ul class="contact-list">${rows.join('')}</ul>` : ''}${form ? '' : button}</div></section>`;
    }
    return `<section class="section ${escapeHtml(section.type)}" id="${escapeHtml(section.key)}"><div class="wrap"><h2>${escapeHtml(section.title)}</h2>${photo(section.imageId, input.images, false)}${paragraphs(section.text)}${items}${button}</div></section>`;
  }).join('\n');

  const css = `:root{--bg:${palette.background};--surface:${palette.surface};--text:${palette.text};--muted:${palette.muted};--accent:${palette.accent};--accent-text:${palette.accentText};--radius:${radius}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font-family:${font.stack};font-size:17px;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}h1,h2,h3{line-height:1.2;font-weight:${font.headingWeight};margin:0 0 12px}h1{font-size:clamp(32px,8vw,52px)}h2{font-size:clamp(24px,5.5vw,34px)}h3{font-size:19px}
p{margin:0 0 12px;color:var(--muted)}.hero{padding:64px 0 56px;text-align:${align}}.hero p{font-size:19px}.brand{font-weight:700;color:var(--accent)!important;font-size:15px!important;letter-spacing:.04em;text-transform:uppercase}
.section{padding:44px 0;border-top:1px solid rgba(0,0,0,.07)}.section:nth-of-type(even){background:var(--surface)}
.items{list-style:none;padding:0;margin:20px 0 0;display:grid;gap:14px}.items li{background:var(--surface);border:1px solid rgba(0,0,0,.08);border-radius:var(--radius);padding:18px}.items li p{margin:0}
.button{display:inline-block;margin-top:12px;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:700;padding:15px 24px;border-radius:var(--radius);min-height:48px}
.button:focus-visible,a:focus-visible{outline:3px solid var(--text);outline-offset:3px}
.lead-form{display:grid;gap:14px;margin:18px 0;background:var(--surface);border:1px solid rgba(0,0,0,.08);border-radius:var(--radius);padding:18px}.lead-form label{display:grid;gap:6px;font-weight:700;font-size:15px}
.lead-form input,.lead-form textarea{font:inherit;font-size:16px;padding:12px;border:1px solid rgba(0,0,0,.25);border-radius:calc(var(--radius) / 2);background:#fff;color:#111}.lead-form textarea{min-height:90px}
.lead-form .consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px;color:var(--muted)}.lead-form .consent input{width:22px;height:22px;flex:none;margin-top:2px}.lead-form .consent a{color:var(--accent)}
.lead-form .hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.lead-form button{border:0;cursor:pointer;font:inherit;font-weight:700}
.contact-list{list-style:none;padding:0;margin:16px 0;display:grid;gap:10px}.contact-list li{display:flex;flex-direction:column}.contact-list span{font-size:14px;color:var(--muted)}.contact-list a{color:var(--accent);font-weight:700}
.photo{display:block;width:100%;height:auto;border-radius:var(--radius);margin:18px 0 6px;background:var(--surface)}.hero .photo{margin-top:28px}
footer{padding:28px 0;color:var(--muted);font-size:14px;text-align:center}.draft{background:#fff3cd;color:#5c4400;text-align:center;font-size:14px;padding:8px}
@media(min-width:720px){.items{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

  const lang = ['ru', 'kk', 'en'].includes(input.locale) ? input.locale : 'ru';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${pageCsp(input.brief.mainAction === 'form')}">
<title>${escapeHtml(content.seo.title)}</title>
<meta name="description" content="${escapeHtml(content.seo.description)}">
<style>${css}</style>
</head>
<body>
${input.draft ? '<div class="draft">Черновик — не опубликован</div>\n' : ''}<main>
${sectionHtml}
</main>
<footer>© ${escapeHtml(brief.businessName)}</footer>
</body>
</html>
`;
}

/** Same-origin form posts are allowed only when the page has a lead form; it posts to the BuildPath sites server. */
export function pageCsp(hasForm: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action ${hasForm ? "'self'" : "'none'"}`;
}

export const LEAD_FORM_PATH = '/__forms/lead';

function leadForm(): string {
  return `<form id="request" class="lead-form" method="post" action="${LEAD_FORM_PATH}">
<label>Ваше имя<input name="name" required maxlength="80" autocomplete="name"></label>
<label>Телефон или мессенджер<input name="contact" required maxlength="120" autocomplete="tel"></label>
<label>Сообщение (необязательно)<textarea name="message" maxlength="1000"></textarea></label>
<div class="hp" aria-hidden="true"><label>Не заполняйте это поле<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>Согласен(на) на обработку моих данных, чтобы со мной связались по заявке. <a href="/privacy">Как используются данные</a></span></label>
<button class="button" type="submit">Отправить заявку</button>
</form>`;
}

export function siteMeta(input: RenderInput): SiteMeta {
  const palette = palettes.find((item) => item.id === input.design.palette) ?? palettes[0];
  const font = fonts.find((item) => item.id === input.design.font) ?? fonts[0];
  const ownerContacts: SiteMeta['ownerContacts'] = [];
  if (input.brief.phone) ownerContacts.push({ label: 'Телефон', value: input.brief.phone });
  if (input.brief.messenger) ownerContacts.push({ label: 'Мессенджер', value: input.brief.messenger });
  if (input.brief.email) ownerContacts.push({ label: 'Email', value: input.brief.email });
  if (input.brief.address) ownerContacts.push({ label: 'Адрес', value: input.brief.address });
  return {
    businessName: input.brief.businessName, locale: ['ru', 'kk', 'en'].includes(input.locale) ? input.locale : 'ru', hasForm: input.brief.mainAction === 'form',
    theme: { background: palette.background, text: palette.text, muted: palette.muted, accent: palette.accent, accentText: palette.accentText, font: font.stack, radius: input.design.corners === 'sharp' ? '2px' : '16px' },
    ownerContacts,
  };
}

export interface SiteCheck { id: string; status: 'passed' | 'warning' | 'failed'; title: string; details: string; required: boolean }

export function checkSite(input: RenderInput): SiteCheck[] {
  const { brief, content, design } = input;
  const checks: SiteCheck[] = [];
  const add = (id: string, required: boolean, ok: boolean, title: string, passText: string, failText: string, warnOnly = false) => {
    checks.push({ id, required, title, status: ok ? 'passed' : warnOnly ? 'warning' : 'failed', details: ok ? passText : failText });
  };
  const hero = content.sections.find((section) => section.type === 'hero');
  add('hero', true, Boolean(hero?.title), 'Первый экран', 'Есть заголовок первого экрана.', 'Нет первого экрана с заголовком. Добавьте блок «Первый экран» на этапе текстов.');
  const href = primaryActionHref(brief);
  add('main-action', true, Boolean(href), 'Главная кнопка работает', 'Кнопка ведёт по вашему контакту.',
    'Для выбранного главного действия не указан корректный контакт. Проверьте телефон, мессенджер или email на этапе «Цель сайта».');
  add('button-present', true, content.sections.some((section) => section.buttonLabel), 'Кнопка видна посетителю', 'На странице есть кнопка главного действия.', 'Ни в одном блоке нет кнопки. Добавьте текст кнопки в первый экран.');
  if (brief.mainAction === 'form') {
    const ownerContact = Boolean(brief.phone || brief.email || brief.messenger || brief.address);
    add('form-privacy', true, ownerContact, 'Форма заявки и согласие', 'Форма просит согласие на обработку данных и ведёт на страницу о данных с вашими контактами.',
      'Для формы заявки нужен хотя бы один ваш контакт (телефон, email или мессенджер) — он будет на странице о данных, чтобы посетитель мог попросить удалить свои данные.');
  }
  add('contacts', true, content.sections.some((section) => section.type === 'contacts'), 'Контакты', 'Есть блок контактов.', 'Нет блока контактов. Посетитель не поймёт, как с вами связаться.');
  const placeholders = JSON.stringify(content).match(/\[(?:укажите|заполните|добавьте)[^\]]*\]/gi) ?? [];
  add('placeholders', true, placeholders.length === 0, 'Нет пустых мест', 'Все места в текстах заполнены.',
    `Остались незаполненные места: ${placeholders.slice(0, 3).join(', ')}. Замените их на этапе «Структура и тексты».`);
  add('titles', true, content.sections.every((section) => section.title.trim().length > 0), 'У каждого блока есть заголовок', 'У всех блоков есть заголовки.', 'У некоторых блоков нет заголовка — это мешает читать с телефона и для скринридеров.');
  add('seo-title', false, content.seo.title.length >= 10 && content.seo.title.length <= 70, 'Заголовок для поисковиков', 'Длина 10–70 символов.', 'Сделайте заголовок для поисковиков длиной 10–70 символов.', true);
  add('seo-description', false, content.seo.description.length >= 50 && content.seo.description.length <= 160, 'Описание для поисковиков', 'Длина 50–160 символов.', 'Сделайте описание длиной 50–160 символов — так оно лучше показывается в поиске.', true);
  const palette = palettes.find((item) => item.id === design.palette) ?? palettes[0];
  const textContrast = contrastRatio(palette.text, palette.background);
  const mutedContrast = contrastRatio(palette.muted, palette.background);
  const buttonContrast = contrastRatio(palette.accentText, palette.accent);
  add('contrast', true, textContrast >= 4.5 && mutedContrast >= 4.5 && buttonContrast >= 4.5, 'Контраст текста',
    `Текст и кнопки читаются: контраст не ниже 4,5:1 (WCAG AA).`, 'Контраст ниже 4,5:1 — текст будет плохо читаться.');
  const used = content.sections.map((section) => section.imageId).filter((id): id is string => Boolean(id));
  if (used.length) {
    const missing = used.filter((id) => !input.images?.[id]);
    add('photos', true, missing.length === 0, 'Фото на месте', 'Все выбранные фото найдены.', 'Некоторые выбранные фото удалены. Выберите другие на этапе «Структура и тексты».');
    const noAlt = used.filter((id) => input.images?.[id] && !input.images[id].alt.trim());
    add('photo-alt', false, noAlt.length === 0, 'Описание фото', 'У всех фото есть описание для незрячих и поисковиков.', `У ${noAlt.length} фото нет описания. Добавьте короткое описание — что изображено.`, true);
  }
  const longHero = (hero?.text.length ?? 0) > 320;
  add('hero-length', false, !longHero, 'Первый экран короткий', 'Текст первого экрана помещается на экран телефона.', 'Текст первого экрана длинный — на телефоне кнопка уйдёт вниз. Сократите до 2 предложений.', true);
  return checks;
}
