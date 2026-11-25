import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { Brief } from './artifacts.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { templateProcess } from './process.js';
import { importSpecText } from './spec-import.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';

const SPEC = `# ТЗ: сайт кондитерской «Тая»

Сайт для заказа тортов к праздникам. Клиенты — семьи и офисы в Астане.

## Пользователи
- Клиент — выбирает торт и оставляет заказ
- Кондитер: получает заказы и подтверждает их

## Функциональные требования

### Первая версия
1. Каталог тортов с ценами. Клиент видит фото, вес и цену.
Готово, когда: клиент открывает каталог с телефона и видит цены
2. Заказ торта клиентом на дату
Критерии приёмки: заказ приходит кондитеру в Telegram; клиент видит подтверждение

### Позже
- Онлайн-оплата картой
- Бонусы постоянным клиентам

## Нефункциональные требования
- Сайт открывается быстрее 3 секунд
- Удобно с телефона

## Ограничения
- Доставка только по Астане

Брать ли предоплату за большие торты?
`;

describe('importing an own ТЗ', () => {
  it('lays a free-form document out into the ТЗ sections', () => {
    const { content, found } = importSpecText(SPEC);
    assert.match(content.summary, /заказа тортов/);
    assert.deepEqual(content.roles.map((role) => role.name), ['Клиент', 'Кондитер']);
    assert.deepEqual(content.features.map((feature) => [feature.title, feature.priority]), [
      ['Каталог тортов с ценами', 'must'], ['Заказ торта клиентом на дату', 'must'], ['Онлайн-оплата картой', 'later'], ['Бонусы постоянным клиентам', 'later'],
    ]);
    assert.deepEqual(content.features[0]!.acceptance, ['клиент открывает каталог с телефона и видит цены']);
    assert.deepEqual(content.features[1]!.acceptance, ['заказ приходит кондитеру в Telegram', 'клиент видит подтверждение']);
    assert.deepEqual(content.features[1]!.roles, ['role1']);
    assert.deepEqual(content.requirements, ['Сайт открывается быстрее 3 секунд', 'Удобно с телефона']);
    assert.deepEqual(content.limits, ['Доставка только по Астане']);
    assert.deepEqual(content.questions, ['Брать ли предоплату за большие торты?']);
    assert.deepEqual(found, { summary: true, roles: 2, features: 4, acceptance: 3, requirements: 2, limits: 1, questions: 1 });
  });

  it('a plain list without headings still gives functions and a default role', () => {
    const { content, found } = importSpecText('Нужно:\n- запись клиентов онлайн\n- напоминание за день\n- отзывы позже');
    assert.equal(found.features, 3);
    assert.equal(content.features[2]!.priority, 'later');
    assert.equal(content.roles.length, 1);
  });

  it('nothing recognisable gives an empty ТЗ, not an error', () => {
    const { found } = importSpecText('Просто какой-то текст без структуры');
    assert.equal(found.features, 0);
    assert.equal(found.summary, true);
  });
});

describe('importing an own ТЗ into a project (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM stage_files LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('a stage file becomes the ТЗ with what was found; an accepted ТЗ is reopened before another import', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const email = `spec-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Тая', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
    const brief: Brief = { businessName: 'Тая', whatYouDo: 'Торты на заказ к праздникам', audience: 'Семьи и офисы в Астане', city: 'Астана', mainAction: 'message', phone: null, messenger: '@taya', email: null, address: null, tone: 'friendly' };
    const current = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId;
    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'goal', (await current('goal'))!);
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    await journey.saveDraft(owner.id, projectId, 'process', { content: templateProcess('landing', brief), baseVersionId: null });
    await journey.accept(owner.id, projectId, 'process', (await current('process'))!);

    // A document from the stage files: scanned on upload, laid out the same way.
    const stage = await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'features' } });
    const bytes = Buffer.from(SPEC.replace('Доставка только по Астане', 'Самовывоз из кондитерской'));
    const file = await prisma!.stageFile.create({ data: { projectId, stageId: stage.id, name: 'tz.md', kind: 'text', mime: 'text/plain', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes, createdByUserId: owner.id } });
    await assert.rejects(journey.importText(owner.id, projectId, 'features', { fileId: randomUUID() }), /FILE_NOT_FOUND/);
    const fromFile = await journey.importText(owner.id, projectId, 'features', { fileId: file.id });
    assert.equal(fromFile.data.found?.features, 4);
    // Complete — every function of the first version says when it is done — so the owner's import counts as the stage.
    assert.equal(fromFile.data.status, 'imported');
    const saved = await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: fromFile.data.versionId } });
    assert.equal(saved.origin, 'imported');
    assert.equal((saved.content as { limits: string[] }).limits[0], 'Самовывоз из кондитерской');
    // Changing an accepted ТЗ starts with reopening it, as for any accepted stage.
    await assert.rejects(journey.importText(owner.id, projectId, 'features', { text: SPEC }), /STAGE_ACCEPTED_REOPEN_FIRST/);
    await assert.rejects(journey.importText(owner.id, projectId, 'goal', { fileId: file.id }), /IMPORT_FILE_NOT_SUPPORTED|STAGE_|NOT_EDITABLE/);
  });
});
