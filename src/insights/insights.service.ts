import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { sitesConfig } from '../publishing/slug.js';
import { dayIn } from '../sites/visit-counter.js';
import { change, conversion, fillDays, periodOf, top } from './insights-rules.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const timeZone = () => {
  const value = process.env.SITES_STATS_TIMEZONE;
  if (!value) return 'Asia/Almaty';
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return 'Asia/Almaty'; }
};

/**
 * «After launch» for a published BuildPath site: page views by day, popular pages, where visitors come from, and what
 * they did — leads, bookings, orders. Counts only; no visitor can be told apart. Members of the project only.
 */
@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async project(userId: string, projectId: string, rawDays: unknown) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { id: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    const days = periodOf(rawDays);
    const zone = timeZone();
    const today = dayIn(zone);
    const start = new Date(new Date(`${today}T00:00:00Z`).getTime() - (days - 1) * 86_400_000);
    const previousStart = new Date(start.getTime() - days * 86_400_000);
    const since = new Date(start.getTime() - 14 * 3_600_000); // a little earlier, so time zones ahead of UTC are covered
    const [publication, rows, previous, leads, bookings, orders] = await Promise.all([
      this.prisma.sitePublication.findUnique({ where: { projectId }, select: { status: true, slug: true, customDomain: true, domainStatus: true, publishedAt: true } }),
      this.prisma.siteVisitCount.findMany({ where: { projectId, day: { gte: start } }, select: { day: true, path: true, source: true, views: true } }),
      this.prisma.siteVisitCount.aggregate({ where: { projectId, day: { gte: previousStart, lt: start } }, _sum: { views: true } }),
      this.prisma.siteLead.count({ where: { projectId, createdAt: { gte: since } } }),
      this.prisma.booking.count({ where: { projectId, createdAt: { gte: since } } }),
      this.prisma.storeOrder.count({ where: { projectId, createdAt: { gte: since } } }),
    ]);
    const daily = fillDays(rows.map((row) => ({ day: row.day.toISOString().slice(0, 10), views: row.views })), today, days);
    const views = daily.reduce((sum, row) => sum + row.views, 0);
    const sum = <K extends 'path' | 'source'>(key: K) => {
      const map = new Map<string, number>();
      for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + row.views);
      return [...map].map(([name, total]) => ({ name, views: total }));
    };
    const live = publication?.status === 'live';
    const url = !publication ? null : publication.domainStatus === 'active' && publication.customDomain ? `https://${publication.customDomain}` : sitesConfig().urlFor(publication.slug);
    return {
      data: {
        published: live, url: live ? url : null, publishedAt: publication?.publishedAt ?? null, timeZone: zone, days,
        views, previousViews: previous._sum.views ?? 0, change: change(views, previous._sum.views ?? 0),
        daily,
        pages: top(sum('path'), 5, (rest) => ({ name: 'other', views: rest })),
        sources: top(sum('source'), 5, (rest) => ({ name: 'other', views: rest })),
        actions: { leads, bookings, orders, perHundredViews: conversion(leads + bookings + orders, views) },
      },
    };
  }
}
