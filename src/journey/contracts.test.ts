import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Brief } from './artifacts.js';
import { ArtifactValidationError } from './artifacts.js';
import { projectTypes, routeInputs, stageDefinitions } from './catalog.js';
import { contractIssues, contractsChanges, contractsMarkdown, contractsMigration, contractsOpenApi, normalizeContracts, templateContracts } from './contracts.js';
import { templateProcess } from './process.js';
import { reviewStage } from './stage-review.js';
import { stageOutputs } from './stage-outputs.js';
import { buildAppPlan, buildHandoff, templateFeatures, templateScreens } from './webapp.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

function setup() {
  const process = templateProcess('web_app', brief);
  const features = templateFeatures(brief, process);
  const screens = templateScreens(features);
  const plan = buildAppPlan({ brief, process, features, screens }, null);
  return { process, features, screens, plan, design: plan.design! };
}

describe('contracts of a web application', () => {
  it('sit between the architecture and the package and read the ТЗ and the architecture', () => {
    const stages = projectTypes.web_app.stages;
    assert.equal(stages[stages.indexOf('techplan') + 1], 'contracts');
    assert.equal(stages[stages.indexOf('contracts') + 1], 'handoff');
    assert.deepEqual(routeInputs(stages, 'contracts'), ['process', 'features', 'techplan']);
    assert.ok(routeInputs(stages, 'handoff').includes('contracts'));
    // Sites have no contracts stage: the platform builds them itself.
    assert.ok(!projectTypes.booking.stages.includes('contracts'));
    assert.equal(stageDefinitions.contracts.ai.level, 'none');
  });

  it('the first draft follows the access matrix: no operation is wider than the ТЗ allows, every must feature is covered', () => {
    const { process, features, design } = setup();
    const value = templateContracts({ design, features, process });
    assert.ok(value.modules.length >= 2);
    assert.ok(value.operations.some((operation) => operation.path === '/api/auth/login' && operation.roles.length === 0));
    assert.deepEqual(contractIssues(value, features, design).filter((issue) => issue.severity !== 'minor').map((issue) => issue.code), []);
    for (const operation of value.operations.filter((item) => item.entity && item.entity !== 'user' && item.action !== 'other')) {
      for (const role of operation.roles) assert.ok(features.access.some((row) => row.role === role && row.data === operation.entity && row.actions.includes(operation.action as never)), `${operation.key}:${role}`);
      assert.ok(operation.errors.some((error) => error.status === 403), operation.key);
      if (operation.path.endsWith('{id}')) assert.ok(operation.errors.some((error) => error.status === 404), operation.key);
    }
    // One owner per record.
    const owned = value.modules.flatMap((module) => module.owns);
    assert.equal(new Set(owned).size, owned.length);
    assert.ok(stageOutputs('contracts', value, { features, design }).filter((item) => item.level === 'required').every((item) => item.met));
  });

  it('finds what makes them unusable as a contract', () => {
    const { process, features, design } = setup();
    const value = templateContracts({ design, features, process });
    const target = value.operations.find((operation) => operation.entity && operation.entity !== 'user' && operation.action === 'delete') ?? value.operations.find((operation) => operation.entity && operation.entity !== 'user')!;
    const client = features.roles.find((role) => !features.access.some((row) => row.role === role.key && row.data === target.entity && row.actions.includes(target.action as never)))!;
    const broken = {
      ...value,
      modules: [...value.modules, { key: 'dup', name: 'Ещё модуль', owns: [value.modules[1]!.owns[0]!], features: [] }],
      operations: [...value.operations.map((operation) => operation.key === target.key ? { ...operation, roles: [...operation.roles, client.key] } : operation),
        { ...value.operations[3]!, key: 'copy' }, { ...value.operations[3]!, key: 'open', path: '/api/open', roles: [], errors: [] }],
      integrations: [{ key: 'pay', service: 'Kaspi', call: 'Счёт', onError: '' }],
    };
    const codes = contractIssues(normalizeContracts(broken), features, design).map((issue) => issue.code);
    for (const code of ['CONTRACT_DUPLICATE_OPERATION', 'CONTRACT_ROLE_NOT_ALLOWED', 'CONTRACT_OPERATION_OPEN', 'CONTRACT_NO_ERRORS', 'CONTRACT_TWO_OWNERS', 'CONTRACT_INTEGRATION_NO_FALLBACK']) assert.ok(codes.includes(code), code);
    const review = reviewStage('contracts', normalizeContracts(broken), { features, design });
    assert.ok(review.blocking > 0);
    assert.ok(review.findings.some((finding) => finding.code === 'CONTRACT_ROLE_NOT_ALLOWED' && finding.category === 'security'));
    // A path that could break the YAML it is written into is refused on input.
    assert.throws(() => normalizeContracts({ modules: [{ name: 'M' }], operations: [{ path: '/api/x\n  evil: 1', method: 'GET' }] }), ArtifactValidationError);
    assert.throws(() => normalizeContracts({ modules: [{ name: 'M' }], operations: [{ path: '/other', method: 'GET' }] }), ArtifactValidationError);
  });

  it('turns into OpenAPI, a migration and a readable description; the package carries them', () => {
    const { process, features, screens, plan, design } = setup();
    const value = templateContracts({ design, features, process });
    const api = contractsOpenApi('Сервис Клин', value, design, features);
    assert.match(api, /^openapi: 3\.1\.0/);
    assert.match(api, /x-roles:/);
    assert.match(api, /\/api\/auth\/login:\n {4}post:\n(.*\n)*? {6}security: \[\]/);
    const sql = contractsMigration(design);
    for (const entity of design.schema.entities) assert.ok(sql.includes(`CREATE TABLE "${entity.key}"`), entity.key);
    assert.ok(sql.indexOf('ALTER TABLE') > sql.lastIndexOf('CREATE TABLE'));
    assert.match(contractsMarkdown(value, features), /## Модули/);
    const pack = buildHandoff({ brief, process, features, screens, plan, contracts: value, locale: 'ru', sourceVersionIds: {} });
    assert.equal(pack.files.find((file) => file.name === 'api.yaml')!.content, api);
    assert.ok(pack.files.some((file) => file.name === 'schema.sql'));
    assert.ok(pack.files.find((file) => file.name === 'README.md')!.content.includes('schema.sql'));
    // Without contracts (an older package) the plan's draft stays.
    assert.equal(buildHandoff({ brief, process, features, screens, plan, locale: 'ru', sourceVersionIds: {} }).files.find((file) => file.name === 'api.yaml')!.content, plan.api);
  });

  it('change notices say which operations changed', () => {
    const { process, features, design } = setup();
    const value = templateContracts({ design, features, process });
    const next = { ...value, operations: value.operations.slice(1).map((operation, index) => index === 1 ? { ...operation, roles: [] } : operation) };
    const lines = contractsChanges(value, next);
    assert.ok(lines.some((line) => line.startsWith('Убрана операция')));
    assert.ok(lines.some((line) => line.startsWith('Изменены права')));
  });
});
