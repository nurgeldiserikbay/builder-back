import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { knownStagesOf, projectTypes, routeInputs, stageDefinitions, type StageKey } from './catalog.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { briefFromStory, briefOf, completenessIssues, importStoryText, normalizeStory, storyMarkdown, type Story } from './artifacts.js';
import { InterviewService } from './interview.service.js';
import { INTERVIEW_STAGES, templateTurn } from './interview.js';
import { JourneyCore, projectRoute } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { jargonIn, reviewStage, sentenceCount } from './stage-review.js';
import { WorktimeService } from './worktime.service.js';

const story: Story = {
  name: 'Заявки дома', essence: 'Жильцы оставляют заявку на ремонт с телефона, а управляющая назначает мастера и видит, что сделано',
  audience: 'Жильцы дома, управляющая и два мастера', problem: 'Заявки в общем чате теряются, никто не знает, кто их взял',
  story: 'Мы управляем домом на 120 квартир.\nСейчас всё в WhatsApp.', materials: 'Таблица заявок в Google Sheets',
};

describe('«Идея своими словами»: the first stage of a new route', () => {
  it('starts every new route; sites keep «Цель сайта» after it, an application has none', () => {
    for (const type of Object.values(projectTypes)) {
      assert.equal(type.stages[0], 'story', type.key);
      assert.equal(type.stages.includes('goal'), type.key !== 'web_app', type.key);
      assert.deepEqual(routeInputs(type.stages, 'story'), [], type.key);
    }
    assert.deepEqual(routeInputs(projectTypes.landing.stages, 'goal'), ['story']);
    assert.deepEqual(routeInputs(projectTypes.landing.stages, 'idea'), ['goal', 'story']);
    // On an application the stages that built on «Цель» build on the idea passport.
    assert.deepEqual(routeInputs(projectTypes.web_app.stages, 'idea'), ['story']);
    assert.ok(routeInputs(projectTypes.web_app.stages, 'handoff').includes('story'));
    assert.ok(!routeInputs(projectTypes.web_app.stages, 'handoff').includes('goal'));
  });

  it('older projects keep the route they were made with', () => {
    // A project made before 1.18.0 has rows for «Цель» and no idea passport: its route and inputs do not change.
    const rows = (keys: string[]) => keys.map((stageKey, position) => ({ stageKey, position }));
    const oldApp = projectRoute(knownStagesOf(projectTypes.web_app), rows(['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'screens', 'techplan', 'contracts', 'roadmap', 'testplan', 'handoff', 'launch']));
    assert.equal(oldApp[0], 'goal');
    assert.ok(!oldApp.includes('story'));
    assert.deepEqual(routeInputs(oldApp, 'idea'), ['goal']);
    const oldSite = projectRoute(knownStagesOf(projectTypes.landing), rows(['goal', 'idea', 'process', 'features', 'techplan', 'content', 'design', 'build']));
    assert.deepEqual(routeInputs(oldSite, 'goal'), []);
    const newApp = projectRoute(knownStagesOf(projectTypes.web_app), rows(projectTypes.web_app.stages));
    assert.deepEqual(newApp, projectTypes.web_app.stages);
  });

  it('keeps the owner\'s words, checks the required fields and gives later stages a name, what it does and for whom', () => {
    assert.deepEqual(normalizeStory({ ...story, extra: 'x' }), story);
    assert.throws(() => normalizeStory({ essence: 'x'.repeat(201) }), /FIELD_TOO_LONG:essence/);
    assert.deepEqual(completenessIssues('story', normalizeStory({})).map((issue) => issue.key), ['name', 'essence', 'audience', 'problem']);
    assert.deepEqual(completenessIssues('story', story), []);
    const brief = briefFromStory(story)!;
    assert.equal(brief.businessName, 'Заявки дома');
    assert.equal(brief.whatYouDo, story.essence);
    assert.equal(brief.audience, story.audience);
    // Nothing about buttons, contacts or tone is made up.
    assert.equal(brief.mainAction, null);
    assert.equal(brief.phone, null);
    assert.equal(brief.tone, null);
    assert.equal(briefOf({ story: { content: story } })?.businessName, 'Заявки дома');
    assert.equal(briefOf({ goal: { content: { ...brief, businessName: 'Из цели' } }, story: { content: story } })?.businessName, 'Из цели');
    assert.equal(briefOf({}), null);
    assert.equal(importStoryText('  Хочу приложение для заявок.  ').story, 'Хочу приложение для заявок.');
    assert.throws(() => importStoryText('   '), /IMPORT_EMPTY/);
    const markdown = storyMarkdown(story).join('\n');
    assert.match(markdown, /Суть: Жильцы оставляют/);
    assert.match(markdown, /> Сейчас всё в WhatsApp\./);
  });

  it('the essence is one plain sentence: several sentences, too short or jargon are pointed out', () => {
    assert.equal(sentenceCount('Жильцы оставляют заявку. Управляющая назначает мастера.'), 2);
    assert.equal(sentenceCount('Заявки на ремонт, т. е. всё в одном месте'), 1);
    assert.equal(sentenceCount(story.essence), 1);
    assert.deepEqual(jargonIn('MVP-версия CRM для юзеров'), ['mvp', 'crm', 'юзеров']);
    assert.deepEqual(jargonIn('Приложение для управляющей'), []);
    assert.deepEqual(reviewStage('story', story).findings, []);
    const codes = (value: Partial<Story>) => reviewStage('story', { ...story, ...value }).findings.map((finding) => finding.code);
    assert.deepEqual(codes({ essence: 'Жильцы оставляют заявку. Управляющая назначает мастера.' }), ['STORY_ESSENCE_SENTENCES']);
    assert.deepEqual(codes({ essence: 'Заявки' }), ['STORY_ESSENCE_SHORT']);
    assert.deepEqual(codes({ essence: 'MVP приложения для заявок жильцов дома на ремонт' }), ['STORY_JARGON']);
    assert.deepEqual(codes({ problem: story.essence }), ['STORY_PROBLEM_SAME']);
    // Advice only: nothing here blocks acceptance.
    assert.ok(reviewStage('story', { ...story, essence: 'MVP. CRM.' }).findings.every((finding) => finding.severity !== 'blocking'));
  });

  it('can be filled by a conversation; without AI the passport questions are asked one by one', () => {
    assert.ok((INTERVIEW_STAGES as readonly string[]).includes('story'));
    const fields = stageDefinitions.story.fields!;
    const first = templateTurn(fields, {}, null, null, []);
    assert.equal(first.pendingField, 'name');
    let state = first; const asked = ['name'];
    const answers: Record<string, string> = { name: story.name, essence: story.essence, audience: story.audience, problem: story.problem };
    for (let step = 0; step < 10 && state.pendingField; step += 1) {
      state = templateTurn(fields, state.extracted, state.pendingField, answers[state.pendingField] ?? 'пропустить', asked);
      if (state.pendingField && !asked.includes(state.pendingField)) asked.push(state.pendingField);
    }
    assert.equal(state.done, true);
    assert.deepEqual(state.extracted, answers);
  });
});

describe('«Идея своими словами» (database)', async () => {
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

  const setup = async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.setProvider(null);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const interviews = new InterviewService(prisma!, core, worktime, stageAi);
    const email = `story-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const create = (projectType: string) => new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Заявки дома', summary: 'Хочу, чтобы жильцы оставляли заявки на ремонт, а управляющая назначала мастера.', startMode: 'build', locale: 'ru', projectType } as never).then((result) => result.data.id);
    const row = (projectId: string, key: string) => prisma!.projectStage.findFirst({ where: { projectId, stageKey: key } });
    return { journey, interviews, owner, create, row };
  };

  it('an application starts with the idea passport: a draft from the wizard story, «Да, это моя идея», then the idea review', { skip }, async () => {
    const { journey, interviews, owner, create, row } = await setup();
    const projectId = await create('web_app');
    assert.equal(await row(projectId, 'goal'), null, 'a new application has no «Цель»');
    assert.equal((await row(projectId, 'story'))!.status, 'ready');
    assert.equal((await row(projectId, 'idea'))!.status, 'locked');
    // The wizard story is offered to the conversation and the first draft.
    const detail = (await journey.stage(owner.id, projectId, 'story')).data;
    assert.equal(detail.stage.title, 'Идея своими словами');
    assert.equal((detail.options as { brief?: { intro: string | null } }).brief?.intro, 'Хочу, чтобы жильцы оставляли заявки на ремонт, а управляющая назначала мастера.');
    const talk = (await interviews.say(owner.id, projectId, 'story', { message: null, restart: false })).data;
    assert.match(talk.messages[0]!.text, /паспорта идеи/);
    // Without AI the draft keeps the project name and the owner's story; the rest is the owner's to write.
    const drafted = await journey.generate(owner.id, projectId, 'story', { instruction: null, saveAs: 'one_off', targetKey: null });
    assert.equal(drafted.data.provider, 'template');
    const draft = (await journey.stage(owner.id, projectId, 'story')).data.current!.content as Story;
    assert.equal(draft.name, 'Заявки дома');
    assert.equal(draft.story, 'Хочу, чтобы жильцы оставляли заявки на ремонт, а управляющая назначала мастера.');
    assert.equal(draft.essence, '');
    await journey.saveDraft(owner.id, projectId, 'story', { content: story, baseVersionId: drafted.data.versionId });
    await journey.accept(owner.id, projectId, 'story', (await row(projectId, 'story'))!.currentVersionId!);
    assert.equal((await row(projectId, 'idea'))!.status, 'ready');
    // The idea review drafts from the passport: who it is for and the problem.
    await journey.generate(owner.id, projectId, 'idea', { instruction: null, saveAs: 'one_off', targetKey: null });
    const idea = (await journey.stage(owner.id, projectId, 'idea')).data.current!.content as { problem: string; segments: Array<{ name: string }> };
    assert.equal(idea.problem, story.problem);
    assert.equal(idea.segments[0]?.name, story.audience);
    // The result carries the passport.
    const result = (await journey.result(owner.id, projectId)).data;
    const projectMd = result.files.find((file) => file.name === 'project.md')!.content;
    assert.match(projectMd, /## Паспорт идеи/);
    assert.match(projectMd, /Суть: Жильцы оставляют заявку/);
    assert.doesNotMatch(projectMd, /## Паспорт проекта/);
  });

  it('a site: the goal opens after the idea passport and its draft takes the name, what you do and the clients from it', { skip }, async () => {
    const { journey, owner, create, row } = await setup();
    const projectId = await create('landing');
    assert.equal((await row(projectId, 'goal'))!.status, 'locked');
    await journey.saveDraft(owner.id, projectId, 'story', { content: story, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', (await row(projectId, 'story'))!.currentVersionId!);
    assert.equal((await row(projectId, 'goal'))!.status, 'ready');
    // The wizard story now lives in the idea passport; «Цель» does not offer it again.
    assert.equal(((await journey.stage(owner.id, projectId, 'goal')).data.options as { brief?: unknown }).brief, undefined);
    const drafted = await journey.generate(owner.id, projectId, 'goal', { instruction: null, saveAs: 'one_off', targetKey: null });
    assert.equal(drafted.data.provider, 'template');
    const goal = (await journey.stage(owner.id, projectId, 'goal')).data.current!.content as { businessName: string; whatYouDo: string; audience: string; mainAction: string | null };
    assert.deepEqual({ businessName: goal.businessName, whatYouDo: goal.whatYouDo, audience: goal.audience, mainAction: goal.mainAction }, { businessName: story.name, whatYouDo: story.essence, audience: story.audience, mainAction: null });
  });

  it('an older project without the stage keeps its route: «Цель» is first and open', { skip }, async () => {
    const { journey, owner, create, row } = await setup();
    const projectId = await create('web_app');
    // A project made before route 1.18.0: rows for «Цель», none for the idea passport.
    const story = (await row(projectId, 'story'))!;
    await prisma!.projectStage.delete({ where: { id: story.id } });
    await prisma!.projectStage.create({ data: { projectId, stageKey: 'goal', position: 0, status: 'ready', definitionVersion: '1.0.0' } });
    await prisma!.projectStage.update({ where: { projectId_stageKey: { projectId, stageKey: 'idea' } }, data: { status: 'locked' } });
    const map = (await journey.journey(owner.id, projectId)).data as { stages: Array<{ key: StageKey; title: string }> };
    assert.equal(map.stages[0]!.key, 'goal');
    assert.equal(map.stages[0]!.title, 'Цель приложения');
    assert.ok(!map.stages.some((stage) => stage.key === 'story'));
  });
});
