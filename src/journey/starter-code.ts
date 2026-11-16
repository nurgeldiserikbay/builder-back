import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import type { Brief } from './artifacts.js';
import { pathFor } from './sitemap.js';
import type { TechPlan } from './techplan.js';
import { fieldKind, type AppFeatures, type FieldKind } from './webapp.js';

/**
 * Starter code of a web application, built by the platform from the accepted stages — no AI.
 * A dependency-free Node.js API that follows the package's data schema and role rights, with tests.
 * The developer replaces the in-memory store and the demo role header with a real database and login;
 * the tests run in an isolated sandbox, never in the API process (TECHNICAL_SPECIFICATION.md, isolation).
 */
export const STARTER_VERSION = '1.0.0';
export const STARTER_NODE_MAJOR = 20;

export interface StarterFile { path: string; content: string }
export interface StarterCode { starterVersion: string; files: StarterFile[]; collections: string[] }

const ident = (value: string) => {
  const base = pathFor(value).slice(1).replace(/-/g, '_') || 'item';
  return /^[0-9]/.test(base) ? `f_${base}` : base;
};
const unique = (used: Set<string>, value: string) => {
  let name = value; let index = 2;
  while (used.has(name)) name = `${value}_${index++}`;
  used.add(name);
  return name;
};
const js = (value: unknown) => JSON.stringify(value, null, 2);

const EXAMPLES: Record<FieldKind, unknown> = {
  text: 'Пример', number: 1, money: 100, boolean: true, email: 'name@example.com', date: '2026-01-01', datetime: '2026-01-01T10:00:00.000Z',
  phone: '+70000000000', status: 'new', file: 'document.pdf', address: 'Адрес',
};

export function buildStarterCode(input: { brief: Brief | null; features: AppFeatures; plan: TechPlan; locale: string }): StarterCode {
  return runWithLocale(contentLocale(input.locale), () => {
    const name = input.brief?.businessName || tr('Приложение');
    const roles = input.features.roles.map((role) => role.key);
    const collectionNames = new Set<string>();
    const entities = input.plan.dataModel.filter((entity) => entity.key !== 'user');
    const keyOf = new Map(entities.map((entity) => [entity.key, unique(collectionNames, `${ident(entity.name)}s`)]));
    const collections = Object.fromEntries(entities.map((entity) => {
      const fieldNames = new Set<string>(['id', 'created_at', 'updated_at']);
      const fields: Record<string, { label: string; kind: FieldKind | 'link' | 'links'; collection?: string }> = {};
      for (const field of entity.fields) fields[unique(fieldNames, ident(field.name))] = { label: field.name, kind: fieldKind(field.name) };
      for (const link of entity.links) {
        const target = link.to === 'user' ? 'users' : keyOf.get(link.to);
        if (!target) continue;
        fields[unique(fieldNames, `${target.replace(/s$/, '')}${link.kind === 'many' ? '_ids' : '_id'}`)] = { label: link.label, kind: link.kind === 'many' ? 'links' : 'link', collection: target };
      }
      // Who may work with the records: roles of the features that use them; all roles when no feature names them.
      const using = [...new Set(input.features.features.filter((feature) => (feature.data ?? []).includes(entity.key)).flatMap((feature) => feature.roles))].filter((role) => roles.includes(role));
      return [keyOf.get(entity.key)!, { title: entity.name, roles: using.length ? using : roles, fields }];
    }));
    const keys = Object.keys(collections);

    const schema = `// ${tr('Создано BuildPath {0} из принятых этапов. Меняйте свободно.', [STARTER_VERSION])}
/** ${tr('Роли приложения.')} */
export const roles = ${js(roles)};

/**
 * ${tr('Ресурсы API: поля из схемы данных и роли, которым они доступны (из таблицы прав).')}
 * kind: text, number, money, boolean, email, phone, date, datetime, status, file, address, link, links.
 */
export const collections = ${js(collections)};
`;

    const app = `import { collections, roles } from './schema.js';

const MAX_BODY = 100_000;
const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;

/** ${tr('Хранилище в памяти: замените на базу данных.')} */
export function memoryStore() {
  const data = new Map(Object.keys(collections).map((key) => [key, new Map()]));
  return {
    list: (collection) => [...data.get(collection).values()],
    get: (collection, id) => data.get(collection).get(id) ?? null,
    put: (collection, record) => { data.get(collection).set(record.id, record); return record; },
    remove: (collection, id) => data.get(collection).delete(id),
  };
}

function check(kind, value) {
  if (value === null) return true;
  switch (kind) {
    case 'number': case 'money': return typeof value === 'number' && Number.isFinite(value) && (kind === 'number' || value >= 0);
    case 'boolean': return typeof value === 'boolean';
    case 'email': return typeof value === 'string' && /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value);
    case 'date': return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case 'datetime': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'links': return Array.isArray(value) && value.length <= 500 && value.every((item) => typeof item === 'string' && item.length <= 100);
    case 'link': return typeof value === 'string' && value.length <= 100;
    default: return typeof value === 'string' && value.length <= 2000;
  }
}

/** ${tr('Проверяет тело запроса: только известные поля и подходящие значения.')} */
export function validate(collection, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'BODY_NOT_OBJECT' };
  const fields = collections[collection].fields;
  const errors = [];
  for (const [key, value] of Object.entries(body)) {
    if (!(key in fields)) errors.push({ field: key, error: 'UNKNOWN_FIELD' });
    else if (!check(fields[key].kind, value)) errors.push({ field: key, error: 'INVALID_VALUE', kind: fields[key].kind });
  }
  return errors.length ? { error: 'VALIDATION_FAILED', fields: errors } : { value: body };
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    request.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}

/**
 * ${tr('Кто делает запрос. Заглушка для разработки: роль из заголовка x-demo-role.')}
 * ${tr('Перед запуском замените на настоящий вход (сессия или токен) и роль из базы.')}
 */
export function demoUser(request) {
  const role = request.headers['x-demo-role'];
  return typeof role === 'string' && roles.includes(role) ? { id: 'demo', role } : null;
}

export function createApp({ store = memoryStore(), currentUser = demoUser, now = () => new Date() } = {}) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') return send(response, 404, { error: 'NOT_FOUND' });
      if (parts[1] === 'health' && parts.length === 2) return send(response, 200, { status: 'ok' });
      const user = currentUser(request);
      if (!user) return send(response, 401, { error: 'UNAUTHENTICATED' });
      if (parts[1] === 'me' && parts.length === 2) return send(response, 200, user);
      const collection = parts[1];
      if (!Object.hasOwn(collections, collection) || parts.length > 3) return send(response, 404, { error: 'NOT_FOUND' });
      if (!collections[collection].roles.includes(user.role)) return send(response, 403, { error: 'FORBIDDEN' });
      const id = parts[2];
      const method = request.method;
      if (!id && method === 'GET') return send(response, 200, store.list(collection));
      if (!id && method === 'POST') {
        const checked = validate(collection, await readJson(request));
        if (checked.error) return send(response, 400, checked);
        const at = now().toISOString();
        return send(response, 201, store.put(collection, { ...checked.value, id: crypto.randomUUID(), created_at: at, updated_at: at }));
      }
      if (!id) return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const record = store.get(collection, id);
      if (!record) return send(response, 404, { error: 'NOT_FOUND' });
      if (method === 'GET') return send(response, 200, record);
      if (method === 'PATCH') {
        const checked = validate(collection, await readJson(request));
        if (checked.error) return send(response, 400, checked);
        return send(response, 200, store.put(collection, { ...record, ...checked.value, id, updated_at: now().toISOString() }));
      }
      if (method === 'DELETE') { store.remove(collection, id); return send(response, 204); }
      return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    } catch (error) {
      const code = error instanceof Error && ['BODY_TOO_LARGE', 'INVALID_JSON'].includes(error.message) ? error.message : 'INTERNAL_ERROR';
      return send(response, code === 'INTERNAL_ERROR' ? 500 : 400, { error: code });
    }
  };
}
`;

    const server = `import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
createServer(createApp()).listen(port, () => console.log(\`API: http://localhost:\${port}/api/health\`));
`;

    const tests = `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { collections, roles } from '../src/schema.js';

const EXAMPLES = ${js(EXAMPLES)};
let server; let base;
before(async () => {
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = \`http://127.0.0.1:\${server.address().port}/api\`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const call = (path, { role, method = 'GET', body } = {}) => fetch(base + path, {
  method, headers: { ...(role ? { 'x-demo-role': role } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const example = (collection) => Object.fromEntries(Object.entries(collections[collection].fields).map(([key, field]) =>
  [key, field.kind === 'link' ? 'record-id' : field.kind === 'links' ? ['record-id'] : EXAMPLES[field.kind] ?? 'Пример']));

test('health answers without login', async () => {
  assert.equal((await call('/health')).status, 200);
});

test('requests without a role are refused', async () => {
  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/me', { role: 'nobody' })).status, 401);
});

for (const role of roles) {
  test(\`role \${role} is recognised\`, async () => {
    const response = await call('/me', { role });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, role);
  });
}

for (const [collection, definition] of Object.entries(collections)) {
  const role = definition.roles[0];
  test(\`\${collection}: create, read, change and delete\`, async () => {
    const created = await call(\`/\${collection}\`, { role, method: 'POST', body: example(collection) });
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.ok(record.id);
    const list = await (await call(\`/\${collection}\`, { role })).json();
    assert.ok(list.some((item) => item.id === record.id));
    assert.equal((await call(\`/\${collection}/\${record.id}\`, { role })).status, 200);
    const first = Object.keys(definition.fields)[0];
    if (first) {
      const changed = await call(\`/\${collection}/\${record.id}\`, { role, method: 'PATCH', body: { [first]: example(collection)[first] } });
      assert.equal(changed.status, 200);
    }
    assert.equal((await call(\`/\${collection}/\${record.id}\`, { role, method: 'DELETE' })).status, 204);
    assert.equal((await call(\`/\${collection}/\${record.id}\`, { role })).status, 404);
  });

  test(\`\${collection}: unknown fields and broken JSON are refused\`, async () => {
    const unknown = await call(\`/\${collection}\`, { role, method: 'POST', body: { not_a_field: 1 } });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).fields[0].error, 'UNKNOWN_FIELD');
    assert.equal((await call(\`/\${collection}\`, { role, method: 'POST', body: '{broken' })).status, 400);
  });

  const outsider = roles.find((item) => !definition.roles.includes(item));
  if (outsider) {
    test(\`\${collection}: role \${outsider} has no access\`, async () => {
      assert.equal((await call(\`/\${collection}\`, { role: outsider })).status, 403);
    });
  }
}
`;

    const pkg = { name: ident(name).replace(/_/g, '-').slice(0, 50) || 'app', version: '0.1.0', private: true, type: 'module', engines: { node: `>=${STARTER_NODE_MAJOR}` }, scripts: { start: 'node src/server.js', test: 'node --test' } };
    const rights = keys.map((key) => `| \`/api/${key}\` | ${collections[key].title} | ${collections[key].roles.join(', ')} |`);
    const readme = [`# ${name} — ${tr('стартовый код API')}`, '',
      tr('Создано BuildPath {0} из принятых этапов без ИИ: ресурсы из схемы данных, права из таблицы прав, тесты на каждый ресурс. Зависимостей нет, нужен Node.js {1} или новее.', [STARTER_VERSION, String(STARTER_NODE_MAJOR)]), '',
      '```sh', 'npm test', 'npm start', '```', '',
      `## ${tr('Ресурсы и роли')}`, '', `| ${tr('Путь')} | ${tr('Что хранит')} | ${tr('Роли')} |`, '|---|---|---|', ...rights, '',
      `## ${tr('Что заменить перед запуском')}`, '',
      `- ${tr('Вход: сейчас роль берётся из заголовка x-demo-role (src/app.js, demoUser). Подключите сессию или токен и роль пользователя из базы.')}`,
      `- ${tr('Хранилище: данные живут в памяти и пропадают при перезапуске (memoryStore). Подключите базу данных по схеме data-model.md из пакета.')}`,
      `- ${tr('Права: роль даёт доступ ко всему ресурсу. Если нужно «только свои записи», добавьте проверку владельца.')}`,
      `- ${tr('Бизнес-правила и критерии приёмки — в spec.md пакета; тесты проверяют только устройство API.')}`, ''].join('\n');

    return {
      starterVersion: STARTER_VERSION, collections: keys,
      files: [
        { path: 'package.json', content: `${js(pkg)}\n` },
        { path: 'README.md', content: readme },
        { path: 'src/schema.js', content: schema },
        { path: 'src/app.js', content: app },
        { path: 'src/server.js', content: server },
        { path: 'test/api.test.js', content: tests },
      ],
    };
  });
}
