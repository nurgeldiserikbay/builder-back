import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { stageDefinitions } from './catalog.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { cleanExtracted, interviewSchema, readAnswer, templateTurn, type Extracted } from './interview.js';
import { InterviewService } from './interview.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { StageAiService, } from './stage-ai.service.js';
import type { StageAiProvider, StageAiRequest } from './stage-ai.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';

const goal = stageDefinitions.goal.fields!;
const offer = stageDefinitions.offer.fields!;

describe('«Разговор» without AI: the form\'s questions one by one', () => {
  it('asks required questions first, reads numbered and worded choices, lets optional ones be skipped', () => {
    let state = templateTurn(goal, {}, null, null, []);
    const asked = [state.pendingField!];
    assert.equal(state.pendingField, 'businessName');
    assert.match(state.reply, /Название бизнеса/);
    const answers: Record<string, string> = { businessName: 'Торты Айгерим', whatYouDo: 'Печём торты на заказ', audience: 'Родители и офисы', mainAction: '2', tone: 'дружелюбно' };
    for (let step = 0; step < 20 && state.pendingField; step += 1) {
      const answer = answers[state.pendingField] ?? 'пропустить';
      state = templateTurn(goal, state.extracted, state.pendingField, answer, asked);
      if (state.pendingField && !asked.includes(state.pendingField)) asked.push(state.pendingField);
    }
    assert.equal(state.done, true);
    assert.deepEqual(state.extracted, { businessName: 'Торты Айгерим', whatYouDo: 'Печём торты на заказ', audience: 'Родители и офисы', mainAction: 'message', tone: 'friendly' });
    assert.match(state.reply, /Заполнить форму/);
  });
  it('asks again when a choice matches nothing, and reads a services list', () => {
    const again = templateTurn(goal, { businessName: 'A', whatYouDo: 'B', audience: 'C' }, 'mainAction', 'не знаю', ['businessName', 'whatYouDo', 'audience', 'mainAction']);
    assert.equal(again.pendingField, 'mainAction');
    assert.match(again.reply, /Не понял/);
    assert.deepEqual(readAnswer(offer[0], 'Торт на заказ — от 15 000 ₸/кг\nКапкейки').value, [{ name: 'Торт на заказ', description: null, price: 'от 15 000 ₸/кг' }, { name: 'Капкейки', description: null, price: null }]);
    assert.deepEqual(readAnswer(goal.find((field) => field.key === 'city')!, 'пропустить'), { value: null, skipped: true });
  });
});

describe('«Разговор» with AI: what is accepted from an answer', () => {
  it('keeps only valid values: no unknown fields, choices from the list, lengths cut, list items with a name', () => {
    const cleaned = cleanExtracted(goal, { businessName: '  Усы  ', mainAction: 'teleport', tone: 'bold', city: null, script: '<script>', whatYouDo: 'x'.repeat(900) });
    assert.deepEqual(Object.keys(cleaned).sort(), ['businessName', 'tone', 'whatYouDo']);
    assert.equal(cleaned.businessName, 'Усы');
    assert.equal((cleaned.whatYouDo as string).length, 400);
    assert.deepEqual(cleanExtracted(offer, { services: [{ name: null, description: 'x', price: '1' }, { name: 'Стрижка', description: null, price: '5 000 ₸' }], hours: null }), { services: [{ name: 'Стрижка', description: null, price: '5 000 ₸' }] });
  });
  it('asks the model for every field, nullable, with choices limited to the form\'s options', () => {
    const schema = interviewSchema(goal) as { properties: { fields: { required: string[]; properties: Record<string, { enum?: unknown[] }> } } };
    assert.deepEqual(schema.properties.fields.required, goal.map((field) => field.key));
    assert.deepEqual(schema.properties.fields.properties.tone.enum, ['friendly', 'formal', 'bold', null]);
  });
});

describe('«Разговор» (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM stage_interviews LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  const setup = async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const interviews = new InterviewService(prisma!, core, worktime);
    const email = `talk-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Усы', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
    return { core, journey, interviews, owner, projectId };
  };

  it('without AI: greeting and the first question, answers fill the form, the filled form becomes a version to check', { skip }, async () => {
    const { core, journey, interviews, owner, projectId } = await setup();
    core.setProvider(null);
    let view = (await interviews.say(owner.id, projectId, 'goal', { message: null, restart: false })).data;
    assert.equal(view.mode, 'template');
    assert.equal(view.messages.length, 2);
    assert.match(view.messages[1].text, /Название бизнеса/);
    for (const answer of ['Барбершоп Усы', 'Стрижки и бритьё для мужчин', 'Мужчины 20–45 лет', '1', '1']) view = (await interviews.say(owner.id, projectId, 'goal', { message: answer, restart: false })).data;
    assert.deepEqual(view.missingRequired, []);
    assert.equal(view.extracted.mainAction, 'call');
    // The owner wrote the name in the form and locked it: the conversation does not overwrite it.
    await journey.saveDraft(owner.id, projectId, 'goal', { content: { businessName: 'Усы на Абая', whatYouDo: '', audience: '', city: null, mainAction: null, phone: null, messenger: null, email: null, address: null, tone: null }, baseVersionId: null });
    await journey.setLock(owner.id, projectId, 'goal', 'businessName', true);
    const applied = (await interviews.apply(owner.id, projectId, 'goal')).data;
    const version = await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: applied.versionId } });
    const content = version.content as Record<string, unknown>;
    assert.equal(content.businessName, 'Усы на Абая');
    assert.equal(content.whatYouDo, 'Стрижки и бритьё для мужчин');
    assert.equal(version.origin, 'template');
    assert.equal((await interviews.get(owner.id, projectId, 'goal')).data.applied, true);
    await assert.rejects(interviews.say(owner.id, projectId, 'design', { message: null, restart: false }), /INTERVIEW_NOT_AVAILABLE/);
  });

  it('with AI: one question at a time, invented or invalid values dropped, every turn counted as an AI run', { skip }, async () => {
    const { core, interviews, owner, projectId } = await setup();
    const prompts: StageAiRequest[] = [];
    const answers: unknown[] = [
      { reply: 'Как клиенты обычно с вами связываются?', fields: { businessName: 'Усы', whatYouDo: 'Мужские стрижки', audience: null, city: 'Астана', mainAction: 'teleport', phone: null, messenger: null, email: null, address: null, tone: null }, done: false },
      { reply: 'Понял: пишут в WhatsApp. Кто ваши клиенты?', fields: { businessName: 'Усы', whatYouDo: 'Мужские стрижки', audience: null, city: 'Астана', mainAction: 'message', phone: null, messenger: 'wa:+77011234567', email: null, address: null, tone: null }, done: true },
    ];
    const ai: StageAiProvider = { name: 'fake', model: 'fake-1', generate: async (request) => { prompts.push(request); return answers.shift(); } };
    core.setProvider(ai);
    try {
      let view = (await interviews.say(owner.id, projectId, 'goal', { message: null, restart: false })).data;
      assert.equal(view.mode, 'ai');
      assert.equal(view.messages.length, 1, 'the greeting costs nothing');
      assert.equal(await prisma!.generationRun.count({ where: { projectId, targetKey: 'interview' } }), 0);
      view = (await interviews.say(owner.id, projectId, 'goal', { message: 'Барбершоп Усы в Астане, мужские стрижки', restart: false })).data;
      assert.equal(view.extracted.mainAction, undefined, 'an option that is not in the list is dropped');
      assert.equal(view.extracted.city, 'Астана');
      view = (await interviews.say(owner.id, projectId, 'goal', { message: 'Пишут в WhatsApp +7 701 123 45 67', restart: false })).data;
      assert.equal(view.extracted.mainAction, 'message');
      assert.equal(view.done, false, 'not done while a required answer (clients) is missing, whatever the model says');
      assert.deepEqual(view.missingRequired, ['audience', 'tone']);
      const data = JSON.parse(prompts[1].user) as { knownSoFar: Extracted; conversation: Array<{ role: string }> };
      assert.equal(data.knownSoFar.city, 'Астана');
      assert.deepEqual(data.conversation.map((message) => message.role), ['assistant', 'owner', 'assistant', 'owner']);
      assert.equal(await prisma!.generationRun.count({ where: { projectId, targetKey: 'interview', status: 'succeeded' } }), 2);
      const restarted = (await interviews.say(owner.id, projectId, 'goal', { message: null, restart: true })).data;
      assert.equal(restarted.messages.length, 1);
      assert.deepEqual(restarted.extracted, {});
    } finally { core.setProvider(null); }
  });
});
