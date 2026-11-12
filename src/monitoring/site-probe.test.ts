import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { probeSite } from './site-probe.js';

let status = 200;
const server = createServer((_request, response) => { response.writeHead(status).end('<!doctype html>'); });
let base = '';
before(async () => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; });
after(() => { server.close(); });

describe('site probe', () => {
  it('reports a page as up and an error page as down with its status', async () => {
    status = 200;
    const up = await probeSite(base, true);
    assert.equal(up.ok, true);
    assert.equal(up.status, 200);
    status = 502;
    assert.deepEqual({ ...(await probeSite(base, true)), ms: 0 }, { ok: false, status: 502, ms: 0, error: 'HTTP_502' });
  });
  it('refuses to call a private address for an owner domain', async () => {
    const probe = await probeSite('https://127.0.0.1/', false);
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'NOT_PUBLIC');
  });
  it('names a refused connection', async () => {
    const probe = await probeSite('http://127.0.0.1:1/', true);
    assert.equal(probe.error, 'REFUSED');
  });
});
