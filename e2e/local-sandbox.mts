// A sandbox server for local development and the browser end-to-end run. The API sends the agent's files and commands here
// (SANDBOX_PROVIDER=local-http, SANDBOX_HTTP_URL=http://127.0.0.1:4570); they run in a throwaway folder of this separate
// process, never in the API. It is NOT an isolated machine: run it only on your own computer, only with code you trust
// (the end-to-end run's scripted agent), and never in production — the API refuses it there.
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = Number(process.env.LOCAL_SANDBOX_PORT ?? 4570);
const spaces = new Map<string, { dir: string; timer: NodeJS.Timeout }>();

const inside = (dir: string, file: string) => {
  const full = path.resolve(dir, file);
  return full.startsWith(`${dir}${path.sep}`) ? full : null;
};
const body = (request: http.IncomingMessage) => new Promise<string>((resolve) => {
  let data = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { data += chunk; }); request.on('end', () => resolve(data));
});
const send = (response: http.ServerResponse, status: number, value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  response.writeHead(status, { 'content-type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(text);
};

http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://local');
  const [, root, id, action] = url.pathname.split('/');
  if (root !== 'workspaces') return send(response, 404, 'not found');
  if (!id && request.method === 'POST') {
    const { lifetimeMs } = JSON.parse(await body(request) || '{}') as { lifetimeMs?: number };
    const dir = await mkdtemp(path.join(tmpdir(), 'bp-sandbox-'));
    const key = randomUUID();
    const timer = setTimeout(() => { void rm(dir, { recursive: true, force: true }); spaces.delete(key); }, Math.min(lifetimeMs ?? 1_800_000, 3_600_000));
    spaces.set(key, { dir, timer });
    return send(response, 201, { id: key });
  }
  const space = id ? spaces.get(id) : undefined;
  if (!space) return send(response, 404, 'no such workspace');
  if (!action && request.method === 'DELETE') {
    clearTimeout(space.timer); spaces.delete(id!); await rm(space.dir, { recursive: true, force: true });
    return send(response, 200, { closed: true });
  }
  if (action === 'files') {
    const file = inside(space.dir, url.searchParams.get('path') ?? '');
    if (!file) return send(response, 400, 'bad path');
    if (request.method === 'PUT') { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, await body(request)); return send(response, 200, { written: true }); }
    const content = await readFile(file, 'utf8').catch(() => null);
    return content === null ? send(response, 404, 'no such file') : send(response, 200, content);
  }
  if (action === 'exec' && request.method === 'POST') {
    const { command, timeoutMs } = JSON.parse(await body(request)) as { command: string; timeoutMs: number };
    const at = Date.now();
    // Only CI=1 and a PATH, as in the real sandbox; HOME and the npm cache stay inside the folder.
    exec(command, { cwd: space.dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: space.dir, CI: '1', npm_config_cache: path.join(space.dir, '.npm') } }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: number; killed?: boolean }) | null;
      send(response, 200, { exitCode: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0, stdout, stderr, timedOut: Boolean(failure?.killed), durationMs: Date.now() - at });
    });
    return;
  }
  send(response, 404, 'not found');
}).listen(port, '127.0.0.1', () => console.log(`local sandbox on http://127.0.0.1:${port}`));
