import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Brief } from './artifacts.js';
import { projectTypes, routeInputs } from './catalog.js';
import { templateContracts } from './contracts.js';
import { templateProcess } from './process.js';
import { findCycle, normalizeRoadmap, roadmapIssues, roadmapMarkdown, scheduleOf, templateRoadmap, type Roadmap } from './roadmap.js';
import { workingDaysFrom } from './roadmap-progress.service.js';
import { reviewStage } from './stage-review.js';
import { stageOutputs } from './stage-outputs.js';
import { buildAppPlan, templateFeatures, templateScreens } from './webapp.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

function setup() {
  const process = templateProcess('web_app', brief);
  const features = templateFeatures(brief, process);
  const plan = buildAppPlan({ brief, process, features, screens: templateScreens(features) }, null);
  const contracts = templateContracts({ design: plan.design!, features, process });
  return { features, contracts, design: plan.design!, roadmap: templateRoadmap({ contracts, features, design: plan.design!, idea: null }) };
}

const tiny = (modules: Array<[string, string[], number]>): Roadmap => normalizeRoadmap({
  hoursPerDay: 6, modules: modules.map(([key, dependsOn, hours]) => ({ key, name: key.toUpperCase(), dependsOn, executor: 'ai', tasks: [{ key: `t_${key}`, title: 'x', hours, release: 1 }] })),
});

describe('implementation plan of a web application', () => {
  it('comes after the contracts and goes into the package', () => {
    const stages = projectTypes.web_app.stages;
    assert.equal(stages[stages.indexOf('contracts') + 1], 'roadmap');
    assert.deepEqual(routeInputs(stages, 'roadmap'), ['idea', 'features', 'techplan', 'contracts']);
    assert.ok(routeInputs(stages, 'handoff').includes('roadmap'));
  });

  it('the first plan follows the contract modules, starts from the foundation and has no gaps', () => {
    const { features, contracts, roadmap } = setup();
    assert.equal(roadmap.modules[0]!.key, 'setup');
    for (const module of contracts.modules) assert.ok(roadmap.modules.some((item) => item.contractModule === module.key), module.key);
    for (const feature of features.features.filter((item) => item.priority === 'must')) assert.ok(roadmap.modules.some((module) => module.tasks.some((task) => task.feature === feature.key)), feature.key);
    assert.equal(findCycle(roadmap), null);
    assert.deepEqual(roadmapIssues(roadmap, features, contracts).filter((issue) => issue.severity !== 'minor').map((issue) => issue.code), []);
    assert.ok(stageOutputs('roadmap', roadmap, { features, contracts }).filter((item) => item.level === 'required').every((item) => item.met));
    const keys = roadmap.modules.flatMap((module) => module.tasks.map((task) => task.key));
    assert.equal(new Set(keys).size, keys.length);
    assert.match(roadmapMarkdown(roadmap, features), /```mermaid\ngraph LR/);
  });

  it('parallel branches run in parallel: the finish is decided by the longest chain', () => {
    // a → b (10 h) and a → c (2 h), both → d: the critical path goes through b.
    const plan = tiny([['a', [], 4], ['b', ['a'], 10], ['c', ['a'], 2], ['d', ['b', 'c'], 3]]);
    const schedule = scheduleOf(plan)!;
    assert.deepEqual(schedule.criticalPath, ['a', 'b', 'd']);
    assert.equal(schedule.totalHours, 19);
    assert.equal(schedule.days, Math.ceil(17 / 6));
    assert.equal(schedule.modules.find((item) => item.key === 'c')!.critical, false);
    assert.equal(schedule.modules.find((item) => item.key === 'd')!.level, 2);
  });

  it('a cycle has no schedule and blocks acceptance', () => {
    const plan = tiny([['a', ['c'], 1], ['b', ['a'], 1], ['c', ['b'], 1]]);
    assert.ok(findCycle(plan));
    assert.equal(scheduleOf(plan), null);
    const review = reviewStage('roadmap', plan, {});
    assert.ok(review.findings.some((finding) => finding.code === 'ROADMAP_CYCLE' && finding.severity === 'blocking'));
    // A dependency on a module that does not exist or on itself is dropped on input.
    assert.deepEqual(tiny([['a', ['a', 'zzz'], 1]]).modules[0]!.dependsOn, []);
  });

  it('finds what is missing', () => {
    const { features, contracts, roadmap } = setup();
    const broken = { ...roadmap, modules: roadmap.modules.filter((module) => module.contractModule !== contracts.modules[1]!.key).map((module, index) => index === 0 ? { ...module, tasks: module.tasks.map((task) => ({ ...task, hours: 0 })) } : module) };
    const codes = roadmapIssues(normalizeRoadmap(broken), features, contracts).map((issue) => issue.code);
    for (const code of ['ROADMAP_CONTRACT_MODULE_MISSING', 'ROADMAP_NO_ESTIMATE', 'ROADMAP_NO_RISKS']) assert.ok(codes.includes(code), code);
  });

  it('counts working days without weekends', () => {
    assert.equal(workingDaysFrom(new Date('2026-11-27'), 1).toISOString().slice(0, 10), '2026-11-30'); // Friday → Monday
    assert.equal(workingDaysFrom(new Date('2026-11-25'), 0).toISOString().slice(0, 10), '2026-11-25');
  });
});
