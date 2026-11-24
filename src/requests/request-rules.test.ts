import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cannotRespond, isOpen, parseRequest, parseResponse, payKindAllowed, responseTotalTiyn } from './request-rules.js';

const description = 'Нужно разобрать процесс записи клиентов и подготовить ТЗ для первой версии.';

test('a request needs a role, a real description and a term; the budget is optional', () => {
  assert.deepEqual(parseRequest({ role: 'lead', description, days: 10 }), { role: 'lead', description, payKind: 'any', budgetTiyn: null, days: 10 });
  assert.equal(parseRequest({ role: 'consultant', description, days: 5, payKind: 'fixed', budget: 50_000 }).budgetTiyn, 5_000_000);
  assert.throws(() => parseRequest({ role: 'owner', description, days: 5 }), /INVALID_ROLE/);
  assert.throws(() => parseRequest({ role: 'lead', description: 'коротко', days: 5 }), /INVALID_DESCRIPTION/);
  assert.throws(() => parseRequest({ role: 'lead', description, days: 0 }), /INVALID_DAYS/);
  assert.throws(() => parseRequest({ role: 'lead', description, days: 5, budget: 10 }), /INVALID_BUDGET/);
  assert.throws(() => parseRequest({ role: 'lead', description, days: 5, extra: 1 }), /UNKNOWN_FIELD/);
});

test('a response carries terms like an invitation: a fixed price, or a rate with an hour limit', () => {
  const message = 'Делала запись для трёх салонов, начну с разбора отмен и переносов.';
  assert.deepEqual(parseResponse({ message, payKind: 'fixed', fixedAmount: 40_000, days: 7 }), { message, payKind: 'fixed', fixedAmountTiyn: 4_000_000, hourlyRateTiyn: null, hourLimit: null, days: 7 });
  const hourly = parseResponse({ message, payKind: 'hourly', hourlyRate: 5_000, hourLimit: 12, days: 7 });
  assert.equal(hourly.hourlyRateTiyn, 500_000);
  assert.equal(responseTotalTiyn(hourly), 6_000_000);
  assert.throws(() => parseResponse({ message, payKind: 'hourly', hourlyRate: 5_000, days: 7 }), /INVALID_HOURLIMIT/);
  assert.throws(() => parseResponse({ message, payKind: 'none', days: 7 }), /INVALID_PAYKIND/);
  assert.throws(() => parseResponse({ message: 'ок', payKind: 'fixed', fixedAmount: 40_000, days: 7 }), /INVALID_MESSAGE/);
});

test('a response must pay the way the owner asked', () => {
  assert.equal(payKindAllowed('any', 'hourly'), true);
  assert.equal(payKindAllowed('fixed', 'fixed'), true);
  assert.equal(payKindAllowed('fixed', 'hourly'), false);
});

test('only a published catalog card outside the project may respond', () => {
  const base = { profile: 'published' as const, memberOfProject: false, assignedToStage: false, isAuthor: false };
  assert.equal(cannotRespond(base), null);
  assert.equal(cannotRespond({ ...base, profile: 'draft' }), 'PROFILE_NOT_PUBLISHED');
  assert.equal(cannotRespond({ ...base, profile: 'none' }), 'PROFILE_NOT_PUBLISHED');
  assert.equal(cannotRespond({ ...base, profile: 'blocked' }), 'PROFILE_BLOCKED');
  assert.equal(cannotRespond({ ...base, memberOfProject: true }), 'OWN_PROJECT');
  assert.equal(cannotRespond({ ...base, isAuthor: true }), 'OWN_PROJECT');
  assert.equal(cannotRespond({ ...base, assignedToStage: true }), 'ALREADY_ON_STAGE');
});

test('a request is open until filled, cancelled or past its closing time', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  assert.equal(isOpen({ status: 'open', closesAt: new Date('2026-11-25T00:00:00Z') }, now), true);
  assert.equal(isOpen({ status: 'open', closesAt: new Date('2026-11-24T00:00:00Z') }, now), false);
  assert.equal(isOpen({ status: 'filled', closesAt: new Date('2026-11-25T00:00:00Z') }, now), false);
});
