import { parse, type Node } from 'acorn';
import { tr } from '../i18n/i18n.js';

/**
 * Deterministic checks of AI-written code before it goes anywhere (TECHNICAL_SPECIFICATION.md §8.2).
 * The AI writes only the business rules file and its tests; this decides whether they may run in the sandbox.
 * It is a policy for what the generated project may contain, not a security boundary: the sandbox is.
 */
export const CODE_POLICY_VERSION = '1.0.0';
export const MAX_FILE_CHARS = 40_000;

export interface PolicyIssue { file: string; message: string }
interface FileRule { imports: Set<string>; mustExport?: string; mustCall?: string; allowFetch: boolean }

const RULES: Record<string, FileRule> = {
  'src/rules.js': { imports: new Set(['./schema.js']), mustExport: 'check', allowFetch: false },
  'test/rules.test.js': {
    imports: new Set(['node:test', 'node:assert', 'node:assert/strict', 'node:http', '../src/app.js', '../src/schema.js', '../src/rules.js']),
    mustCall: 'test', allowFetch: true,
  },
};
export const POLICY_FILES = Object.keys(RULES);

// Names that reach the process, the file system, the network or code built from strings.
const FORBIDDEN_GLOBALS = new Set(['process', 'globalThis', 'global', 'require', 'module', 'eval', 'Function', 'WebAssembly', 'Worker', 'SharedArrayBuffer', 'Atomics', 'Deno', 'Bun', 'XMLHttpRequest', 'WebSocket', 'importScripts']);

function walk(node: unknown, visit: (node: Node & Record<string, unknown>, parent: Record<string, unknown> | null) => void, parent: Record<string, unknown> | null = null): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, parent); return; }
  const record = node as Node & Record<string, unknown>;
  if (typeof record.type === 'string') visit(record, parent);
  for (const [key, value] of Object.entries(record)) if (key !== 'loc' && key !== 'range' && value && typeof value === 'object') walk(value, visit, record);
}

export function checkFile(path: string, content: string): PolicyIssue[] {
  const rule = RULES[path];
  if (!rule) return [{ file: path, message: tr('Этот файл ИИ менять нельзя.') }];
  if (typeof content !== 'string' || !content.trim()) return [{ file: path, message: tr('Файл пустой.') }];
  if (content.length > MAX_FILE_CHARS) return [{ file: path, message: tr('Файл длиннее {0} символов.', [String(MAX_FILE_CHARS)]) }];
  let program: Node;
  try {
    program = parse(content, { ecmaVersion: 2023, sourceType: 'module' });
  } catch (error) {
    return [{ file: path, message: tr('Код не разбирается: {0}.', [error instanceof Error ? error.message.slice(0, 120) : '?']) }];
  }
  const issues: PolicyIssue[] = [];
  const add = (message: string) => { if (!issues.some((issue) => issue.message === message)) issues.push({ file: path, message }); };
  let exported = false;
  let called = false;
  walk(program, (node, parent) => {
    switch (node.type) {
      case 'ImportDeclaration': case 'ExportAllDeclaration': case 'ExportNamedDeclaration': {
        const source = (node.source as { value?: unknown } | null | undefined)?.value;
        if (source !== undefined && !(typeof source === 'string' && rule.imports.has(source))) add(tr('Подключать «{0}» нельзя.', [String(source)]));
        if (node.type === 'ExportNamedDeclaration') {
          const declaration = node.declaration as { type?: string; id?: { name?: string } } | null;
          if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === rule.mustExport) exported = true;
        }
        break;
      }
      case 'ImportExpression': add(tr('Динамический import нельзя.')); break;
      case 'WithStatement': add(tr('Конструкция with запрещена.')); break;
      case 'MetaProperty': add(tr('import.meta нельзя.')); break;
      case 'Identifier': {
        const name = node.name as string;
        // A property name (object.process) or an object key is not the global.
        const isProperty = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent.type === 'Property' && parent.key === node && !parent.computed));
        if (isProperty) break;
        if (FORBIDDEN_GLOBALS.has(name)) add(tr('Использовать «{0}» нельзя.', [name]));
        if (name === 'fetch' && !rule.allowFetch) add(tr('Запросы в сеть из правил нельзя.'));
        if (name === rule.mustCall && parent?.type === 'CallExpression' && parent.callee === node) called = true;
        break;
      }
      case 'MemberExpression': {
        // constructor.constructor is the usual way to reach Function.
        const property = node.property as { type?: string; name?: string; value?: unknown };
        if (!node.computed && property.name === 'constructor') add(tr('Обращаться к constructor нельзя.'));
        if (node.computed && property.type === 'Literal' && typeof property.value === 'string' && ['constructor', '__proto__'].includes(property.value)) add(tr('Обращаться к constructor нельзя.'));
        if (!node.computed && property.name === '__proto__') add(tr('Обращаться к __proto__ нельзя.'));
        break;
      }
      default: break;
    }
  });
  if (rule.mustExport && !exported) add(tr('Нужна функция export function {0}.', [rule.mustExport]));
  if (rule.mustCall && !called) add(tr('В файле нет ни одного теста.'));
  return issues;
}

export function checkFiles(files: Array<{ path: string; content: string }>): PolicyIssue[] {
  const issues = files.flatMap((file) => checkFile(file.path, file.content));
  for (const path of POLICY_FILES) if (!files.some((file) => file.path === path)) issues.push({ file: path, message: tr('Файла нет.') });
  return issues;
}
