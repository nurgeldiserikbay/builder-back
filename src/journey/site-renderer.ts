// Deterministic renderer: typed brief/content/design -> one self-contained, script-free HTML page.
import type { Brief, ContentArtifact, DesignArtifact, Offer } from './artifacts.js';

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

export interface RenderInput { brief: Brief; offer: Offer | null; content: ContentArtifact; design: DesignArtifact; locale: string; draft: boolean }

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
      return `<header class="hero" id="${escapeHtml(section.key)}"><div class="wrap">${brand}<h1>${escapeHtml(section.title)}</h1>${paragraphs(section.text)}${button}</div></header>`;
    }
    if (section.type === 'contacts') {
      const rows: string[] = [];
      if (links.phone && brief.phone) rows.push(`<li><span>Телефон</span><a href="${escapeHtml(links.phone)}">${escapeHtml(brief.phone)}</a></li>`);
      if (links.messenger && links.messengerLabel) rows.push(`<li><span>${links.messengerLabel}</span><a href="${escapeHtml(links.messenger)}" rel="noopener" target="_blank">${escapeHtml(brief.messenger ?? '')}</a></li>`);
      if (links.email && brief.email) rows.push(`<li><span>Email</span><a href="${escapeHtml(links.email)}">${escapeHtml(brief.email)}</a></li>`);
      if (brief.address) rows.push(`<li><span>Адрес</span><strong>${escapeHtml(brief.address)}${brief.city ? `, ${escapeHtml(brief.city)}` : ''}</strong></li>`);
      if (offer?.hours) rows.push(`<li><span>Часы работы</span><strong>${escapeHtml(offer.hours)}</strong></li>`);
      return `<section class="section contacts" id="contacts"><div class="wrap"><h2>${escapeHtml(section.title)}</h2>${paragraphs(section.text)}${rows.length ? `<ul class="contact-list">${rows.join('')}</ul>` : ''}${button}</div></section>`;
    }
    return `<section class="section ${escapeHtml(section.type)}" id="${escapeHtml(section.key)}"><div class="wrap"><h2>${escapeHtml(section.title)}</h2>${paragraphs(section.text)}${items}${button}</div></section>`;
  }).join('\n');

  const css = `:root{--bg:${palette.background};--surface:${palette.surface};--text:${palette.text};--muted:${palette.muted};--accent:${palette.accent};--accent-text:${palette.accentText};--radius:${radius}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font-family:${font.stack};font-size:17px;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}h1,h2,h3{line-height:1.2;font-weight:${font.headingWeight};margin:0 0 12px}h1{font-size:clamp(32px,8vw,52px)}h2{font-size:clamp(24px,5.5vw,34px)}h3{font-size:19px}
p{margin:0 0 12px;color:var(--muted)}.hero{padding:64px 0 56px;text-align:${align}}.hero p{font-size:19px}.brand{font-weight:700;color:var(--accent)!important;font-size:15px!important;letter-spacing:.04em;text-transform:uppercase}
.section{padding:44px 0;border-top:1px solid rgba(0,0,0,.07)}.section:nth-of-type(even){background:var(--surface)}
.items{list-style:none;padding:0;margin:20px 0 0;display:grid;gap:14px}.items li{background:var(--surface);border:1px solid rgba(0,0,0,.08);border-radius:var(--radius);padding:18px}.items li p{margin:0}
.button{display:inline-block;margin-top:12px;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:700;padding:15px 24px;border-radius:var(--radius);min-height:48px}
.button:focus-visible,a:focus-visible{outline:3px solid var(--text);outline-offset:3px}
.contact-list{list-style:none;padding:0;margin:16px 0;display:grid;gap:10px}.contact-list li{display:flex;flex-direction:column}.contact-list span{font-size:14px;color:var(--muted)}.contact-list a{color:var(--accent);font-weight:700}
footer{padding:28px 0;color:var(--muted);font-size:14px;text-align:center}.draft{background:#fff3cd;color:#5c4400;text-align:center;font-size:14px;padding:8px}
@media(min-width:720px){.items{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

  const lang = ['ru', 'kk', 'en'].includes(input.locale) ? input.locale : 'ru';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
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
  const longHero = (hero?.text.length ?? 0) > 320;
  add('hero-length', false, !longHero, 'Первый экран короткий', 'Текст первого экрана помещается на экран телефона.', 'Текст первого экрана длинный — на телефоне кнопка уйдёт вниз. Сократите до 2 предложений.', true);
  return checks;
}
