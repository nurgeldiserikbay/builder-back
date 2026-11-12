import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { PrismaService } from '../database/prisma.service.js';
import type { JourneyService } from '../journey/journey.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { DisputesService } from './disputes.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Removes only what it created. */
describe('disputes (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM disputes LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const disputes = prisma ? new DisputesService(prisma) : null;
  const payments = prisma ? new PaymentsService(prisma, {} as JourneyService) : null;
  const users: string[] = [];
  let staffId = '';

  async function user(label: string) {
    const email = `${label}-${randomUUID()}@test.local`;
    const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: label } });
    users.push(created.id);
    return created;
  }

  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (staffId) {
      await prisma.adminAuditEvent.deleteMany({ where: { staffId } });
      await prisma.staffAccount.deleteMany({ where: { id: staffId } });
    }
    await prisma.$disconnect();
  });

  it('opens one dispute at a time, holds the payout while open, and a decision can create an amount due', { skip }, async () => {
    // A local stand-in for the mail service records what would be sent.
    const mails: Array<{ to: string; subject: string }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => { const body = JSON.parse(raw); mails.push({ to: body.to[0].email, subject: body.subject }); response.writeHead(201).end('{}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { ...process.env };
    Object.assign(process.env, { EMAIL_FROM: 'BuildPath <noreply@test.local>', BREVO_API_KEY: 'test', BREVO_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    delete process.env.RESEND_API_KEY;
    try {
    const owner = await user('owner');
    const specialist = await user('spec');
    const outsider = await user('outsider');
    const staffEmail = `staff-${randomUUID()}@test.local`;
    staffId = (await prisma!.staffAccount.create({ data: { email: staffEmail, emailNormalized: staffEmail, passwordHash: 'x', displayName: 'Support', role: 'super_admin' } })).id;
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'active', projectType: 'booking' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'content', definitionVersion: '1', position: 1, status: 'in_progress' } });
    const assignment = await prisma!.stageAssignment.create({ data: {
      projectId: project.id, stageId: stage.id, userId: specialist.id, email: specialist.emailNormalized, role: 'lead', status: 'completed', acceptedAt: new Date(), completedAt: new Date(),
      payKind: 'fixed', fixedAmountTiyn: 3_000_000, inviteTokenHash: randomUUID().replace(/-/g, ''), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: owner.id,
    } });
    const held = await prisma!.stagePayment.create({ data: { assignmentId: assignment.id, projectId: project.id, basis: 'fixed', amountTiyn: 3_000_000, status: 'held', heldAt: new Date(), payoutTiyn: 3_000_000 } });

    // A stranger does not even learn the assignment exists.
    await assert.rejects(disputes!.forAssignment(outsider.id, assignment.id), /ASSIGNMENT_NOT_FOUND/);
    // Each side has its own kinds.
    await assert.rejects(disputes!.open(owner.id, assignment.id, { kind: 'payment', claim: 'Хочу оплату за этап, работа сдана в срок.', amount: 1000 }), /DISPUTE_KIND_INVALID/);

    const opened = await disputes!.open(owner.id, assignment.id, { kind: 'refund', claim: 'Тексты не подходят: половина услуг описана неверно, правки не сделаны.', amount: 30000 });
    assert.equal(opened.data.side, 'owner');
    assert.equal(opened.data.disputes[0].status, 'open');
    assert.equal(opened.data.canOpen, false);
    await assert.rejects(disputes!.open(specialist.id, assignment.id, { kind: 'payment', claim: 'Работа сдана по условиям, правки вне объёма.', amount: 30000 }), /DISPUTE_ALREADY_OPEN/);

    // Money stays with BuildPath while the dispute is open.
    await assert.rejects(payments!.markPaidOut(staffId, held.id, 'TR-123'), /DISPUTE_OPEN/);
    await assert.rejects(payments!.revealPayoutAccount(staffId, held.id), (error: unknown) => /DISPUTE_OPEN|PAYOUTS_NOT_CONFIGURED/.test(String((error as Error).message)));
    assert.equal((await payments!.payoutQueue()).data.find((row) => row.id === held.id)?.disputeOpen, true);

    const disputeId = opened.data.disputes[0].id;
    const answered = await disputes!.message(specialist.id, disputeId, 'Все правки из списка сделаны, версии 3 и 4 на этапе.');
    assert.equal(answered.data.side, 'specialist');
    assert.equal(answered.data.disputes[0].messages[0].mine, true);
    await assert.rejects(disputes!.withdraw(specialist.id, disputeId), /DISPUTE_WITHDRAW_FORBIDDEN/);
    await disputes!.staffMessage(staffId, disputeId, 'Посмотрим версии этапа и табель, ответим до пятницы.');

    const detail = await disputes!.staffDetail(staffId, disputeId);
    assert.equal(detail.data.payments.length, 1);
    assert.equal(detail.data.messages.length, 2);
    assert.ok(detail.data.events.some((event) => event.type === 'dispute_opened'));

    await assert.rejects(disputes!.resolve(staffId, disputeId, { outcome: 'owner', note: 'Возврат владельцу по истории этапа.', paySpecialist: 5000 }), /DISPUTE_PAYMENT_NOT_ALLOWED/);
    const resolved = await disputes!.resolve(staffId, disputeId, { outcome: 'split', note: 'Часть услуг описана неверно, часть правок сделана: делим.', paySpecialist: 5000 });
    assert.equal(resolved.data.status, 'resolved');
    assert.equal(resolved.data.paymentCreated, true);
    const due = await prisma!.stagePayment.findFirst({ where: { assignmentId: assignment.id, basis: 'dispute' } });
    assert.equal(due?.status, 'due');
    assert.equal(due?.amountTiyn, 500_000);
    await assert.rejects(disputes!.resolve(staffId, disputeId, { outcome: 'owner', note: 'Повторное решение не нужно.', paySpecialist: null }), /DISPUTE_CLOSED/);
    await assert.rejects(disputes!.message(owner.id, disputeId, 'Ещё вопрос'), /DISPUTE_CLOSED/);

    // Decided: the payout is allowed again, and a new dispute can be opened.
    await payments!.markPaidOut(staffId, held.id, 'TR-123');
    assert.equal((await prisma!.stagePayment.findUnique({ where: { id: held.id } }))?.status, 'paid_out');
    const again = await disputes!.forAssignment(specialist.id, assignment.id);
    assert.equal(again.data.canOpen, true);

    // Silence: the specialist never wrote in the second dispute; after 3 days it is reminded once, not twice.
    const quiet = await disputes!.open(owner.id, assignment.id, { kind: 'other', claim: 'Хочу уточнить объём правок, которые входят в цену.', amount: null });
    const quietId = quiet.data.disputes[0].id;
    await prisma!.dispute.update({ where: { id: quietId }, data: { createdAt: new Date(Date.now() - 4 * 86_400_000) } });
    assert.deepEqual((await disputes!.staffDetail(staffId, quietId)).data.waiting, { side: 'specialist', days: 4, reminded: false });
    const mailsBefore = mails.length;
    assert.ok((await disputes!.processReminders()) >= 1);
    assert.equal(mails.filter((mail) => mail.to === specialist.emailNormalized).length - mails.slice(0, mailsBefore).filter((mail) => mail.to === specialist.emailNormalized).length, 1);
    assert.equal(await disputes!.processReminders(), 0);
    assert.equal((await disputes!.staffDetail(staffId, quietId)).data.waiting?.reminded, true);
    await disputes!.withdraw(owner.id, quietId);

    // The opener can withdraw.
    const second = await disputes!.open(specialist.id, assignment.id, { kind: 'other', claim: 'Хочу уточнить условия по оплате части работы.', amount: null });
    await disputes!.withdraw(specialist.id, second.data.disputes[0].id);
    assert.equal((await disputes!.mine(owner.id)).data.disputes.filter((row) => row.projectId === project.id).length, 3);

    // After access ends, the specialist still finds the assignment in the account and can open a dispute there.
    await prisma!.stageAssignment.update({ where: { id: assignment.id }, data: { readUntil: new Date(Date.now() - 1000) } });
    assert.ok((await disputes!.mine(specialist.id)).data.withoutStageAccess.some((row) => row.assignmentId === assignment.id));
    assert.ok(!(await disputes!.mine(owner.id)).data.withoutStageAccess.some((row) => row.assignmentId === assignment.id));

    // Mail: opening reaches the other side, a reply between the sides does not, support's message and the decision reach both.
    const to = (address: string) => mails.filter((mail) => mail.to === address).length;
    assert.equal(to(specialist.emailNormalized), 6); // owner opened, support wrote, decided, quiet dispute opened, reminder, withdrawn — replies are not mailed
    assert.equal(to(owner.emailNormalized), 4); // support wrote, decided, the specialist's dispute opened and withdrawn — not the specialist's reply
    assert.ok(mails.every((mail) => mail.subject.length > 0));
    } finally {
      process.env = saved;
      server.close();
    }
  });
});
