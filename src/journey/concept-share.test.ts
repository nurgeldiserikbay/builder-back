import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { InboxService } from '../inbox/inbox.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { emptyBrief } from './artifacts.js';
import { templateProcess } from './process.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { ConceptShareService, DEFAULT_HIDDEN, readRemark, sharedDocument, shareUrl } from './concept-share.service.js';
import type { ConceptDocument } from './concept.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';

const section = (key: string, markdown = `Текст ${key}`) => ({ key, title: key, source: null, markdown, empty: null });
const document: ConceptDocument = {
  title: 'Концепция', markdown: 'ВСЁ, включая деньги: 5 млн',
  sections: [section('pitch'), section('how', 'Схема 1.'), section('data', 'Схема 2.'), section('goals', 'Выручка 5 млн')],
  diagrams: [{ key: 'process', number: 1, caption: 'Процесс' }, { key: 'data', number: 2, caption: 'Данные' }],
};

describe('«Показать другому человеку»: a read-only link to the concept', () => {
  it('drops hidden sections, their diagrams and the whole Markdown that holds them', () => {
    const shared = sharedDocument(document, ['goals', 'data']);
    assert.deepEqual(shared.sections.map((item) => item.key), ['pitch', 'how']);
    assert.deepEqual(shared.diagrams.map((item) => item.key), ['process']);
    assert.equal('markdown' in shared, false);
    assert.doesNotMatch(JSON.stringify(shared), /5 млн/);
    assert.deepEqual(DEFAULT_HIDDEN, ['goals']);
    assert.equal(shareUrl('tok', {}), null);
    assert.equal(shareUrl('tok', { PUBLIC_APP_URL: 'https://app.example.com/' }), 'https://app.example.com/concept/tok');
  });

  it('takes a remark as plain text with a name and a shown section; a bot gets nothing stored', () => {
    assert.deepEqual(readRemark({ name: ' Аня ', text: 'Непонятно, кто платит\u0007', section: 'how' }, ['pitch', 'how']), { name: 'Аня', text: 'Непонятно, кто платит', section: 'how' });
    assert.equal(readRemark({ name: 'Аня', text: 'Текст', section: 'goals' }, ['pitch'])!.section, null, 'a hidden section is not a place to point at');
    assert.equal(readRemark({ name: 'x', text: 'спам', website: 'http://spam' }, []), null);
    assert.throws(() => readRemark({ name: 'Аня', text: 'а' }, []), /REMARK_TEXT_REQUIRED/);
    assert.throws(() => readRemark({ name: '  ', text: 'Нормальный текст' }, []), /REMARK_NAME_REQUIRED/);
    assert.equal(readRemark({ name: 'А'.repeat(100), text: 'Т'.repeat(2000) }, [])!.text.length, 1000);
  });
});

describe('concept link (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM concept_shares LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  const env = process.env.PUBLIC_APP_URL;
  after(async () => {
    process.env.PUBLIC_APP_URL = env;
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('the owner shares the saved concept; a reader sees it without hidden sections and leaves remarks; the owner sees them', { skip }, async () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.setProvider(null);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const shares = new ConceptShareService(prisma!, core, journey);
    const email = `share-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Заявки дома', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const row = (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });

    assert.equal((await shares.get(owner.id, projectId)).data.enabled, false);
    // Nothing saved yet: nothing to show.
    await assert.rejects(shares.set(owner.id, projectId, { enabled: true }), /NOTHING_TO_SHARE/);
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Заявки дома', essence: 'Жильцы оставляют заявки на ремонт с телефона', audience: 'Жильцы и управляющая', problem: 'Заявки теряются', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', (await row('story')).currentVersionId!);
    await journey.skip(owner.id, projectId, 'idea', 'Проверка ссылки');
    await journey.saveDraft(owner.id, projectId, 'process', { content: templateProcess('web_app', { ...emptyBrief(), businessName: 'Заявки дома', whatYouDo: 'Заявки на ремонт', audience: 'Жильцы' }), baseVersionId: null });
    await journey.accept(owner.id, projectId, 'process', (await row('process')).currentVersionId!);
    await journey.skip(owner.id, projectId, 'suggestions', 'Проверка ссылки');
    await journey.saveDraft(owner.id, projectId, 'concept', { content: { pitch: 'Заявки на ремонт в одном месте.', glossary: [], questions: [], notes: '' }, baseVersionId: null });

    const on = (await shares.set(owner.id, projectId, { enabled: true })).data;
    assert.match(on.url!, /^https:\/\/app\.example\.com\/concept\/[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(on.hiddenSections, ['goals']);
    assert.ok(on.sections.some((item) => item.key === 'goals'));
    const token = on.url!.split('/').at(-1)!;

    const read = (await shares.read(token)).data;
    assert.equal(read.allowComments, true);
    assert.ok(read.document.sections.some((item) => item.key === 'pitch' && item.markdown.includes('Заявки на ремонт в одном месте')));
    assert.ok(!read.document.sections.some((item) => item.key === 'goals'));
    assert.equal('markdown' in read.document, false);
    // The owner's edits reach readers at once.
    const version = (await row('concept')).currentVersionId!;
    await journey.saveDraft(owner.id, projectId, 'concept', { content: { pitch: 'Новая формулировка.', glossary: [], questions: [], notes: '' }, baseVersionId: version });
    assert.ok((await shares.read(token)).data.document.sections.some((item) => item.markdown.includes('Новая формулировка')));

    await shares.remark(token, '10.0.0.1', { name: 'Аня', text: 'Кто платит за мастера?', section: 'pitch' });
    await shares.remark(token, '10.0.0.1', { name: 'бот', text: 'спам спам', website: 'x' });
    let view = (await shares.get(owner.id, projectId)).data;
    assert.equal(view.views, 2);
    assert.deepEqual(view.comments.map((item) => [item.name, item.section, item.text]), [['Аня', 'pitch', 'Кто платит за мастера?']]);
    // In the owner's inbox until marked «Учтено».
    const inbox = new InboxService(prisma!, core);
    const waiting = async () => ((await inbox.inbox(owner.id)) as { data: { waiting: Array<{ kind: string; projectId: string; who: string | null }> } }).data.waiting.filter((item) => item.kind === 'guest_remarks' && item.projectId === projectId);
    assert.equal((await waiting())[0]?.who, 'Аня');
    view = (await shares.resolve(owner.id, projectId, view.comments[0]!.id, true)).data;
    assert.ok(view.comments[0]!.resolvedAt);
    assert.equal((await waiting()).length, 0);

    // Remarks off; a new link; off — the old link answers «not found».
    await shares.set(owner.id, projectId, { allowComments: false });
    await assert.rejects(shares.remark(token, '10.0.0.2', { name: 'Петя', text: 'Ещё вопрос' }), /SHARE_NOT_FOUND/);
    await assert.rejects(shares.set(owner.id, projectId, { hiddenSections: ['Goals!'] }), /INVALID_SECTIONS/);
    const renewed = (await shares.set(owner.id, projectId, { renew: true, hiddenSections: [] })).data;
    assert.notEqual(renewed.url, on.url);
    assert.equal(renewed.views, 0);
    await assert.rejects(shares.read(token), /SHARE_NOT_FOUND/);
    const fresh = renewed.url!.split('/').at(-1)!;
    assert.ok((await shares.read(fresh)).data.document.sections.some((item) => item.key === 'goals'));
    await shares.set(owner.id, projectId, { enabled: false });
    await assert.rejects(shares.read(fresh), /SHARE_NOT_FOUND/);
    await assert.rejects(shares.read('short'), /SHARE_NOT_FOUND/);
  });
});
