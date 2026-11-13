import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { analyzeArchive, isEnvFile, routesFrom } from './code-analysis.js';
import { cleanFileName, detectStageFile } from './file-types.js';
import { ArchiveFetchError, fetchGithubArchive } from './repo-archive.js';
import { reportMarkdown, reportView } from './report-view.js';
import { buildZip } from './zip-fixture.js';
import { isUnsafeEntryName, listZipEntries, readZipEntry, ZipError } from './zip-reader.js';

const fakeAws = 'AKIA' + 'Q'.repeat(16);

describe('zip reader', () => {
  it('lists and reads stored and deflated entries', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world', store: true }, { name: 'dir/' }]);
    const entries = listZipEntries(zip);
    assert.deepEqual(entries.map((entry) => [entry.name, entry.directory]), [['a.txt', false], ['b.txt', false], ['dir/', true]]);
    const first = readZipEntry(zip, entries[0], 1024);
    assert.ok('data' in first && first.data.toString() === 'hello');
    const second = readZipEntry(zip, entries[1], 1024);
    assert.ok('data' in second && second.data.toString() === 'world');
  });

  it('refuses what is not a zip and never reads unsafe, encrypted, lying or oversized entries', () => {
    assert.throws(() => listZipEntries(Buffer.from('not a zip at all, definitely not')), (error: unknown) => error instanceof ZipError && error.code === 'ZIP_INVALID');
    const zip = buildZip([
      { name: '../evil.sh', data: 'rm -rf' }, { name: 'secret.txt', data: 'x', encrypted: true }, { name: 'crc.txt', data: 'abc', badCrc: true },
      { name: 'bomb.txt', data: Buffer.alloc(100_000, 0x61) }, { name: 'liar.txt', data: 'short', declaredSize: 3 }, { name: 'link', data: '/etc/passwd', symlink: true },
    ]);
    const [evil, encrypted, crc, bomb, liar, link] = listZipEntries(zip);
    assert.ok(evil.unsafePath && link.symlink);
    assert.deepEqual(readZipEntry(zip, evil, 1024), { skipped: 'unsafe' });
    assert.deepEqual(readZipEntry(zip, link, 1024), { skipped: 'unsafe' });
    assert.deepEqual(readZipEntry(zip, encrypted, 1024), { skipped: 'encrypted' });
    assert.deepEqual(readZipEntry(zip, crc, 1024), { skipped: 'corrupt' });
    assert.deepEqual(readZipEntry(zip, bomb, 1024), { skipped: 'too_large' });
    assert.deepEqual(readZipEntry(zip, bomb, 1_000_000), { skipped: 'ratio' });
    assert.deepEqual(readZipEntry(zip, liar, 1024), { skipped: 'corrupt' });
    for (const name of ['/etc/passwd', 'C:/x', 'a\\b', 'a/../../b', 'ok\u0001']) assert.ok(isUnsafeEntryName(name), name);
    assert.ok(!isUnsafeEntryName('src/app/page.tsx'));
  });
});

describe('code analysis', () => {
  const project = buildZip([
    { name: 'shop-main/' },
    { name: 'shop-main/package.json', data: JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '19.0.0', lodash: '*' } }) },
    { name: 'shop-main/app/page.tsx', data: 'export default function Page() { return null }\n' },
    { name: 'shop-main/app/(shop)/catalog/page.tsx', data: 'export default function Catalog() { return null }\n' },
    { name: 'shop-main/.env', data: 'DB=postgres://u:p@h/db\n' },
    { name: 'shop-main/.env.example', data: 'DB=\n' },
    { name: 'shop-main/lib/aws.ts', data: `// config\nexport const key = '${fakeAws}';\n` },
    { name: 'shop-main/node_modules/left-pad/index.js', data: 'module.exports = 1' },
    { name: 'shop-main/public/min.js', data: randomBytes(2500).toString('hex') },
    { name: 'shop-main/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
  ]);

  it('finds stack, routes and problems with file-and-line evidence and never copies secret values', () => {
    const report = analyzeArchive(project, { kind: 'stage_file', label: 'shop.zip', revision: null });
    const codes = report.findings.map((finding) => finding.code);
    for (const code of ['ENV_FILE_COMMITTED', 'SECRET_IN_CODE', 'DEPENDENCIES_COMMITTED', 'LOCKFILE_MISSING', 'NO_BUILD_SCRIPT', 'NO_TEST_SCRIPT', 'UNPINNED_DEPENDENCIES', 'README_MISSING', 'NO_TESTS_FOUND']) assert.ok(codes.includes(code), code);
    assert.equal(report.findings[0].severity, 'high');
    const env = report.findings.find((finding) => finding.code === 'ENV_FILE_COMMITTED')!;
    assert.deepEqual(env.evidence, [{ path: '.env' }]);
    const secret = report.findings.find((finding) => finding.code === 'SECRET_IN_CODE' && finding.params?.kind === 'aws_access_key')!;
    assert.deepEqual(secret.evidence, [{ path: 'lib/aws.ts', line: 2 }]);
    assert.ok(!JSON.stringify(report).includes(fakeAws));
    assert.deepEqual(report.summary.stack.map((item) => item.key).sort(), ['nextjs', 'react']);
    assert.deepEqual(report.summary.routes, ['/', '/catalog']);
    assert.equal(report.status, 'partial');
    assert.ok(report.unverified.includes('long_lines') && report.unverified.includes('runtime') && report.unverified.includes('vulnerabilities'));
    assert.equal(report.checks.find((check) => check.key === 'build_and_tests')!.status, 'skipped');
    assert.match(report.source.sha256, /^[0-9a-f]{64}$/);
    // Same input, same report ids.
    assert.deepEqual(analyzeArchive(project, { kind: 'stage_file', label: 'shop.zip', revision: null }).findings.map((finding) => finding.id), report.findings.map((finding) => finding.id));
  });

  it('writes texts in the reader language and a Markdown report', () => {
    const report = analyzeArchive(project, { kind: 'stage_file', label: 'shop.zip', revision: null });
    const view = reportView(report);
    assert.equal(view.findings[0].severityLabel, 'Важно');
    assert.ok(view.counts.high >= 2);
    const markdown = reportMarkdown('Магазин', { createdAt: new Date(), finishedAt: new Date() }, report);
    assert.match(markdown, /# Разбор кода: Магазин/);
    assert.match(markdown, /`lib\/aws\.ts:2`/);
    assert.match(markdown, /## Не проверено/);
  });

  it('knows env templates, page routes and a clean archive', () => {
    assert.ok(isEnvFile('.env') && isEnvFile('config/.env.production') && !isEnvFile('.env.example') && !isEnvFile('.env.sample'));
    assert.deepEqual(routesFrom(['pages/index.tsx', 'pages/about.tsx', 'pages/_app.tsx', 'pages/api/x.ts', 'index.html', 'contacts.html', 'src/routes/blog/+page.svelte']), ['/', '/about', '/blog', '/contacts']);
    const clean = analyzeArchive(buildZip([{ name: 'README.md', data: '# Сайт' }, { name: 'LICENSE', data: 'MIT' }, { name: 'index.html', data: '<h1>Hi</h1>' }]), { kind: 'stage_file', label: 'site.zip', revision: null });
    assert.equal(clean.status, 'succeeded');
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.summary.readmeExcerpt, '# Сайт');
    assert.deepEqual(clean.summary.stack.map((item) => item.key), ['static_html']);
  });

  it('refuses broken archives with a safe code', () => {
    assert.throws(() => analyzeArchive(Buffer.from('PK nope'), { kind: 'stage_file', label: 'x.zip', revision: null }), (error: unknown) => error instanceof ZipError && error.code === 'ZIP_INVALID');
  });
});

describe('stage file types', () => {
  it('trusts bytes, not names, and refuses formats that could run', () => {
    assert.equal(detectStageFile(Buffer.from('%PDF-1.7 ...'), 'brief.pdf')?.kind, 'pdf');
    assert.equal(detectStageFile(Buffer.from('%PDF-1.7 ...'), 'brief.txt'), null);
    assert.equal(detectStageFile(Buffer.from('<svg onload="alert(1)"/>'), 'logo.svg'), null);
    assert.equal(detectStageFile(Buffer.from('<script>alert(1)</script>'), 'page.html'), null);
    assert.equal(detectStageFile(Buffer.from('MZ\x90\x00'), 'setup.exe'), null);
    assert.equal(detectStageFile(Buffer.from('Цены: 1000\n'), 'prices.csv')?.mime, 'text/csv');
    assert.equal(detectStageFile(Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'notes.txt'), null);
    const docx = buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'word/document.xml', data: '<w/>' }]);
    assert.equal(detectStageFile(docx, 'brief.docx')?.kind, 'docx');
    assert.equal(detectStageFile(docx, 'brief.xlsx'), null);
    assert.equal(detectStageFile(docx, 'archive.zip')?.kind, 'zip');
    assert.equal(cleanFileName('../../etc/pass"wd.txt'), 'passwd.txt');
    assert.equal(cleanFileName('..'), null);
  });
});

describe('repository archives', () => {
  const zip = buildZip([{ name: 'r-abc/README.md', data: 'hi' }]);
  it('follows GitHub redirect only to its archive host and without the token', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null });
      if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/o/r/legacy.zip/refs/heads/main?token=t' } });
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    const bytes = await fetchGithubArchive('https://api.github.com', 'o/r', 'main', 'secret-token', fake);
    assert.equal(bytes.length, zip.length);
    assert.deepEqual(calls.map((call) => call.auth), ['Bearer secret-token', null]);
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/zipball/main');
  });

  it('refuses other redirects, bad refs, missing repos and archives over the cap', async () => {
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.zip' } })) as unknown as typeof fetch;
    await assert.rejects(fetchGithubArchive('https://api.github.com', 'o/r', '', null, redirect), (error: unknown) => error instanceof ArchiveFetchError && error.code === 'ARCHIVE_REDIRECT_REFUSED');
    await assert.rejects(fetchGithubArchive('https://api.github.com', 'o/r', '../x', null, redirect), /REPO_REF_INVALID/);
    const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(fetchGithubArchive('https://api.github.com', 'o/r', '', null, missing), /REPO_NOT_FOUND/);
    const big = (async () => new Response(new Uint8Array(2048), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(fetchGithubArchive('https://api.github.com', 'o/r', '', null, big, 1024), /ARCHIVE_TOO_LARGE/);
  });
});
