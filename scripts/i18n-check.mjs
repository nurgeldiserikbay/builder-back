// Checks that every platform text passed to tr()/trl() (and to messagePage) has an English translation in src/i18n/en.ts.
// Run: npm run i18n:check. Lists missing texts and exits with 1 if there are any; --json prints them as a JSON object to fill in.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CYR = /[А-Яа-яЁё]/;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'generated') walk(full); }
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'en.ts') files.push(full);
  }
})(path.join(root, 'src'));

const enSource = ts.createSourceFile('en.ts', readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const known = new Set();
enSource.forEachChild(function visit(node) {
  if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name))) known.add(node.name.text);
  node.forEachChild(visit);
});

const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
const missing = new Map();
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  source.forEachChild(function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const texts = name === 'tr' ? [node.arguments[0]] : name === 'trl' ? [node.arguments[1]] : name === 'messagePage' ? [node.arguments[1], node.arguments[2]] : [];
      for (const arg of texts) {
        const text = literal(arg);
        if (text && CYR.test(text) && !known.has(text)) missing.set(text, path.relative(root, file));
      }
    }
    node.forEachChild(visit);
  });
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(Object.fromEntries([...missing.keys()].map((key) => [key, ''])), null, 1)); process.exit(0); }
if (missing.size) {
  for (const [text, file] of missing) console.log(`${file}: ${text}`);
  console.log(`\n${missing.size} texts have no English translation in src/i18n/en.ts.`);
  process.exit(1);
}
console.log(`English dictionary covers all platform texts (${known.size} entries).`);
