import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../i18n/en.js';
import { projectTypes, stageDefinitions, type StageKey } from './catalog.js';
import { PHASES, STAGE_GUIDES, STAGE_PASSPORTS, STAGE_PHASE, phasesOf } from './phases.js';

const route = (type: keyof typeof projectTypes, done: StageKey[] = []) => projectTypes[type].stages.map((key) => ({ key, done: done.includes(key) }));

describe('phases of the common path', () => {
  it('every stage belongs to a phase and has a guide translated into English', () => {
    for (const key of Object.keys(stageDefinitions) as StageKey[]) {
      assert.ok(PHASES.some((phase) => phase.key === STAGE_PHASE[key]), key);
      const guide = STAGE_GUIDES[key];
      for (const text of [guide.why, guide.next, guide.example, ...guide.terms.flatMap((term) => [term.term, term.meaning])]) assert.ok(en[text], `${key}: «${text}»`);
    }
    for (const phase of PHASES) assert.ok(en[phase.title] && en[phase.short], phase.key);
  });

  it('every stage has a passport: how it goes, what is checked and one «done when», all translated', () => {
    for (const key of Object.keys(stageDefinitions) as StageKey[]) {
      const passport = STAGE_PASSPORTS[key];
      assert.ok(passport.steps.length >= 2 && passport.checks.length >= 1 && passport.doneWhen.length > 20, key);
      for (const text of [...passport.steps, ...passport.checks, passport.doneWhen]) assert.ok(en[text], `${key}: «${text}»`);
    }
  });

  it('a website goes idea → … → build → launch → after launch, and the stages keep the route order', () => {
    const phases = phasesOf(route('booking'), { applies: true, live: false });
    assert.deepEqual(phases.map((phase) => phase.key), ['idea', 'spec', 'experience', 'tech', 'content', 'build', 'launch', 'after']);
    const order = phases.flatMap((phase) => phase.stageKeys);
    assert.deepEqual(order, projectTypes.booking.stages.filter((key) => order.includes(key)));
    assert.equal(phases[0]!.status, 'current');
    assert.ok(phases.slice(1).every((phase) => phase.status === 'upcoming'));
  });

  it('progress moves the current phase; publishing finishes the launch and the life after it goes on', () => {
    const all = projectTypes.landing.stages;
    const before = phasesOf(route('landing', all), { applies: true, live: false });
    assert.equal(before.find((phase) => phase.status === 'current')?.key, 'launch');
    const live = phasesOf(route('landing', all), { applies: true, live: true });
    assert.equal(live.find((phase) => phase.key === 'launch')?.status, 'done');
    assert.equal(live.find((phase) => phase.key === 'after')?.status, 'current');
    const half = phasesOf(route('landing', ['goal', 'idea', 'process', 'suggestions', 'concept', 'features']), { applies: true, live: false });
    assert.equal(half.find((phase) => phase.key === 'idea')?.status, 'done');
    assert.equal(half.find((phase) => phase.status === 'current')?.key, 'tech');
  });

  it('an app ends with the developer package: no launch phase yet; specialists see no launch either', () => {
    const app = phasesOf(route('web_app'), null);
    assert.deepEqual(app.map((phase) => phase.key), ['idea', 'spec', 'experience', 'tech', 'build']);
    assert.equal(app.find((phase) => phase.key === 'spec')?.total, 1);
  });
});
