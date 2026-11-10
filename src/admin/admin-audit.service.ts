import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';

const detailKeysByEvent: Record<string, string[]> = {
  'quality_profile.version_activated': ['previousActiveVersion', 'activatedVersion', 'setAsDefault'],
  'quality_profile.default_changed': ['previousDefault', 'nextDefault', 'activeVersion'],
  'quality_profile.version_created': ['version', 'copiedFromVersion'],
  'account.plan_assigned': ['planKey', 'validUntil', 'note'],
  'plan.price_changed': ['planKey', 'previousPrice', 'nextPrice'],
  'billing.contact_changed': ['contactSet'],
  'privacy.retention_changed': ['previousDays', 'nextDays'],
  'account.deletion_cancelled': ['requestedAt'],
};

function safeDetails(eventType: string, value: unknown): Record<string, string | number | boolean | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = detailKeysByEvent[eventType] ?? [];
  if (allowed.length === 0) return null;
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const item = source[key];
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isSafeInteger(item))) result[key] = item;
    else if (typeof item === 'string') result[key] = item.slice(0, 80);
  }
  return result;
}

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: { eventType?: string; staffId?: string; from?: Date; to?: Date; cursor?: string; limit: number }) {
    const clauses: Prisma.AdminAuditEventWhereInput[] = [];
    if (input.eventType) clauses.push({ eventType: input.eventType });
    if (input.staffId) clauses.push({ staffId: input.staffId });
    if (input.from || input.to) clauses.push({ createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } });
    if (input.cursor) {
      const cursor = await this.prisma.adminAuditEvent.findUnique({ where: { id: input.cursor }, select: { id: true, createdAt: true } });
      if (!cursor) throw new BadRequestException('INVALID_AUDIT_CURSOR');
      clauses.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
    }
    const rows = await this.prisma.adminAuditEvent.findMany({
      where: { AND: clauses },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true, eventType: true, targetType: true, targetId: true, details: true, createdAt: true,
        staff: { select: { id: true, email: true, displayName: true, role: true } },
      },
    });
    const hasMore = rows.length > input.limit;
    const data = rows.slice(0, input.limit).map((event) => ({
      id: event.id,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetType === 'staff_identifier' ? null : event.targetId,
      details: safeDetails(event.eventType, event.details),
      createdAt: event.createdAt.toISOString(),
      actor: event.staff ? { id: event.staff.id, email: event.staff.email, displayName: event.staff.displayName, role: event.staff.role } : null,
    }));
    return { data, meta: { nextCursor: hasMore ? data[data.length - 1]?.id ?? null : null } };
  }
}
