// «Расписание и запись»: typed artifact, validation, template and deterministic availability (online booking route).
import { ArtifactValidationError, type Offer } from './artifacts.js';

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;
export const SLOT_STEPS = [15, 30, 60] as const;
export const TIMEZONES = [
  { id: 'Asia/Almaty', label: 'Казахстан (UTC+5)' },
  { id: 'Asia/Tashkent', label: 'Узбекистан (UTC+5)' },
  { id: 'Asia/Bishkek', label: 'Кыргызстан (UTC+6)' },
  { id: 'Europe/Moscow', label: 'Москва (UTC+3)' },
] as const;

export interface WorkHours { from: string; to: string }
export interface ScheduleService { name: string; minutes: number }
export interface ScheduleMaster {
  key: string; name: string;
  /** Service names this master does; empty means every service. */
  services: string[];
  /** Monday first; null is a day off. */
  week: Array<WorkHours | null>;
}
export interface ScheduleRules { slotStep: number; minNoticeHours: number; horizonDays: number; cancelHours: number }
export interface Schedule { timezone: string; services: ScheduleService[]; masters: ScheduleMaster[]; rules: ScheduleRules }

export const defaultRules: ScheduleRules = { slotStep: 30, minNoticeHours: 2, horizonDays: 14, cancelHours: 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`);
  const trimmed = value.replace(/[\u0000-\u001f]/g, '').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return trimmed;
}
function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  return value;
}
const minutesOfDay = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function hhmm(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  return value;
}

export function normalizeSchedule(raw: unknown): Schedule {
  if (!isRecord(raw) || !Array.isArray(raw.services) || !Array.isArray(raw.masters) || !isRecord(raw.rules)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const timezone = typeof raw.timezone === 'string' && TIMEZONES.some((zone) => zone.id === raw.timezone) ? raw.timezone : null;
  if (!timezone) throw new ArtifactValidationError('FIELD_INVALID:timezone');
  if (raw.services.length > 12) throw new ArtifactValidationError('FIELD_TOO_MANY:services');
  const services = raw.services.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:services.${index}`);
    const minutes = whole(item.minutes, `services.${index}.minutes`, 10, 480);
    if (minutes % 5) throw new ArtifactValidationError(`FIELD_INVALID:services.${index}.minutes`);
    return { name: text(item.name, `services.${index}.name`, 80), minutes };
  });
  if (new Set(services.map((service) => service.name.toLowerCase())).size !== services.length) throw new ArtifactValidationError('FIELD_DUPLICATE:services');
  if (raw.masters.length > 10) throw new ArtifactValidationError('FIELD_TOO_MANY:masters');
  const keys = new Set<string>();
  const masters = raw.masters.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.week) || item.week.length !== 7 || !Array.isArray(item.services)) throw new ArtifactValidationError(`FIELD_INVALID:masters.${index}`);
    const key = typeof item.key === 'string' && /^[a-z0-9]{2,12}$/.test(item.key) ? item.key : null;
    if (!key || keys.has(key)) throw new ArtifactValidationError(`FIELD_INVALID:masters.${index}.key`);
    keys.add(key);
    const week = item.week.map((day, dayIndex) => {
      if (day === null) return null;
      if (!isRecord(day)) throw new ArtifactValidationError(`FIELD_INVALID:masters.${index}.week.${dayIndex}`);
      const from = hhmm(day.from, `masters.${index}.week.${dayIndex}.from`);
      const to = hhmm(day.to, `masters.${index}.week.${dayIndex}.to`);
      if (minutesOfDay(to) <= minutesOfDay(from)) throw new ArtifactValidationError(`FIELD_INVALID:masters.${index}.week.${dayIndex}`);
      return { from, to };
    });
    const names = item.services.map((name, serviceIndex) => text(name, `masters.${index}.services.${serviceIndex}`, 80));
    return { key, name: text(item.name, `masters.${index}.name`, 60), services: [...new Set(names)].filter((name) => services.some((service) => service.name === name)), week };
  });
  const rules = {
    slotStep: whole(raw.rules.slotStep, 'rules.slotStep', 15, 60),
    minNoticeHours: whole(raw.rules.minNoticeHours, 'rules.minNoticeHours', 0, 72),
    horizonDays: whole(raw.rules.horizonDays, 'rules.horizonDays', 1, 60),
    cancelHours: whole(raw.rules.cancelHours, 'rules.cancelHours', 0, 72),
  };
  if (!SLOT_STEPS.includes(rules.slotStep as 15)) throw new ArtifactValidationError('FIELD_INVALID:rules.slotStep');
  return { timezone, services, masters, rules };
}

export function scheduleIssues(schedule: Schedule): Array<{ key: string; message: string }> {
  const issues: Array<{ key: string; message: string }> = [];
  if (schedule.services.length === 0) issues.push({ key: 'services', message: 'Укажите хотя бы одну услугу для записи и её длительность.' });
  if (schedule.masters.length === 0) issues.push({ key: 'masters', message: 'Добавьте хотя бы одного мастера.' });
  for (const master of schedule.masters) {
    if (master.week.every((day) => day === null)) issues.push({ key: 'masters', message: `У мастера «${master.name}» нет рабочих дней.` });
    const longest = Math.max(0, ...doable(schedule, master).map((service) => service.minutes));
    const longestDay = Math.max(0, ...master.week.map((day) => (day ? minutesOfDay(day.to) - minutesOfDay(day.from) : 0)));
    if (longest > longestDay && longestDay > 0) issues.push({ key: 'masters', message: `У мастера «${master.name}» рабочий день короче самой длинной услуги — на неё нельзя будет записаться.` });
  }
  for (const service of schedule.services) {
    if (!schedule.masters.some((master) => doable(schedule, master).includes(service))) issues.push({ key: 'services', message: `Услугу «${service.name}» не делает ни один мастер.` });
  }
  return issues;
}

/** Services a master does (every service when the list is empty). */
export function doable(schedule: Schedule, master: ScheduleMaster): ScheduleService[] {
  return master.services.length ? schedule.services.filter((service) => master.services.includes(service.name)) : schedule.services;
}

/** Durations are not invented: a service gets 60 minutes until the owner sets its real length. */
export function templateSchedule(offer: Offer | null): Schedule {
  const workday = { from: '10:00', to: '19:00' };
  return {
    timezone: 'Asia/Almaty',
    services: (offer?.services ?? []).slice(0, 12).map((service) => ({ name: service.name, minutes: 60 })),
    masters: [{ key: 'm1', name: 'Мастер', services: [], week: [workday, workday, workday, workday, workday, { ...workday }, null] }],
    rules: { ...defaultRules },
  };
}

// --- Time zones without dependencies: offsets come from Intl for the given instant.
function zoned(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) };
}
function offsetMs(date: Date, timeZone: string): number {
  const p = zoned(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60_000) * 60_000;
}
/** UTC instant for a wall-clock time in the zone. */
export function zonedTime(day: string, minutes: number, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, date, 0, minutes);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}
/** Local calendar day (YYYY-MM-DD) of an instant in the zone. */
export function localDay(date: Date, timeZone: string): string {
  const p = zoned(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}
function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}
export function localClock(date: Date, timeZone: string): string {
  const p = zoned(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export interface Busy { masterKey: string; startsAt: Date; endsAt: Date }
export interface Slot { startsAt: Date; endsAt: Date; masterKeys: string[] }

/** Free start times for a service on one local day; masterKey null means any master who does the service. */
export function slotsFor(schedule: Schedule, serviceName: string, masterKey: string | null, day: string, busy: Busy[], now: Date): Slot[] {
  const service = schedule.services.find((item) => item.name === serviceName);
  if (!service) return [];
  const today = localDay(now, schedule.timezone);
  if (day < today || day > addDays(today, schedule.rules.horizonDays - 1)) return [];
  const earliest = now.getTime() + schedule.rules.minNoticeHours * 3_600_000;
  const byStart = new Map<number, Slot>();
  for (const master of schedule.masters) {
    if (masterKey && master.key !== masterKey) continue;
    if (!doable(schedule, master).includes(service)) continue;
    const hours = master.week[weekdayOf(day)];
    if (!hours) continue;
    const mine = busy.filter((item) => item.masterKey === master.key);
    for (let start = minutesOfDay(hours.from); start + service.minutes <= minutesOfDay(hours.to); start += schedule.rules.slotStep) {
      const startsAt = zonedTime(day, start, schedule.timezone);
      const endsAt = new Date(startsAt.getTime() + service.minutes * 60_000);
      if (startsAt.getTime() < earliest) continue;
      if (mine.some((item) => item.startsAt < endsAt && item.endsAt > startsAt)) continue;
      const slot = byStart.get(startsAt.getTime()) ?? { startsAt, endsAt, masterKeys: [] };
      slot.masterKeys.push(master.key);
      byStart.set(startsAt.getTime(), slot);
    }
  }
  return [...byStart.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Local days in the booking horizon that still have at least one free slot. */
export function openDays(schedule: Schedule, serviceName: string, masterKey: string | null, busy: Busy[], now: Date): Array<{ day: string; free: number }> {
  const today = localDay(now, schedule.timezone);
  const days: Array<{ day: string; free: number }> = [];
  for (let index = 0; index < schedule.rules.horizonDays; index += 1) {
    const day = addDays(today, index);
    const free = slotsFor(schedule, serviceName, masterKey, day, busy, now).length;
    if (free) days.push({ day, free });
  }
  return days;
}

export function dayLabel(day: string): string {
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${WEEKDAYS[weekdayOf(day)]}, ${date} ${months[month - 1]}`;
}

/** What a published booking page needs: the accepted schedule plus prices from the offer. */
export interface BookingConfig { schedule: Schedule; prices: Record<string, string | null> }
