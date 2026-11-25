import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateProcess } from './process.js';
import { buildAppPlan, normalizeFeatures, templateFeatures } from './webapp.js';
import { reviewStage } from './stage-review.js';
import { sameTechPlan, techPlanMarkdown } from './techplan.js';
import { designIssues, expandedSchema, normalizeDesign, type ArchitectureDesign } from './architecture.js';

const process = () => templateProcess('web_app', null);
const spec = () => normalizeFeatures({ ...templateFeatures(null, process(), 'app'), services: [{ name: 'Kaspi Pay', purpose: 'Оплата', accessBy: 'owner' }], quality: { dataLocation: 'Казахстан', backups: 'Каждый день' } });
const plan = (design: ArchitectureDesign | null = null) => buildAppPlan({ brief: null, process: process(), features: spec(), screens: null }, null, design);

test('the first design follows the process and the ТЗ: typed schema, components, decisions to make, threats', () => {
  const design = plan().design!;
  const user = design.schema.entities.find((entity) => entity.key === 'user')!;
  assert.ok(user.fields.some((field) => field.type === 'email' && field.unique));
  assert.ok(user.fields[0]!.required);
  const kinds = design.components.map((item) => item.kind);
  for (const kind of ['web_client', 'server_api', 'database', 'auth', 'payments'] as const) assert.ok(kinds.includes(kind), kind);
  assert.ok(design.components.some((item) => item.name === 'Kaspi Pay'));
  assert.deepEqual(design.decisions.map((item) => item.quality), ['dataLocation', 'backups']);
  assert.ok(design.threats.some((threat) => threat.asset === 'personal_data'));
  assert.ok(design.threats.some((threat) => threat.asset === 'money'));
  assert.ok(design.threats.every((threat) => threat.mitigation));
  // Decisions are still to be made: the only findings of the first design.
  assert.deepEqual([...new Set(designIssues(design, spec()).map((issue) => issue.code))].sort(), ['ARCH_DECISION_OPEN', 'ARCH_QUALITY_NO_DECISION']);
});

test('many-to-many gets its link table; a link to a removed record stops being a link', () => {
  const design = normalizeDesign({ schema: {
    entities: [
      { key: 'master', name: 'Мастер', fields: [{ name: 'Имя', type: 'text', required: true }] },
      { key: 'service', name: 'Услуга', fields: [{ name: 'Цена', type: 'money' }, { name: 'Мастер', type: 'ref', ref: 'ghost' }] },
    ],
    relations: [{ from: 'master', to: 'service', kind: 'many_many', label: 'делает' }, { from: 'master', to: 'nobody', kind: 'one_many' }],
  } });
  assert.equal(design.schema.relations.length, 1);
  assert.deepEqual([design.schema.entities[1]!.fields[1]!.type, design.schema.entities[1]!.fields[1]!.ref], ['text', null]);
  const expanded = expandedSchema(design.schema);
  const junction = expanded.find((entity) => entity.junction)!;
  assert.equal(junction.name, 'Мастер ↔ Услуга');
  assert.deepEqual(junction.fields.map((field) => [field.type, field.ref, field.required]), [['ref', 'master', true], ['ref', 'service', true]]);
  // Only catalog components exist: an unknown kind is dropped, not drawn.
  assert.deepEqual(normalizeDesign({ components: [{ kind: 'quantum_computer', name: 'Q' }, { kind: 'database', name: 'БД' }] }).components.map((item) => item.kind), ['database']);
});

test('what the architecture owes the ТЗ: its data, its services, money and personal data threats', () => {
  const base = plan().design!;
  const broken = normalizeDesign({
    ...base,
    schema: { entities: base.schema.entities.filter((entity) => entity.key === 'user'), relations: [] },
    components: base.components.filter((item) => item.kind !== 'payments' && item.kind !== 'database'),
    threats: base.threats.filter((threat) => threat.asset !== 'money').map((threat, index) => index === 0 ? { ...threat, mitigation: '' } : threat),
  });
  const codes = designIssues(broken, spec()).map((issue) => issue.code);
  for (const code of ['ARCH_ENTITY_MISSING', 'ARCH_CORE_MISSING', 'ARCH_SERVICE_MISSING', 'ARCH_THREATS_MONEY', 'ARCH_THREAT_NO_MITIGATION']) assert.ok(codes.includes(code), code);
  const review = reviewStage('techplan', plan(broken), { features: spec(), projectType: 'web_app' }).findings;
  assert.ok(review.some((finding) => finding.code === 'ARCH_THREATS_MONEY' && finding.category === 'security'));
});

test('the plan follows the edited design: data model, components, API contract and the document', () => {
  const base = plan().design!;
  const edited = normalizeDesign({ ...base, schema: { ...base.schema, entities: [...base.schema.entities, { key: 'review', name: 'Отзыв', fields: [{ name: 'Оценка', type: 'number', required: true }, { name: 'Статус', type: 'status', options: ['на проверке', 'опубликован'] }] }] } });
  const result = plan(edited);
  const review = result.dataModel.find((entity) => entity.key === 'review')!;
  assert.deepEqual(review.fields.map((field) => [field.name, field.type]), [['Оценка *', 'число'], ['Статус', 'статус из списка: на проверке, опубликован']]);
  assert.match(result.api, /Отзыв/);
  assert.ok(result.components.some((item) => item.title === 'Kaspi Pay'));
  const markdown = techPlanMarkdown(result);
  for (const part of ['## Схема данных', '### Отзыв', '| Оценка | число | ✓ |', '## Компоненты', '## Решения', '## Угрозы и меры']) assert.ok(markdown.includes(part), part);
  // Accepting compares with the plan built from the same design; another design gives another plan.
  assert.ok(sameTechPlan(plan(edited), result));
  assert.ok(!sameTechPlan(plan(), result));
});
