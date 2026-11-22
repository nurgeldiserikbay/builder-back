// A stand-in for the AI provider in the end-to-end run: an OpenAI-compatible server (Chat Completions, as Gemini's endpoint
// is used on prod) that answers like a model would, so the whole path can be walked without keys or quotas.
//
// - Stage drafts are the platform's own templates for the confirmed inputs: valid shapes, so the run checks the flow, not
//   the model. The goal answer follows the guidance the prompt carries (an application asks for «form»), so a prompt that
//   lost that guidance shows up as a wrong main action.
// - «Разговор» asks two questions and then says it has enough.
// - The agent writes a small but complete application in two turns (several files per call, as the prompt asks), and a
//   change request edits it; all platform checks pass on it.
// - Voice: /audio/transcriptions returns a fixed sentence.
// Every request is logged to stdout as one line, so a failed run shows what the platform asked.
import http from 'node:http';
import { templateProcess } from '../src/journey/process.js';
import { templateFeatures, templateScreens } from '../src/journey/webapp.js';
import type { Brief } from '../src/journey/artifacts.js';

const port = Number(process.env.MOCK_AI_PORT ?? 4561);
type Json = Record<string, unknown>;

/** The repair service the run describes. */
function brief(app: boolean): Brief {
  return {
    businessName: 'Мастер Дома', whatYouDo: 'Ремонт бытовой техники на дому: стиральные машины, холодильники, плиты.',
    audience: 'Жители Астаны, у которых сломалась техника', city: 'Астана', mainAction: app ? 'form' : 'message',
    phone: '+7 701 000 00 00', messenger: 'https://wa.me/77010000000', email: null, address: null, tone: 'friendly',
  } as unknown as Brief;
}

/** Fills any schema with plain values: the fallback for answers the run does not script. */
function fill(schema: Json, label = 'Текст'): unknown {
  if (Array.isArray(schema.type)) return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, fill(value, key)]));
    }
    case 'array': return [];
    case 'string': return label;
    case 'number': case 'integer': return 1;
    case 'boolean': return false;
    default: return null;
  }
}

function stageAnswer(name: string, system: string, user: Json, schema: Json): unknown {
  const inputs = (user.confirmedInputs ?? {}) as Json;
  // The goal prompt of an application carries «This is a web application … Choose mainAction «form» …» (stageFor).
  const appGuidance = /This is a web application, not a site\. Choose mainAction «form»/.test(system);
  const confirmedBrief = (inputs.goal ?? null) as Brief | null;
  switch (name) {
    case 'buildpath_brief': return brief(appGuidance);
    case 'buildpath_process': return templateProcess('web_app', confirmedBrief ?? brief(true));
    case 'buildpath_features': return templateFeatures(confirmedBrief ?? brief(true), (inputs.process ?? null) as never);
    case 'buildpath_screens': return templateScreens((inputs.features ?? null) as never);
    case 'buildpath_interview': return interview(user, schema);
    default:
      if (name.startsWith('buildpath_review_')) return { findings: [] };
      return fill(schema);
  }
}

const QUESTIONS = ['Кто у вас участвует в работе?', 'Как заявка проходит от клиента до мастера?', 'Спасибо, этого достаточно. Нажмите «Составить по разговору».'];
const ANSWERS = ['Я, диспетчер и два мастера', 'Клиент оставляет заявку, диспетчер назначает мастера, мастер чинит и закрывает заявку'];
function interview(user: Json, schema: Json): unknown {
  const owners = ((user.conversation ?? []) as Array<{ role: string }>).filter((message) => message.role === 'owner').length;
  const keys = (((schema.properties as Json).fields as Json).required ?? []) as string[];
  // The goal form takes the repair service's facts; the topics of composed stages take the owner's words.
  const facts = brief(true) as unknown as Json;
  const known = (key: string, index: number) => (key in facts ? facts[key] : ANSWERS[index % ANSWERS.length]);
  const fields: Json = Object.fromEntries(keys.map((key, index) => [key, owners >= 2 || index < owners ? known(key, index) : null]));
  return { reply: QUESTIONS[Math.min(owners, 2)], fields, done: owners >= 2 };
}

// ---- The agent ----

const STYLE = `body{margin:0;font-family:system-ui,sans-serif;background:#f6f7f9;color:#1c241f}
header{padding:16px;background:#fff;border-bottom:1px solid #e3e6e8}main{padding:16px;display:grid;gap:12px}
.card{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;background:#e8ecff;color:#1a32a6}
button{min-height:44px;padding:0 16px;border:0;border-radius:10px;background:#2445d4;color:#fff;font-size:16px}`;

function page(title: string, demo: boolean): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
${demo ? '' : '<link rel="manifest" href="/manifest.webmanifest">'}<style>${STYLE}</style></head>
<body><header><strong>${title}</strong></header><main id="list"></main>
<script>const requests=[{id:1,what:"Стиральная машина не сливает воду",status:"Новая"},{id:2,what:"Холодильник не морозит",status:"Мастер назначен"}];
document.getElementById("list").innerHTML=requests.map(r=>'<div class="card"><span class="badge">'+r.status+'</span><p>'+r.what+'</p><button>Подробнее</button></div>').join("");
${demo ? '' : 'try{navigator.serviceWorker.register("/sw.js")}catch(e){}'}</script></body></html>`;
}

const BUILD = (title: string) => `import { mkdirSync, writeFileSync } from 'node:fs';
const demo = process.argv.includes('--demo');
const out = demo ? 'dist-demo' : 'dist';
mkdirSync(out, { recursive: true });
writeFileSync(out + '/index.html', ${JSON.stringify(page(title, false))}.replace(demo ? /<link rel="manifest"[^>]*>/ : /$^/, ''));
if (!demo) {
  writeFileSync('dist/manifest.webmanifest', JSON.stringify({ name: ${JSON.stringify(title)}, short_name: 'Мастер', start_url: '/', display: 'standalone', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }));
  writeFileSync('dist/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#2445d4"/></svg>');
  writeFileSync('dist/sw.js', 'self.addEventListener("fetch", () => {});');
}
`;

const SERVER = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { canAssign } from './src/rules.js';
const requests = [];
createServer(async (req, res) => {
  if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ status: 'ok', database: process.env.DATABASE_URL ? 'postgres' : 'memory' })); }
  if (req.url === '/api/requests') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ requests, canAssign: canAssign('dispatcher') })); }
  const file = req.url === '/' ? '/index.html' : req.url;
  try { res.end(await readFile(new URL('./dist' + file, import.meta.url))); } catch { res.statusCode = 404; res.end('not found'); }
}).listen(Number(process.env.PORT ?? 3000));
`;

function appFiles(title: string): Array<{ path: string; content: string }> {
  return [
    { path: 'package.json', content: JSON.stringify({ name: 'master-doma', version: '1.0.0', type: 'module', scripts: { test: 'node --test', start: 'node server.js', migrate: 'node -e "0"', build: 'node build.js', 'build:demo': 'node build.js --demo' } }, null, 2) },
    { path: 'server.js', content: SERVER },
    { path: 'build.js', content: BUILD(title) },
    { path: 'src/rules.js', content: 'export const canAssign = (role) => role === "dispatcher" || role === "admin";\nexport const canSeeRequest = (role, request, userId) => role !== "master" || request.masterId === userId;\n' },
    { path: 'test/rules.test.js', content: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { canAssign, canSeeRequest } from "../src/rules.js";\ntest("only a dispatcher assigns", () => { assert.equal(canAssign("dispatcher"), true); assert.equal(canAssign("client"), false); });\ntest("a master sees only own requests", () => { assert.equal(canSeeRequest("master", { masterId: 1 }, 2), false); });\n' },
    { path: 'render.yaml', content: 'services:\n  - type: web\n    name: master-doma\n    runtime: node\n    buildCommand: npm ci && npm run build\n    startCommand: npm run migrate && npm start\n    healthCheckPath: /api/health\n    envVars:\n      - key: DATABASE_URL\n        sync: false\n      - key: SESSION_SECRET\n        generateValue: true\n' },
    { path: 'Dockerfile', content: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD ["npm","start"]\n' },
    { path: 'docker-compose.yml', content: 'services:\n  app:\n    build: .\n    ports: ["3000:3000"]\n    environment:\n      DATABASE_URL: postgres://app:app@db:5432/app\n  db:\n    image: postgres:16\n' },
    { path: '.env.example', content: 'DATABASE_URL=\nSESSION_SECRET=\n' },
  ];
}

function agentAnswer(messages: Array<{ role: string; content?: unknown }>): Json {
  const turn = messages.filter((message) => message.role === 'assistant').length;
  const task = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
  const change = task.includes('This task is a CHANGE to an existing application');
  const call = (name: string, args: Json, n: number) => ({ id: `call_${turn}_${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let calls: Json[];
  if (turn === 0 && change) {
    calls = [call('read_files', { paths: ['build.js', 'package.json'] }, 0)];
  } else if (turn === 1 && change) {
    calls = [call('write_files', { files: [{ path: 'build.js', content: BUILD('Мастер Дома — заявки') }] }, 0), call('run', { command: 'npm test && npm run build' }, 1)];
  } else if (turn === 0) {
    calls = [call('list_files', {}, 0), call('write_files', { files: appFiles('Мастер Дома') }, 1)];
  } else if (turn === 1) {
    calls = [call('run', { command: 'npm install && npm test && npm run build && npm run build:demo' }, 0)];
  } else {
    calls = [call('finish', { summary: change ? 'Заголовок приложения изменён.' : 'Приложение заявок «Мастер Дома»: клиенты, диспетчер, мастера.', done: change ? ['Новый заголовок'] : ['Заявки и статусы', 'Права: назначает только диспетчер', 'Установка на телефон'], notDone: change ? [] : ['Онлайн-оплата — на потом'] }, 0)];
  }
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }], usage: { prompt_tokens: 3000, completion_tokens: 400 } };
}

// ---- Server ----

/** Planned failures: POST /__fail?count=2&status=503 makes the next stage answers fail, to check what people see. */
let failures: { count: number; status: number } = { count: 0, status: 503 };

http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('latin1');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const reply = (value: unknown) => { const text = JSON.stringify(value); response.writeHead(200, { 'content-type': 'application/json' }).end(text); };
    if (request.url?.startsWith('/__fail')) {
      const url = new URL(request.url, 'http://local');
      failures = { count: Number(url.searchParams.get('count') ?? 1), status: Number(url.searchParams.get('status') ?? 503) };
      return reply({ planned: failures });
    }
    if (request.url?.endsWith('/audio/transcriptions')) { console.log('transcription'); return reply({ text: 'Я, диспетчер и два мастера' }); }
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.from(raw, 'latin1').toString('utf8')) as { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[]; response_format?: { json_schema?: { name: string; schema: Json } } };
    if (body.tools) {
      const answer = agentAnswer(body.messages);
      console.log(`agent turn ${body.messages.filter((m) => m.role === 'assistant').length}: ${JSON.stringify((answer.choices as Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>)[0]!.message.tool_calls.map((c) => c.function.name))}`);
      return reply(answer);
    }
    const format = body.response_format?.json_schema;
    if (!format) { response.writeHead(400).end(); return; }
    if (failures.count > 0) {
      failures.count -= 1;
      console.log(`${format.name} → planned ${failures.status}`);
      response.writeHead(failures.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: failures.status, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }));
      return;
    }
    const system = String(body.messages.find((message) => message.role === 'system')?.content ?? '');
    const userText = String(body.messages.find((message) => message.role === 'user')?.content ?? '{}');
    let user: Json = {};
    try { user = JSON.parse(userText) as Json; } catch { /* plain text prompt */ }
    const output = stageAnswer(format.name, system, user, format.schema);
    console.log(`${format.name}${format.name === 'buildpath_brief' ? ` mainAction=${(output as Brief).mainAction}` : ''}`);
    reply({ choices: [{ message: { role: 'assistant', content: JSON.stringify(output) } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } });
  });
}).listen(port, '127.0.0.1', () => console.log(`mock AI on http://127.0.0.1:${port}/v1`));

// ---- Mail: a Resend-compatible catcher, so the run can open the confirmation link (RESEND_API_URL=http://127.0.0.1:4555) ----

const mailPort = Number(process.env.MOCK_MAIL_PORT ?? 4555);
const mail: Array<{ to: string; subject: string; html: string; text: string }> = [];
http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://local');
    if (request.method === 'POST' && url.pathname === '/emails') {
      const message = JSON.parse(raw) as { to: string | string[]; subject?: string; html?: string; text?: string };
      const to = Array.isArray(message.to) ? message.to[0]! : message.to;
      mail.push({ to, subject: message.subject ?? '', html: message.html ?? '', text: message.text ?? '' });
      console.log(`mail to ${to}: ${message.subject ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `mail_${mail.length}` }));
      return;
    }
    if (url.pathname === '/last') {
      const found = [...mail].reverse().find((item) => item.to === url.searchParams.get('to'));
      response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(found ?? null));
      return;
    }
    response.writeHead(404).end();
  });
}).listen(mailPort, '127.0.0.1', () => console.log(`mock mail on http://127.0.0.1:${mailPort}`));
