// Deterministic, plain-language description of what changed between two accepted versions of a stage.
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
    if (!was) lines.push(`${field.label}: добавлено «${short(label(now))}»`);
    else if (!now) lines.push(`${field.label}: убрано`);
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
    if (!old) { lines.push(`Добавлена услуга «${short(name)}»`); continue; }
    if (text(old.price) !== text(item.price)) lines.push(`«${short(name)}»: цена ${text(old.price) || 'не указана'} → ${text(item.price) || 'не указана'}`);
    if (text(old.description) !== text(item.description)) lines.push(`«${short(name)}»: изменено описание`);
  }
  for (const name of was.keys()) if (!now.has(name)) lines.push(`Убрана услуга «${short(name)}»`);
  if (text(before.hours) !== text(after.hours)) lines.push(`Часы работы: «${short(text(before.hours)) || '—'}» → «${short(text(after.hours)) || '—'}»`);
  return lines;
}

function contentChanges(before: Json, after: Json): string[] {
  const lines: string[] = [];
  const was = new Map(list(before.sections).map((item) => [text(item.key), item]));
  const now = new Map(list(after.sections).map((item) => [text(item.key), item]));
  for (const [key, item] of now) {
    const old = was.get(key);
    const title = short(text(item.title) || key);
    if (!old) lines.push(`Добавлен раздел «${title}»`);
    else if (JSON.stringify(old) !== JSON.stringify(item)) lines.push(`Изменён раздел «${title}»`);
  }
  for (const [key, item] of was) if (!now.has(key)) lines.push(`Убран раздел «${short(text(item.title) || key)}»`);
  const order = (sections: Map<string, Json>) => [...sections.keys()].filter((key) => was.has(key) && now.has(key)).join();
  if (order(was) !== order(now)) lines.push('Изменён порядок разделов');
  if (JSON.stringify(before.seo) !== JSON.stringify(after.seo)) lines.push('Изменены заголовок и описание для поиска');
  return lines;
}

function designChanges(before: Json, after: Json): string[] {
  return Object.keys(designLabels).filter((key) => text(before[key]) !== text(after[key]))
    .map((key) => `${designLabels[key]}: ${text(before[key]) || '—'} → ${text(after[key]) || '—'}`);
}

/** Up to 12 lines; an empty list means the accepted content did not change. */
export function describeChanges(key: StageKey, beforeRaw: unknown, afterRaw: unknown): string[] {
  const before = record(beforeRaw);
  const after = record(afterRaw);
  const type = stageDefinitions[key].artifactType;
  const lines = type === 'offer' ? serviceChanges(before, after)
    : type === 'content' ? contentChanges(before, after)
      : type === 'design' ? designChanges(before, after)
        : fieldChanges(key, before, after);
  if (!lines.length && JSON.stringify(beforeRaw) !== JSON.stringify(afterRaw)) lines.push('Мелкие изменения');
  return lines.length > 12 ? [...lines.slice(0, 11), `И ещё изменений: ${lines.length - 11}`] : lines;
}
