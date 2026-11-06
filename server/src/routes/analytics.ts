import { and, count, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { contacts, conversations, knowledgeGaps, messages, orders, reports } from '../db/schema.ts';
import { notFound, parse, rateLimit } from '../lib/http.ts';
import { addDaysStr, localDateStr, zonedToUtc } from '../lib/time.ts';
import { computeStats, leadFunnel, recentActivity, timeseries, topItems } from '../services/analytics.ts';
import { generateReport } from '../services/reports.ts';
import { ws } from './middleware.ts';

export const analyticsRouter = Router({ mergeParams: true });
export const reportsRouter = Router({ mergeParams: true });

analyticsRouter.get('/overview', async (req, res) => {
  const w = ws(req);
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  // "Last N days" = today plus the N-1 previous calendar days, in the business's timezone.
  const today = localDateStr(new Date(), w.timezone);
  const to = new Date();
  const from = zonedToUtc(addDaysStr(today, -(days - 1)), '00:00', w.timezone);
  const prevFrom = zonedToUtc(addDaysStr(today, -(2 * days - 1)), '00:00', w.timezone);
  const [stats, previous, series, items, funnel, activity, needsHuman, [gaps], [changes], [failed]] = await Promise.all([
    computeStats(w, from, to),
    computeStats(w, prevFrom, from),
    timeseries(w, from, to),
    topItems(w, from, to),
    leadFunnel(w, from, to),
    recentActivity(w, 15),
    db
      .select({ id: conversations.id, reason: conversations.handoffReason, lastMessageAt: conversations.lastMessageAt, name: contacts.name, preview: conversations.lastMessagePreview })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(conversations.workspaceId, w.id), eq(conversations.needsHuman, true), eq(conversations.isTest, false)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(5),
    db.select({ n: count() }).from(knowledgeGaps).where(and(eq(knowledgeGaps.workspaceId, w.id), eq(knowledgeGaps.status, 'open'))),
    db.select({ n: count() }).from(orders).where(and(eq(orders.workspaceId, w.id), isNotNull(orders.changeRequest), eq(orders.isTest, false))),
    db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.workspaceId, w.id), eq(messages.status, 'failed'), gte(messages.createdAt, new Date(Date.now() - 86_400_000)))),
  ]);
  res.json({
    range: { from, to, days },
    stats,
    previous,
    series,
    items,
    funnel,
    activity,
    attention: { needsHuman, openGaps: Number(gaps.n), orderChanges: Number(changes.n), failedMessages: Number(failed.n) },
  });
});

reportsRouter.get('/', async (req, res) => {
  const rows = await db
    .select({ id: reports.id, period: reports.period, label: reports.label, createdAt: reports.createdAt, emailedAt: reports.emailedAt, stats: reports.stats })
    .from(reports)
    .where(eq(reports.workspaceId, ws(req).id))
    .orderBy(desc(reports.createdAt))
    .limit(60);
  res.json({ reports: rows });
});

reportsRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, id), eq(reports.workspaceId, ws(req).id)))
    .limit(1);
  if (!row) throw notFound();
  res.json({ report: row });
});

reportsRouter.post('/generate', async (req, res) => {
  const w = ws(req);
  rateLimit(`report:${w.id}`, 6, 60 * 60_000);
  const body = parse(z.object({ period: z.enum(['daily', 'weekly']).default('daily'), email: z.boolean().default(false) }), req.body ?? {});
  const report = await generateReport(w, body.period, { email: body.email });
  res.status(201).json({ report });
});
