// Prepaid project balance: paid top-ups minus the recorded cost of AI requests since prepaid billing was switched on.
import type { PrismaClient } from '../generated/prisma/client.js';

type Db = Pick<PrismaClient, 'aiPricing' | 'projectTopUp' | 'generationRun'>;

export interface BillingSettings { mode: 'off' | 'prepaid'; prepaidSince: Date | null; minTopUpTiyn: number; specialistFeeBp: number; priced: boolean; inputPerMillionTiyn: number; outputPerMillionTiyn: number }

export async function billingSettings(db: Db): Promise<BillingSettings> {
  const row = await db.aiPricing.findUnique({ where: { id: 1 } });
  return {
    mode: row?.billingMode === 'prepaid' ? 'prepaid' : 'off', prepaidSince: row?.prepaidSince ?? null, minTopUpTiyn: row?.minTopUpTiyn ?? 100_000, specialistFeeBp: row?.specialistFeeBp ?? 0,
    priced: Boolean(row), inputPerMillionTiyn: row?.inputPerMillionTiyn ?? 0, outputPerMillionTiyn: row?.outputPerMillionTiyn ?? 0,
  };
}

export async function projectBalance(db: Db, projectId: string, since: Date | null): Promise<{ paidTiyn: number; spentTiyn: number; balanceTiyn: number }> {
  const [paid, spent] = await Promise.all([
    db.projectTopUp.aggregate({ where: { projectId, status: 'paid' }, _sum: { amountTiyn: true } }),
    db.generationRun.aggregate({ where: { projectId, costTiyn: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) }, _sum: { costTiyn: true } }),
  ]);
  const paidTiyn = paid._sum.amountTiyn ?? 0;
  const spentTiyn = spent._sum.costTiyn ?? 0;
  return { paidTiyn, spentTiyn, balanceTiyn: paidTiyn - spentTiyn };
}
