// Module branches (PRODUCT_LIFECYCLE §4.9): a module's code is merged into the project's main line when its stage is
// accepted. A three-way merge of whole projects: the common start (base), the main line now (ours) and the module (theirs).
// Text files merge line by line (diff3); JSON files key by key, so two modules that each add a dependency or a script to
// package.json do not collide. What both sides changed differently is a conflict and is never decided by guessing.
import type { AgentFile } from './agent-loop.js';

export type MergeConflictKind = 'both_changed' | 'changed_and_deleted' | 'too_large';
export interface MergeConflict { path: string; kind: MergeConflictKind }
export interface MergeResult {
  /** The merged project; a conflicting file holds both versions between conflict markers. */
  files: AgentFile[];
  conflicts: MergeConflict[];
  /** Paths the module adds, changes or deletes compared with the common start. */
  changed: string[];
}

export const MARKER_OURS = '<<<<<<< ';
export const MARKER_SPLIT = '=======';
export const MARKER_THEIRS = '>>>>>>> ';
/** Cells of the line-matching table above which a file is not merged line by line (two files of ~2000 changed lines). */
const MAX_CELLS = 4_000_000;

/** Longest common subsequence of two line lists, as matched index pairs in order. */
function matches(a: string[], b: string[]): Array<[number, number]> | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  for (let k = 0; k < start; k += 1) out.push([k, k]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) { out.push([start + i, start + j]); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  for (let k = 0; k < a.length - endA; k += 1) out.push([endA + k, endB + k]);
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, index) => line === y[index]);

/**
 * diff3 on lines: the base lines kept by both sides split the files into regions; a region changed on one side only takes
 * that side, the same change on both sides is taken once, different changes are a conflict. Null when the file is too
 * large to match line by line.
 */
export function mergeLines(base: string[], ours: string[], theirs: string[], labels: { ours: string; theirs: string }): { lines: string[]; conflicts: number } | null {
  const withOurs = matches(base, ours), withTheirs = matches(base, theirs);
  if (!withOurs || !withTheirs) return null;
  const inOurs = new Map(withOurs), inTheirs = new Map(withTheirs);
  const out: string[] = [];
  let conflicts = 0;
  let b = 0, o = 0, t = 0;
  const region = (bEnd: number, oEnd: number, tEnd: number) => {
    const baseSide = base.slice(b, bEnd), oursSide = ours.slice(o, oEnd), theirsSide = theirs.slice(t, tEnd);
    if (same(oursSide, baseSide)) out.push(...theirsSide);
    else if (same(theirsSide, baseSide) || same(oursSide, theirsSide)) out.push(...oursSide);
    else {
      conflicts += 1;
      out.push(`${MARKER_OURS}${labels.ours}`, ...oursSide, MARKER_SPLIT, ...theirsSide, `${MARKER_THEIRS}${labels.theirs}`);
    }
  };
  for (let index = 0; index < base.length; index += 1) {
    const oi = inOurs.get(index), ti = inTheirs.get(index);
    if (oi === undefined || ti === undefined || oi < o || ti < t) continue;
    region(index, oi, ti);
    out.push(base[index]);
    b = index + 1; o = oi + 1; t = ti + 1;
  }
  region(base.length, ours.length, theirs.length);
  return { lines: out, conflicts };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const equal = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const MISSING = Symbol('missing');

/** Key by key: an object changed on both sides is merged inside; anything else changed differently is a conflict. */
function mergeJson(base: Json | typeof MISSING, ours: Json | typeof MISSING, theirs: Json | typeof MISSING): { value: Json | typeof MISSING; conflict: boolean } {
  if (equal(ours, theirs)) return { value: ours, conflict: false };
  if (equal(ours, base)) return { value: theirs, conflict: false };
  if (equal(theirs, base)) return { value: ours, conflict: false };
  if (isObject(ours) && isObject(theirs) && (base === MISSING || isObject(base))) {
    const start = base === MISSING ? {} : base as Record<string, Json>;
    const result: Record<string, Json> = {};
    let conflict = false;
    for (const key of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
      const merged = mergeJson(key in start ? start[key] : MISSING, key in ours ? ours[key] : MISSING, key in theirs ? theirs[key] : MISSING);
      conflict ||= merged.conflict;
      if (merged.value !== MISSING) result[key] = merged.value;
    }
    return { value: result, conflict };
  }
  return { value: ours, conflict: true };
}

function parseJson(text: string | null): Json | typeof MISSING | undefined {
  if (text === null) return MISSING;
  try { return JSON.parse(text) as Json; } catch { return undefined; }
}

/** One file: null means the file is absent on that side. */
export function mergeFile(path: string, base: string | null, ours: string | null, theirs: string | null, labels: { ours: string; theirs: string }): { content: string | null; conflict: MergeConflictKind | null } {
  if (ours === theirs) return { content: ours, conflict: null };
  if (ours === base) return { content: theirs, conflict: null };
  if (theirs === base) return { content: ours, conflict: null };
  if (ours === null || theirs === null) {
    // One side deleted what the other changed: both are kept, marked, for a person or the agent to decide.
    const side = (text: string | null) => (text === null ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n'));
    return { content: [`${MARKER_OURS}${labels.ours}`, ...side(ours), MARKER_SPLIT, ...side(theirs), `${MARKER_THEIRS}${labels.theirs}`, ''].join('\n'), conflict: 'changed_and_deleted' };
  }
  if (path.endsWith('.json')) {
    const b = parseJson(base), o = parseJson(ours), t = parseJson(theirs);
    if (b !== undefined && o !== undefined && t !== undefined && o !== MISSING && t !== MISSING) {
      const merged = mergeJson(b, o, t);
      if (!merged.conflict && merged.value !== MISSING) return { content: `${JSON.stringify(merged.value, null, 2)}\n`, conflict: null };
    }
  }
  const split = (text: string) => text.split('\n');
  const merged = mergeLines(split(base ?? ''), split(ours), split(theirs), labels);
  if (!merged) return { content: `${MARKER_OURS}${labels.ours}\n${ours}\n${MARKER_SPLIT}\n${theirs}\n${MARKER_THEIRS}${labels.theirs}\n`, conflict: 'too_large' };
  return { content: merged.lines.join('\n'), conflict: merged.conflicts ? 'both_changed' : null };
}

/** The whole project: every path of the three sides, in a stable order. */
export function mergeProjects(base: AgentFile[], ours: AgentFile[], theirs: AgentFile[], labels: { ours: string; theirs: string }): MergeResult {
  const map = (files: AgentFile[]) => new Map(files.map((file) => [file.path, file.content]));
  const b = map(base), o = map(ours), t = map(theirs);
  const paths = [...new Set([...b.keys(), ...o.keys(), ...t.keys()])].sort();
  const files: AgentFile[] = [];
  const conflicts: MergeConflict[] = [];
  const changed: string[] = [];
  for (const path of paths) {
    const start = b.get(path) ?? null, main = o.get(path) ?? null, module = t.get(path) ?? null;
    if (module !== start) changed.push(path);
    const merged = mergeFile(path, start, main, module, labels);
    if (merged.conflict) conflicts.push({ path, kind: merged.conflict });
    if (merged.content !== null) files.push({ path, content: merged.content });
  }
  return { files, conflicts, changed };
}

/** Conflict markers left in code (an unfinished resolution): such code is never merged into the main line. */
export function filesWithMarkers(files: AgentFile[]): string[] {
  return files.filter((file) => /^<<<<<<< .*\n(?:[\s\S]*?\n)?=======\n(?:[\s\S]*?\n)?>>>>>>> /m.test(file.content)).map((file) => file.path);
}
