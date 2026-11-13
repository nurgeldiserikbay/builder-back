// Read-only analysis of a source archive. Nothing from the archive is executed, installed, built or sent to an AI
// provider: the report is produced by deterministic rules over file names and the text of small files. Every finding
// points to the file (and line, when there is one) it is based on; what could not be checked is listed as such.

import { createHash } from 'node:crypto';
import { commonRoot, listZipEntries, readZipEntry, ZipError, type ZipEntry } from './zip-reader.js';

export const ANALYSIS_PROFILE = 'code-archive-1.0';
export const ANALYSIS_LIMITS = { textFileBytes: 256 * 1024, textBudgetBytes: 8 * 1024 * 1024, largeFileBytes: 5 * 1024 * 1024, routes: 60, evidencePerFinding: 10, scanLineChars: 2000 };

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Evidence = { path: string; line?: number };
export type Finding = { id: string; code: string; category: 'security' | 'structure' | 'dependencies' | 'docs' | 'quality'; severity: Severity; confidence: 'confirmed' | 'likely'; evidence: Evidence[]; params?: Record<string, string | number> };
export type CheckRecord = { key: string; status: 'run' | 'partial' | 'skipped' };
export type DocumentSummary = { format: 'pdf' | 'docx' | 'text'; words: number; paragraphs: number; pages: number | null; headings: string[]; sections: { key: string; found: boolean; paragraph: number | null }[] };
export type AnalysisReport = {
  /** Missing in reports made before documents could be analysed: those are code reports. */
  type?: 'code' | 'document';
  document?: DocumentSummary;
  profile: string;
  source: { kind: string; label: string; revision: string | null; sha256: string; bytes: number };
  status: 'succeeded' | 'partial';
  summary: {
    files: number; directories: number; textFilesRead: number; lines: number;
    languages: { name: string; files: number; lines: number }[];
    stack: { key: string; evidence: string }[];
    routes: string[];
    readmeExcerpt: string | null;
  };
  findings: Finding[];
  checks: CheckRecord[];
  skipped: { encrypted: number; tooLarge: number; binary: number; budget: number; unsafe: number; corrupt: number; longLines: number };
  unverified: string[];
};

const languages: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', vue: 'Vue', svelte: 'Svelte',
  py: 'Python', php: 'PHP', rb: 'Ruby', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#', rs: 'Rust', swift: 'Swift', dart: 'Dart',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', sql: 'SQL', md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', sh: 'Shell',
};
const textExtensions = new Set([...Object.keys(languages), 'txt', 'toml', 'ini', 'xml', 'env', 'lock', 'gradle', 'properties', 'conf', 'example', 'sample', 'twig', 'blade', 'erb', 'ejs', 'hbs', 'svg', 'csv', 'gitignore']);
const textNames = new Set(['Dockerfile', 'Makefile', 'Gemfile', 'Procfile', 'LICENSE', 'README', '.gitignore', '.npmrc', '.htaccess', 'composer.lock', 'go.sum', 'go.mod']);

const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.startsWith('.') ? base.slice(1).toLowerCase() : '';
};
const baseName = (path: string): string => path.split('/').pop() ?? path;
const isText = (path: string): boolean => textExtensions.has(extensionOf(path)) || textNames.has(baseName(path)) || /^\.env(\..+)?$/.test(baseName(path));

/** Committed environment files that usually hold real secrets. Templates (`.env.example`) are fine. */
export function isEnvFile(path: string): boolean {
  const name = baseName(path);
  return /^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) && !/\.(example|sample|template|dist|defaults?)$/i.test(name);
}

/** Patterns of real credentials. Values are never copied into the report: evidence is the file and line only. */
export const secretPatterns: { key: string; pattern: RegExp }[] = [
  { key: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { key: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { key: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { key: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { key: 'stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { key: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { key: 'telegram_bot_token', pattern: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/ },
  { key: 'connection_string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@/ },
];

const stackRules: { key: string; test: (ctx: { deps: Set<string>; names: Set<string>; text: Map<string, string> }) => string | null }[] = [
  { key: 'nextjs', test: ({ deps }) => (deps.has('next') ? 'package.json: next' : null) },
  { key: 'nuxt', test: ({ deps }) => (deps.has('nuxt') ? 'package.json: nuxt' : null) },
  { key: 'react', test: ({ deps }) => (deps.has('react') ? 'package.json: react' : null) },
  { key: 'vue', test: ({ deps }) => (deps.has('vue') ? 'package.json: vue' : null) },
  { key: 'svelte', test: ({ deps }) => (deps.has('svelte') || deps.has('@sveltejs/kit') ? 'package.json: svelte' : null) },
  { key: 'angular', test: ({ deps }) => (deps.has('@angular/core') ? 'package.json: @angular/core' : null) },
  { key: 'vite', test: ({ deps }) => (deps.has('vite') ? 'package.json: vite' : null) },
  { key: 'nestjs', test: ({ deps }) => (deps.has('@nestjs/core') ? 'package.json: @nestjs/core' : null) },
  { key: 'express', test: ({ deps }) => (deps.has('express') ? 'package.json: express' : null) },
  { key: 'tailwind', test: ({ deps }) => (deps.has('tailwindcss') ? 'package.json: tailwindcss' : null) },
  { key: 'prisma', test: ({ deps }) => (deps.has('prisma') || deps.has('@prisma/client') ? 'package.json: prisma' : null) },
  { key: 'laravel', test: ({ text }) => (/"laravel\/framework"/.test(text.get('composer.json') ?? '') ? 'composer.json: laravel/framework' : null) },
  { key: 'wordpress', test: ({ names }) => (names.has('wp-config.php') || names.has('wp-config-sample.php') || names.has('wp-login.php') ? 'wp-config.php' : null) },
  { key: 'django', test: ({ names, text }) => (names.has('manage.py') && /django/i.test((text.get('requirements.txt') ?? '') + (text.get('pyproject.toml') ?? '')) ? 'manage.py + django' : null) },
  { key: 'flask', test: ({ text }) => (/^flask\b/im.test(text.get('requirements.txt') ?? '') ? 'requirements.txt: flask' : null) },
  { key: 'fastapi', test: ({ text }) => (/^fastapi\b/im.test(text.get('requirements.txt') ?? '') || /fastapi/.test(text.get('pyproject.toml') ?? '') ? 'fastapi' : null) },
  { key: 'rails', test: ({ text }) => (/gem ['"]rails['"]/.test(text.get('Gemfile') ?? '') ? 'Gemfile: rails' : null) },
  { key: 'go', test: ({ names }) => (names.has('go.mod') ? 'go.mod' : null) },
  { key: 'spring', test: ({ text }) => (/spring-boot/.test((text.get('pom.xml') ?? '') + (text.get('build.gradle') ?? '') + (text.get('build.gradle.kts') ?? '')) ? 'spring-boot' : null) },
  { key: 'flutter', test: ({ text }) => (/sdk:\s*flutter/.test(text.get('pubspec.yaml') ?? '') ? 'pubspec.yaml: flutter' : null) },
  { key: 'docker', test: ({ names }) => (names.has('Dockerfile') || names.has('docker-compose.yml') || names.has('compose.yaml') ? 'Dockerfile' : null) },
  { key: 'static_html', test: ({ names, deps }) => (names.has('index.html') && deps.size === 0 ? 'index.html' : null) },
];

/** Routes visible from file names: Next.js app/pages, Nuxt/SvelteKit pages and plain HTML files. */
export function routesFrom(paths: string[]): string[] {
  const routes = new Set<string>();
  for (const path of paths) {
    let match = /^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(path);
    if (match) { routes.add('/' + match[1].split('/').filter((part) => !/^\(.*\)$/.test(part)).join('/')); continue; }
    match = /^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|vue)$/.exec(path);
    if (match && !/^(?:_app|_document|_error|api\/)/.test(match[1])) { routes.add('/' + match[1].replace(/(?:^|\/)index$/, '')); continue; }
    match = /^(?:src\/)?routes\/(.*?)\/?\+page\.svelte$/.exec(path);
    if (match) { routes.add('/' + match[1]); continue; }
    if (/\.html?$/.test(path) && !path.includes('/') ) routes.add('/' + path.replace(/(?:^|\/)index\.html?$/, '').replace(/\.html?$/, ''));
  }
  return [...routes].map((route) => route.replace(/\/+$/, '') || '/').sort().slice(0, ANALYSIS_LIMITS.routes);
}

/** Line-by-line so matching time stays linear in the file size; very long (minified) lines are not scanned. */
function firstMatchingLine(text: string, pattern: RegExp): number | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length <= ANALYSIS_LIMITS.scanLineChars && pattern.test(lines[index])) return index + 1;
  }
  return null;
}

export function analyzeArchive(buffer: Buffer, source: { kind: string; label: string; revision: string | null }): AnalysisReport {
  let entries: ZipEntry[];
  try { entries = listZipEntries(buffer); } catch (error) { throw error instanceof ZipError ? error : new ZipError('ZIP_INVALID'); }
  const root = commonRoot(entries);
  const strip = (name: string) => (root && name.startsWith(root) ? name.slice(root.length) : name);
  const files = entries.filter((entry) => !entry.directory).map((entry) => ({ entry, path: strip(entry.name) })).filter((item) => item.path);
  const directories = new Set<string>();
  for (const item of files) { const parts = item.path.split('/'); for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/')); }

  const skipped = { encrypted: 0, tooLarge: 0, binary: 0, budget: 0, unsafe: 0, corrupt: 0, longLines: 0 };
  const text = new Map<string, string>();
  const names = new Set<string>();
  const languageStats = new Map<string, { files: number; lines: number }>();
  let budget = ANALYSIS_LIMITS.textBudgetBytes;
  let lines = 0;
  // Ignored folders are counted but not read: they are copies of other people's code or build output.
  const ignoredDir = /(?:^|\/)(?:node_modules|vendor|bower_components|\.git|dist|build|\.next|out|coverage)\//;
  const ordered = [...files].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  for (const item of ordered) {
    const { entry, path } = item;
    if (!path.includes('/')) names.add(path);
    if (entry.encrypted) { skipped.encrypted += 1; continue; }
    if (entry.unsafePath || entry.symlink) { skipped.unsafe += 1; continue; }
    if (ignoredDir.test(path)) continue;
    const language = languages[extensionOf(path)];
    if (language) languageStats.set(language, { files: (languageStats.get(language)?.files ?? 0) + 1, lines: languageStats.get(language)?.lines ?? 0 });
    if (!isText(path)) { skipped.binary += 1; continue; }
    if (entry.size > ANALYSIS_LIMITS.textFileBytes) { skipped.tooLarge += 1; continue; }
    if (entry.size > budget) { skipped.budget += 1; continue; }
    const read = readZipEntry(buffer, entry, ANALYSIS_LIMITS.textFileBytes);
    if ('skipped' in read) { if (read.skipped === 'too_large' || read.skipped === 'ratio') skipped.tooLarge += 1; else skipped.corrupt += 1; continue; }
    budget -= read.data.length;
    if (read.data.includes(0)) { skipped.binary += 1; continue; }
    const content = read.data.toString('utf8');
    text.set(path, content);
    if (content.split('\n').some((line) => line.length > ANALYSIS_LIMITS.scanLineChars)) skipped.longLines += 1;
    const count = content ? content.split('\n').length : 0;
    lines += count;
    if (language) { const stats = languageStats.get(language)!; stats.lines += count; }
  }

  const findings: Finding[] = [];
  const add = (code: string, category: Finding['category'], severity: Severity, evidence: Evidence[], confidence: Finding['confidence'] = 'confirmed', params?: Finding['params']) => {
    findings.push({ id: `${code}-${createHash('sha256').update(evidence.map((item) => `${item.path}:${item.line ?? ''}`).join('|')).digest('hex').slice(0, 8)}`, code, category, severity, confidence, evidence: evidence.slice(0, ANALYSIS_LIMITS.evidencePerFinding), params: { count: evidence.length, ...params } });
  };
  const allPaths = files.map((item) => item.path);

  const envFiles = allPaths.filter(isEnvFile);
  if (envFiles.length) add('ENV_FILE_COMMITTED', 'security', 'high', envFiles.map((path) => ({ path })));
  for (const rule of secretPatterns) {
    const hits: Evidence[] = [];
    for (const [path, content] of text) {
      if (/\.(?:md|lock)$/.test(path) && rule.key === 'connection_string') continue;
      const line = firstMatchingLine(content, rule.pattern);
      if (line) hits.push({ path, line });
    }
    if (hits.length) add('SECRET_IN_CODE', 'security', 'high', hits, rule.key === 'connection_string' ? 'likely' : 'confirmed', { kind: rule.key });
  }
  const unsafe = files.filter((item) => item.entry.unsafePath).map((item) => ({ path: item.entry.name.replace(/[\u0000-\u001f]/g, '?').slice(0, 200) }));
  if (unsafe.length) add('UNSAFE_ARCHIVE_PATHS', 'security', 'medium', unsafe);
  const links = files.filter((item) => item.entry.symlink).map((item) => ({ path: item.path }));
  if (links.length) add('SYMLINKS_IN_ARCHIVE', 'security', 'low', links);

  const vendored = [...new Set(allPaths.map((path) => /^(.*?(?:^|\/)(?:node_modules|vendor|bower_components))\//.exec(path)?.[1]).filter((value): value is string => Boolean(value)))];
  if (vendored.length) add('DEPENDENCIES_COMMITTED', 'structure', 'medium', vendored.map((path) => ({ path })));
  const builtDirs = [...new Set(allPaths.map((path) => /^((?:.*\/)?(?:\.next|dist|out|coverage))\//.exec(path)?.[1]).filter((value): value is string => Boolean(value)))];
  if (builtDirs.length) add('BUILD_OUTPUT_COMMITTED', 'structure', 'low', builtDirs.map((path) => ({ path })));
  const large = files.filter((item) => item.entry.size > ANALYSIS_LIMITS.largeFileBytes && !ignoredDir.test(item.path)).map((item) => ({ path: item.path }));
  if (large.length) add('LARGE_FILES', 'structure', 'low', large);

  let deps = new Set<string>();
  type PackageJson = { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  const parsePackage = (raw: string): PackageJson | null => {
    try { const value = JSON.parse(raw) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as PackageJson : null; } catch { return null; }
  };
  const packageJson: PackageJson | null = text.has('package.json') ? parsePackage(text.get('package.json')!) : null;
  if (text.has('package.json')) {
    if (!packageJson) add('PACKAGE_JSON_INVALID', 'dependencies', 'medium', [{ path: 'package.json' }]);
    if (packageJson) {
      deps = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
      const locks = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
      if (!locks.some((name) => names.has(name))) add('LOCKFILE_MISSING', 'dependencies', 'medium', [{ path: 'package.json' }]);
      const scripts = packageJson.scripts ?? {};
      if (!('build' in scripts)) add('NO_BUILD_SCRIPT', 'quality', 'info', [{ path: 'package.json' }]);
      if (!('test' in scripts) || /no test specified/.test(String(scripts.test ?? ''))) add('NO_TEST_SCRIPT', 'quality', 'low', [{ path: 'package.json' }]);
      const loose = Object.entries({ ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) }).filter(([, version]) => version === '*' || version === 'latest' || version === '').map(([name]) => ({ path: 'package.json', name }));
      if (loose.length) add('UNPINNED_DEPENDENCIES', 'dependencies', 'low', [{ path: 'package.json' }], 'confirmed', { names: loose.map((item) => item.name).slice(0, 10).join(', ') });
    }
  }
  if (names.has('composer.json') && !names.has('composer.lock')) add('LOCKFILE_MISSING', 'dependencies', 'medium', [{ path: 'composer.json' }]);

  const readme = allPaths.find((path) => /^readme(?:\.[a-z]+)?$/i.test(path));
  if (!readme) add('README_MISSING', 'docs', 'low', [{ path: '/' }]);
  if (!allPaths.some((path) => /^(?:licen[cs]e|copying)(?:\.[a-z]+)?$/i.test(path))) add('LICENSE_MISSING', 'docs', 'info', [{ path: '/' }]);
  const tests = allPaths.filter((path) => /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$|_test\.(?:go|py)$|^test_.*\.py$/.test(path) && !ignoredDir.test(path));
  const codeFiles = [...languageStats.entries()].filter(([name]) => !['Markdown', 'JSON', 'YAML', 'HTML', 'CSS'].includes(name)).reduce((sum, [, stats]) => sum + stats.files, 0);
  if (!tests.length && codeFiles > 0) add('NO_TESTS_FOUND', 'quality', 'low', [{ path: '/' }], 'likely');
  if (!names.has('.gitignore') && source.kind !== 'stage_file') add('GITIGNORE_MISSING', 'structure', 'info', [{ path: '/' }]);

  const stack = stackRules.map((rule) => ({ key: rule.key, evidence: rule.test({ deps, names, text }) })).filter((item): item is { key: string; evidence: string } => item.evidence !== null);
  const readmeText = readme ? text.get(readme) ?? null : null;
  const anySkipped = Object.entries(skipped).some(([key, value]) => key !== 'binary' && value > 0);
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));

  return {
    type: 'code',
    profile: ANALYSIS_PROFILE,
    source: { ...source, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length },
    status: anySkipped ? 'partial' : 'succeeded',
    summary: {
      files: files.length, directories: directories.size, textFilesRead: text.size, lines,
      languages: [...languageStats.entries()].map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.lines - a.lines || b.files - a.files),
      stack, routes: routesFrom(allPaths),
      readmeExcerpt: readmeText ? readmeText.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 800) : null,
    },
    findings,
    checks: [
      { key: 'inventory', status: 'run' },
      { key: 'stack', status: 'run' },
      { key: 'secrets', status: anySkipped ? 'partial' : 'run' },
      { key: 'structure', status: 'run' },
      { key: 'dependencies', status: packageJson || names.has('composer.json') ? 'run' : 'skipped' },
      { key: 'docs', status: 'run' },
      { key: 'vulnerabilities', status: 'skipped' },
      { key: 'build_and_tests', status: 'skipped' },
    ],
    skipped,
    unverified: ['runtime', 'build', 'tests', 'vulnerabilities', 'site_quality', ...(skipped.encrypted ? ['encrypted'] : []), ...(skipped.tooLarge + skipped.budget ? ['large_files'] : []), ...(skipped.binary ? ['binary_files'] : []), ...(skipped.longLines ? ['long_lines'] : [])],
  };
}
