import type { PrismaService } from '../database/prisma.service.js';
import { type StageKey, definitionOf } from './catalog.js';

/** Requests not settled yet: «open» waits for the earlier stage, «accepted» is being fixed there. */
export const UNSETTLED_REQUESTS = ['open', 'accepted'] as const;

/**
 * Requests from one stage and to it, for that stage's page (change-proposals.service.ts): what this stage asked of earlier
 * ones and what it holds for (outgoing), and what later stages ask of it (incoming).
 */
export async function stageRequests(prisma: Pick<PrismaService, 'changeProposal'>, projectId: string, stageId: string) {
  const rows = await prisma.changeProposal.findMany({
    where: { projectId, OR: [{ fromStageId: stageId }, { targetStageId: stageId }], status: { in: [...UNSETTLED_REQUESTS] } },
    select: { id: true, kind: true, blocking: true, status: true, text: true, fromStageId: true, fromStage: { select: { stageKey: true } }, targetStage: { select: { stageKey: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const title = (key: string) => definitionOf(key as StageKey)?.title ?? key;
  const shape = (row: (typeof rows)[number]) => ({
    id: row.id, kind: row.kind, blocking: row.blocking, status: row.status, text: row.text,
    fromStageKey: row.fromStage.stageKey, fromTitle: title(row.fromStage.stageKey), targetStageKey: row.targetStage.stageKey, targetTitle: title(row.targetStage.stageKey),
  });
  return { outgoing: rows.filter((row) => row.fromStageId === stageId).map(shape), incoming: rows.filter((row) => row.fromStageId !== stageId).map(shape) };
}
