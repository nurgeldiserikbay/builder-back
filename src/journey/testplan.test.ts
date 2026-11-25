import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Brief } from './artifacts.js';
import { projectTypes, routeInputs } from './catalog.js';
import { templateContracts } from './contracts.js';
import { templateProcess } from './process.js';
import { templateRoadmap } from './roadmap.js';
import { reviewStage } from './stage-review.js';
import { stageOutputs } from './stage-outputs.js';
import { CASE_CLASSES, normalizeTestPlan, templateTestPlan, testPlanIssues, testPlanMarkdown } from './testplan.js';
import { buildAppPlan, templateFeatures, templateScreens } from './webapp.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

function setup() {
  const process = templateProcess('web_app', brief);
  const features = { ...templateFeatures(brief, process), sensitivity: 'personal' as const };
  const plan = buildAppPlan({ brief, process, features, screens: templateScreens(features) }, null);
  const design = plan.design!;
  const contracts = templateContracts({ design, features, process });
  const roadmap = templateRoadmap({ contracts, features, design, idea: null });
  return { process, features, design, contracts, roadmap, plan: templateTestPlan({ features, contracts, design, roadmap, process }) };
}

describe('test plan of a web application', () => {
  it('comes after the implementation plan and goes into the package', () => {
    const stages = projectTypes.web_app.stages;
    assert.equal(stages[stages.indexOf('roadmap') + 1], 'testplan');
    assert.ok(routeInputs(stages, 'handoff').includes('testplan'));
  });

  it('the draft covers every must feature, every threat and the classes that apply, and links cases to plan tasks', () => {
    const { features, design, roadmap, plan } = setup();
    for (const kind of ['normal', 'mistakes', 'rights', 'security', 'dishonest', 'data_law', 'failures', 'devices'] as const) assert.ok(plan.cases.some((item) => item.class === kind), kind);
    for (const threat of design.threats) assert.ok(plan.cases.some((item) => item.links.includes(`threat:${threat.key}`)), threat.key);
    assert.deepEqual(testPlanIssues(plan, features, design).filter((issue) => issue.severity !== 'minor').map((issue) => issue.code), []);
    assert.ok(stageOutputs('testplan', plan, { features, design }).filter((item) => item.level === 'required').every((item) => item.met));
    const tasks = new Set(roadmap.modules.flatMap((module) => module.tasks.map((task) => task.key)));
    assert.ok(plan.cases.filter((item) => item.task).every((item) => tasks.has(item.task!)));
    assert.ok(plan.cases.filter((item) => item.task).length >= plan.cases.length / 2);
    // A role the matrix does not allow is checked by a direct request; «own» records are checked against a guessed number.
    assert.ok(plan.cases.some((item) => item.class === 'rights' && /404/.test(item.expected)));
    assert.ok(plan.cases.every((item) => item.plain.startsWith('Мы проверим')));
    assert.match(testPlanMarkdown(plan, features), /Что мы проверим — простыми словами/);
  });

  it('finds what is missing, and an explained class is not a gap', () => {
    const { features, design, plan } = setup();
    const thin = normalizeTestPlan({ cases: plan.cases.filter((item) => item.class === 'normal').map((item, index) => (index === 0 ? { ...item, expected: '' } : item)) });
    const codes = testPlanIssues(thin, features, design).map((issue) => issue.code);
    for (const code of ['TESTPLAN_NO_RIGHTS', 'TESTPLAN_THREAT_UNCOVERED', 'TESTPLAN_SENSITIVE_UNCOVERED', 'TESTPLAN_NO_EXPECTED', 'TESTPLAN_CLASS_EMPTY']) assert.ok(codes.includes(code), code);
    const explained = normalizeTestPlan({ ...thin, skipped: CASE_CLASSES.map((kind) => ({ class: kind, why: 'Нет в первой версии' })) });
    assert.ok(!testPlanIssues(explained, features, design).some((issue) => issue.code === 'TESTPLAN_CLASS_EMPTY' || issue.code === 'TESTPLAN_SENSITIVE_UNCOVERED'));
    assert.ok(reviewStage('testplan', thin, { features, design }).findings.some((finding) => finding.code === 'TESTPLAN_THREAT_UNCOVERED' && finding.category === 'security'));
  });
});
