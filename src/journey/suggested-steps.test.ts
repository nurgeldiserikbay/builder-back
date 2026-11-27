import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { normalizeProcess, templateProcess, type BusinessProcess } from './process.js';
import { situationsFor } from './situations.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { processWithSuggestedSteps, SUGGESTION_CATALOG, type Suggestion } from './suggestions.js';
import { WorktimeService } from './worktime.service.js';

const process: BusinessProcess = {
  actors: [{ key: 'client', name: 'Клиент', kind: 'client' }, { key: 'master', name: 'Мастер', kind: 'staff' }],
  scenarios: [{ key: 'book', title: 'Запись', goal: 'Клиент записан', steps: [
    { key: 'look', actor: 'client', action: 'Выбирает услугу', capability: 'view_info' },
    { key: 'slot', actor: 'client', action: 'Выбирает время', capability: 'choose_slot' },
    { key: 'confirm', actor: 'client', action: 'Подтверждает запись', capability: 'book' },
    { key: 'visit', actor: 'master', action: 'Принимает клиента', capability: 'mark_visit' },
  ] }],
  rules: [], data: [{ key: 'booking', name: 'Запись', fields: ['Время', 'Телефон'], links: [] }],
};
const item = (key: string, catalogKey: string | null, decision: Suggestion['decision']): Suggestion => ({
  key, title: catalogKey ? SUGGESTION_CATALOG.find((entry) => entry.key === catalogKey)!.title : 'Своё', value: '', basis: '', source: catalogKey ? 'catalog' : 'owner',
  catalogKey, support: 'code', effort: 'medium', decision, reason: decision === 'now' ? '' : 'потом',
});

describe('new process steps from the suggestions chosen for the first version', () => {
  it('adds each chosen catalog step right after the step it builds on, with a new actor when needed', () => {
    const result = processWithSuggestedSteps(process, { items: [item('reminders', 'reminders', 'now'), item('cancel_booking', 'cancel_booking', 'now'), item('pay_online', 'prepay_booking', 'later'), item('own', null, 'now'), item('alerts', 'owner_alerts', 'now')] });
    const steps = result.process.scenarios[0]!.steps;
    assert.deepEqual(steps.map((step) => step.key), ['look', 'slot', 'confirm', 'cancel_booking_step', 'reminders_step', 'visit']);
    assert.deepEqual(steps.find((step) => step.key === 'reminders_step'), { key: 'reminders_step', actor: 'system', action: 'Напоминает клиенту о записи накануне', capability: 'remind_client' });
    assert.equal(steps.find((step) => step.key === 'cancel_booking_step')!.actor, 'client');
    assert.deepEqual(result.process.actors.at(-1), { key: 'system', name: 'Система', kind: 'system' });
    assert.deepEqual(result.added.map((add) => [add.scenario, add.after, add.action]), [
      ['Запись', 'Подтверждает запись', 'Напоминает клиенту о записи накануне'],
      ['Запись', 'Подтверждает запись', 'Сам отменяет или переносит запись'],
    ]);
    // «Потом», the owner's own suggestion and a step with nothing to build on are not added; the last one says why.
    assert.deepEqual(result.skipped.map((skip) => skip.suggestion), [SUGGESTION_CATALOG.find((entry) => entry.key === 'owner_alerts')!.title]);
    assert.match(result.skipped[0]!.reason, /нет шага/);
    // The input is not changed, the result is a valid process, and adding again adds nothing.
    assert.equal(process.scenarios[0]!.steps.length, 4);
    assert.deepEqual(normalizeProcess(result.process), result.process);
    assert.equal(processWithSuggestedSteps(result.process, { items: [item('reminders', 'reminders', 'now')] }).added.length, 0);
  });

  it('a full scenario or a full cast is said, not overflowed', () => {
    const full: BusinessProcess = { ...process, scenarios: [{ ...process.scenarios[0]!, steps: Array.from({ length: 12 }, (_, index) => ({ key: `s${index}`, actor: 'client', action: `Шаг ${index}`, capability: index === 0 ? 'book' as const : 'other' as const })) }] };
    const result = processWithSuggestedSteps(full, { items: [item('reminders', 'reminders', 'now')] });
    assert.equal(result.added.length, 0);
    assert.match(result.skipped[0]!.reason, /уже 12 шагов/);
    const crowd: BusinessProcess = { ...process, actors: ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key, name: key, kind: 'client' as const })) };
    assert.match(processWithSuggestedSteps(crowd, { items: [item('reminders', 'reminders', 'now')] }).skipped[0]!.reason, /6 участников/);
  });
});

describe('«Добавить в процесс» (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM project_stages LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('opens the accepted process with the new steps; the owner accepts it again', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.setProvider(null);
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));
    const email = `steps-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Студия', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;
    const row = (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });
    const step = async (key: string, content: unknown) => { await journey.saveDraft(owner.id, projectId, key, { content, baseVersionId: (await row(key)).currentVersionId }); await journey.accept(owner.id, projectId, key, (await row(key)).currentVersionId!); };
    await step('story', { name: 'Студия', essence: 'Клиенты записываются онлайн, а мастер видит записи на день', audience: 'Клиенты салона', problem: 'Записи теряются', story: null, materials: null });
    await step('goal', { businessName: 'Студия', whatYouDo: 'Маникюр', audience: 'Женщины рядом', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@studio', email: null, address: null, tone: 'friendly' });
    await journey.skip(owner.id, projectId, 'idea', 'Студия работает три года');
    // The owner's process: the typical booking one, every «Вы это учли?» answered, without the reminder.
    const base = templateProcess('booking', null);
    const owned = { ...base, scenarios: base.scenarios.map((scenario) => ({ ...scenario, steps: scenario.steps.filter((item) => item.capability !== 'remind_client') })), situations: situationsFor('booking').map((entry) => ({ key: entry.key, answer: (entry.options.find((option) => option.typical) ?? entry.options[0]!).value })) };
    await step('process', owned);
    await assert.rejects(journey.addSuggestedSteps(owner.id, projectId), /NOTHING_TO_ADD/);
    await journey.saveDraft(owner.id, projectId, 'suggestions', { content: { items: [item('reminders', 'reminders', 'now'), item('pay', 'prepay_booking', 'later')] }, baseVersionId: null });

    const preview = (await journey.stage(owner.id, projectId, 'suggestions')).data.options as { processSteps: { available: boolean; canAdd: boolean; added: Array<{ action: string }> } };
    assert.equal(preview.processSteps.available, true);
    assert.equal(preview.processSteps.canAdd, true);
    assert.deepEqual(preview.processSteps.added.map((add) => add.action), ['Напоминает клиенту о записи накануне']);

    const result = (await journey.addSuggestedSteps(owner.id, projectId)).data;
    assert.equal(result.added.length, 1);
    const stage = await row('process');
    assert.equal(stage.status, 'in_progress');
    const version = await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: stage.currentVersionId! } });
    assert.equal(version.note, 'Шаги из выбранных предложений');
    assert.ok((version.content as unknown as BusinessProcess).scenarios[0]!.steps.some((item) => item.capability === 'remind_client' && item.actor === 'site'), 'the site does it: the existing system actor');
    // The suggestions stage keeps working on the accepted process meanwhile; once added, nothing more to add.
    assert.equal((await row('suggestions')).status, 'in_progress');
    assert.equal(((await journey.stage(owner.id, projectId, 'suggestions')).data.options as { processSteps: { added: unknown[] } }).processSteps.added.length, 0);
    await journey.accept(owner.id, projectId, 'process', stage.currentVersionId!);
    assert.equal((await row('process')).status, 'approved');
    const events = await prisma!.projectEvent.findMany({ where: { projectId, type: 'suggestion_steps_added' } });
    assert.equal(events.length, 1);
  });
});
