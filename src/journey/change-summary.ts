// Deterministic, plain-language description of what changed between two accepted versions of a stage.
import { processChanges, type BusinessProcess } from './process.js';
import { sitemapChanges, type Sitemap } from './sitemap.js';
import { tr } from '../i18n/i18n.js';
import { stageDefinitions, type StageKey } from './catalog.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value));
const short = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const designLabels: Record<string, string> = { palette: 'Цвета', font: 'Шрифт', corners: 'Углы', heroLayout: 'Первый экран' };

function fieldChanges(key: StageKey, before: Json, after: Json): string[] {
  const lines: string[] = [];
  const fields = stageDefinitions[key].fields ?? [];
  for (const field of fields) {
    if (field.kind === 'list') continue;
    const was = text(before[field.key]);
    const now = text(after[field.key]);
    if (was === now) continue;
    const label = (value: string) => field.options?.find((option) => option.value === value)?.label ?? value;
    if (!was) lines.push(tr("{0}: добавлено «{1}»", [field.label, short(label(now))]));
    else if (!now) lines.push(tr("{0}: убрано", [field.label]));
    else lines.push(`${field.label}: «${short(label(was))}» → «${short(label(now))}»`);
  }
  return lines;
}

function serviceChanges(before: Json, after: Json): string[] {
  const lines: string[] = [];
  const was = new Map(list(before.services).map((item) => [text(item.name), item]));
  const now = new Map(list(after.services).map((item) => [text(item.name), item]));
  for (const [name, item] of now) {
    const old = was.get(name);
    if (!old) { lines.push(tr("Добавлена услуга «{0}»", [short(name)])); continue; }
    if (text(old.price) !== text(item.price)) lines.push(tr("«{0}»: цена {1} → {2}", [short(name), text(old.price) || 'не указана', text(item.price) || 'не указана']));
    if (text(old.description) !== text(item.description)) lines.push(tr("«{0}»: изменено описание", [short(name)]));
  }
  for (const name of was.keys()) if (!now.has(name)) lines.push(tr("Убрана услуга «{0}»", [short(name)]));
  if (text(before.hours) !== text(after.hours)) lines.push(tr("Часы работы: «{0}» → «{1}»", [short(text(before.hours)) || '—', short(text(after.hours)) || '—']));
  return lines;
}

function contentChanges(before: Json, after: Json): string[] {
  const lines: string[] = [];
  const was = new Map(list(before.sections).map((item) => [text(item.key), item]));
  const now = new Map(list(after.sections).map((item) => [text(item.key), item]));
  for (const [key, item] of now) {
    const old = was.get(key);
    const title = short(text(item.title) || key);
    if (!old) lines.push(tr("Добавлен раздел «{0}»", [title]));
    else if (JSON.stringify(old) !== JSON.stringify(item)) lines.push(tr("Изменён раздел «{0}»", [title]));
  }
  for (const [key, item] of was) if (!now.has(key)) lines.push(tr("Убран раздел «{0}»", [short(text(item.title) || key)]));
  const order = (sections: Map<string, Json>) => [...sections.keys()].filter((key) => was.has(key) && now.has(key)).join();
  if (order(was) !== order(now)) lines.push('Изменён порядок разделов');
  if (JSON.stringify(before.seo) !== JSON.stringify(after.seo)) lines.push('Изменены заголовок и описание для поиска');
  return lines;
}

function designChanges(before: Json, after: Json): string[] {
  return Object.keys(designLabels).filter((key) => text(before[key]) !== text(after[key]))
    .map((key) => `${designLabels[key]}: ${text(before[key]) || '—'} → ${text(after[key]) || '—'}`);
}

function scheduleChanges(before: Json, after: Json): string[] {
  const lines: string[] = [];
  const list = (value: unknown) => (Array.isArray(value) ? value as Json[] : []);
  const services = (value: Json) => new Map(list(value.services).map((item) => [text(item.name), Number(item.minutes)]));
  const was = services(before); const now = services(after);
  for (const [name, minutes] of now) {
    if (!was.has(name)) lines.push(tr("Для записи добавлена услуга «{0}» ({1} мин)", [name, minutes]));
    else if (was.get(name) !== minutes) lines.push(tr("«{0}»: длительность {1} → {2} мин", [name, was.get(name), minutes]));
  }
  for (const name of was.keys()) if (!now.has(name)) lines.push(tr("Запись на «{0}» убрана", [name]));
  const masters = (value: Json) => new Map(list(value.masters).map((item) => [text(item.key), item]));
  const mb = masters(before); const ma = masters(after);
  for (const [key, master] of ma) {
    const old = mb.get(key);
    if (!old) lines.push(tr("Добавлен мастер «{0}»", [text(master.name)]));
    else if (JSON.stringify(old) !== JSON.stringify(master)) lines.push(tr("Изменены услуги или часы мастера «{0}»", [text(master.name)]));
  }
  for (const [key, master] of mb) if (!ma.has(key)) lines.push(tr("Мастер «{0}» убран из записи", [text(master.name)]));
  if (JSON.stringify(before.rules) !== JSON.stringify(after.rules) || before.timezone !== after.timezone) lines.push('Изменены правила записи');
  return lines;
}

/** Up to 12 lines; an empty list means the accepted content did not change. */
export function describeChanges(key: StageKey, beforeRaw: unknown, afterRaw: unknown): string[] {
  const before = record(beforeRaw);
  const after = record(afterRaw);
  const type = stageDefinitions[key].artifactType;
  const lines = type === 'offer' ? serviceChanges(before, after)
    : type === 'content' ? contentChanges(before, after)
      : type === 'design' ? designChanges(before, after)
        : type === 'schedule' ? scheduleChanges(before, after)
          : type === 'process' ? processChanges(beforeRaw as BusinessProcess, afterRaw as BusinessProcess)
          : type === 'sitemap' ? sitemapChanges(beforeRaw as Sitemap, afterRaw as Sitemap)
          : type === 'techplan' ? [
            ...(JSON.stringify({ ...before, ownerNotes: null }) !== JSON.stringify({ ...after, ownerNotes: null }) ? ['План обновлён по новым данным'] : []),
            ...(before.ownerNotes !== after.ownerNotes ? ['Изменены заметки владельца'] : []),
          ]
        : fieldChanges(key, before, after);
  if (!lines.length && JSON.stringify(beforeRaw) !== JSON.stringify(afterRaw)) lines.push('Мелкие изменения');
  return lines.length > 12 ? [...lines.slice(0, 11), tr("И ещё изменений: {0}", [lines.length - 11])] : lines;
}
