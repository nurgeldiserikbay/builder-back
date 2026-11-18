// A model's answer is checked by the same strict rules as a person's edit, but a person is told what to fix and a model is
// not. So for AI output the platform repairs what is plainly repairable and checks again: a text over its limit is cut, a
// list over its limit loses its last items, a list item without a required field is dropped. Anything else (a wrong
// structure, a value that is not allowed) is still refused. The reason is logged, so a refusal can be traced.
import { ArtifactValidationError } from './artifacts.js';

type Path = Array<string | number>;
const parse = (field: string): Path => field.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));

function at(root: unknown, path: Path): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
  let node: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string | number, unknown>)[part];
  }
  return node !== null && typeof node === 'object' ? { parent: node as Record<string, unknown> | unknown[], key: path[path.length - 1]! } : null;
}

/** One repair for one refusal; false when the refusal is not of a repairable kind or the place is not found. */
function repair(root: unknown, code: string): boolean {
  const [kind, field] = code.split(':') as [string, string | undefined];
  if (!field) return false;
  const path = parse(field);
  const place = at(root, path);
  if (!place) return false;
  const value = (place.parent as Record<string | number, unknown>)[place.key];
  if (kind === 'FIELD_TOO_LONG' && typeof value === 'string') {
    // The limit is not in the message: cut by a fifth until it fits, on a word boundary when there is one.
    const target = Math.max(1, Math.floor(value.length * 0.8));
    const cut = value.slice(0, target);
    const word = cut.lastIndexOf(' ');
    (place.parent as Record<string | number, unknown>)[place.key] = (word > target * 0.6 ? cut.slice(0, word) : cut).trimEnd();
    return true;
  }
  if ((kind === 'FIELD_TOO_MANY' || kind === 'FIELD_COUNT') && Array.isArray(value) && value.length > 0) {
    value.pop();
    return true;
  }
  if (kind === 'FIELD_REQUIRED') {
    // A required field missing inside a list item: the item goes, the rest of the list stays.
    for (let index = path.length - 2; index >= 0; index -= 1) {
      if (typeof path[index] === 'number') {
        const item = at(root, path.slice(0, index + 1));
        if (item && Array.isArray(item.parent)) { item.parent.splice(item.key as number, 1); return true; }
      }
    }
  }
  return false;
}

export function normalizeAiOutput<T>(raw: unknown, normalize: (value: unknown) => T, log: (message: string) => void = (message) => console.warn(message)): T {
  const draft = JSON.parse(JSON.stringify(raw ?? null)) as unknown;
  const repaired: string[] = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const result = normalize(draft);
      if (repaired.length) log(`AI output repaired: ${[...new Set(repaired.map((code) => code.replace(/\.\d+/g, '.#')))].slice(0, 10).join(', ')}`);
      return result;
    } catch (error) {
      if (!(error instanceof ArtifactValidationError) || !repair(draft, error.code)) {
        if (error instanceof ArtifactValidationError) log(`AI output rejected: ${error.code}`);
        throw error;
      }
      repaired.push(error.code);
    }
  }
  log('AI output rejected: too many repairs');
  throw new ArtifactValidationError('AI_OUTPUT_REJECTED');
}
