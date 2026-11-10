import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { domainProblem, isApex, normalizeDomain, pointsHere, recordsFor } from './domain.js';

const target = { cname: 'sites.buildpath.kz', ipv4: ['203.0.113.10'], hostedInKz: false };
const resolver = (cname: string[], a: string[]) => ({ resolveCname: async () => cname, resolve4: async () => a });

describe('Own domain', () => {
  it('normalizes what people paste and converts Cyrillic names', () => {
    assert.equal(normalizeDomain(' https://Www.Barber-Usy.com/ '), 'www.barber-usy.com');
    assert.match(normalizeDomain('барбер.қаз') ?? '', /^xn--[a-z0-9]+\.xn--80ao21a$/);
    for (const bad of ['localhost', '127.0.0.1', 'a..b.com', '-x.com', 'shop.com:8080', 'user@shop.com', 'x.1']) assert.equal(normalizeDomain(bad), null, bad);
  });

  it('refuses platform addresses and .kz without Kazakhstan hosting', () => {
    assert.equal(domainProblem('usy.buildpath.site', 'buildpath.site', target), 'DOMAIN_IS_PLATFORM');
    assert.equal(domainProblem('usy.kz', 'buildpath.site', target), 'DOMAIN_KZ_NEEDS_KZ_HOSTING');
    assert.equal(domainProblem('usy.kz', 'buildpath.site', { ...target, hostedInKz: true }), null);
    assert.equal(domainProblem('usy.com', 'buildpath.site', target), null);
  });

  it('asks for a CNAME on a subdomain and A records on the main name', () => {
    assert.equal(isApex('usy.com'), true); assert.equal(isApex('usy.com.kz'), true); assert.equal(isApex('www.usy.com'), false);
    assert.deepEqual(recordsFor('www.usy.com', target), [{ type: 'CNAME', name: 'www', value: 'sites.buildpath.kz' }]);
    assert.deepEqual(recordsFor('usy.com', target), [{ type: 'A', name: '@', value: '203.0.113.10' }]);
  });

  it('checks that DNS points here', async () => {
    assert.equal((await pointsHere('www.usy.com', target, resolver(['sites.buildpath.kz.'], []))).ok, true);
    assert.equal((await pointsHere('usy.com', target, resolver([], ['203.0.113.10']))).ok, true);
    assert.equal((await pointsHere('usy.com', target, resolver([], ['203.0.113.10', '198.51.100.7']))).ok, false);
    assert.deepEqual(await pointsHere('usy.com', target, resolver([], [])), { ok: false, found: [] });
  });
});
