import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dataNames, screenAccessIssues, screenData } from './screen-access.js';
import { templateScreens, type AppFeatures, type AppScreens } from './webapp.js';

const features = (): AppFeatures => ({
  roles: [{ key: 'client', name: 'Клиент', description: '' }, { key: 'master', name: 'Мастер', description: '' }],
  features: [
    { key: 'signin', title: 'Вход', description: '', roles: ['client', 'master'], priority: 'must', acceptance: [], data: ['user'], story: '', cases: [], sources: [] },
    { key: 'book', title: 'Запись', description: 'Записаться', roles: ['client'], priority: 'must', acceptance: [], data: ['booking'], story: '', cases: [], sources: [] },
    { key: 'schedule', title: 'Расписание', description: 'Смотреть записи', roles: ['master'], priority: 'must', acceptance: [], data: ['booking'], story: '', cases: [], sources: [] },
    { key: 'prices', title: 'Цены', description: 'Цены услуг', roles: ['master'], priority: 'should', acceptance: [], data: ['service'], story: '', cases: [], sources: [] },
  ],
  sensitivity: 'personal', integrations: [], summary: '', requirements: [], limits: [], questions: [],
  access: [
    { key: 'a1', role: 'client', data: 'booking', actions: ['view', 'create'], scope: 'own' },
    { key: 'a2', role: 'master', data: 'booking', actions: ['view'], scope: 'all' },
    { key: 'a3', role: 'master', data: 'service', actions: ['view', 'create', 'edit', 'delete'], scope: 'all' },
  ],
  quality: { speed: '', users: '', languages: '', devices: '', accessibility: '', dataLocation: '', backups: '', retention: '' }, services: [],
});
const names = dataNames({ actors: [], scenarios: [], data: [{ key: 'booking', name: 'Запись', fields: [], links: [] }, { key: 'service', name: 'Услуга', fields: [], links: [] }] } as never);
const screen = (key: string, role: string, featureKeys: string[], kinds: Array<'list' | 'form' | 'details'>) => ({ key, title: key, role, purpose: '', features: featureKeys, links: [], blocks: kinds.map((kind) => ({ kind, title: kind, fields: ['Поле'] })) });

describe('screens and the access matrix', () => {
  it('the template gives each role a list where it may look and a form only where it may create or change', () => {
    const value = templateScreens(features());
    const schedule = value.screens.find((item) => item.key === 'master_schedule')!;
    assert.deepEqual(schedule.blocks.map((block) => block.kind), ['list'], 'the master may only look at bookings');
    const book = value.screens.find((item) => item.key === 'client_book')!;
    assert.deepEqual(book.blocks.map((block) => block.kind), ['list', 'form']);
    assert.equal(book.blocks[0]!.title, 'Мои: Запись', 'a client sees only their own');
    assert.deepEqual(screenAccessIssues(value, features(), names), [], 'the template agrees with the matrix');
  });

  it('finds screens that offer a role more than the ТЗ allows, and rights no screen uses', () => {
    const value: AppScreens = { screens: [
      screen('home_client', 'client', ['signin'], ['details']),
      screen('client_prices', 'client', ['prices'], ['list']),
      screen('home_master', 'master', ['signin'], ['details']),
      screen('master_schedule', 'master', ['schedule'], ['list', 'form']),
    ] };
    const issues = screenAccessIssues(value, features(), names);
    const codes = issues.map((issue) => `${issue.code}:${issue.target}`).sort();
    assert.deepEqual(codes, [
      'SCREENS_CREATE_MISSING:client', 'SCREENS_CREATE_MISSING:master',
      'SCREENS_DATA_NOT_ALLOWED:client_prices', 'SCREENS_FEATURE_NOT_FOR_ROLE:client_prices', 'SCREENS_FORM_NOT_ALLOWED:master_schedule',
    ]);
    assert.match(issues.find((issue) => issue.code === 'SCREENS_DATA_NOT_ALLOWED')!.message, /«Услуга»/);
    assert.deepEqual(screenData(value.screens[3]!, features(), names), [{ entity: 'booking', name: 'Запись', actions: ['view'], scope: 'all' }]);
  });

  it('a role that may only create is not shown a list of records', () => {
    const spec = features();
    spec.access = spec.access.map((row) => (row.role === 'client' ? { ...row, actions: ['create'] } : row));
    const issues = screenAccessIssues({ screens: [screen('client_book', 'client', ['book'], ['list'])] }, spec, names);
    assert.ok(issues.some((issue) => issue.code === 'SCREENS_VIEW_NOT_ALLOWED'));
  });

  it('an older ТЗ without a matrix: no such checks, the template keeps both blocks', () => {
    const spec = { ...features(), access: [] };
    assert.deepEqual(screenAccessIssues({ screens: [screen('x', 'client', ['prices'], ['form'])] }, spec, names), []);
    assert.deepEqual(templateScreens(spec).screens.find((item) => item.key === 'master_schedule')!.blocks.map((block) => block.kind), ['list', 'form']);
  });
});
