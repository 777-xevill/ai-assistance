import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import type { Workspace } from '../db/schema.ts';
import { addDaysStr, localDateStr } from '../lib/time.ts';

// All analytics exclude test data from the dashboard playground.

async function one<T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T> {
  const res = await db.execute(query);
  return (res.rows[0] ?? {}) as T;
}

async function many<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db.execute(query);
  return res.rows as T[];
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface Stats {
  newConversations: number;
  activeConversations: number;
  inboundMessages: number;
  aiReplies: number;
  humanReplies: number;
  newLeads: number;
  qualifiedLeads: number;
  lostLeads: number;
  orders: number;
  revenue: number;
  avgOrderValue: number;
  bookings: number;
  handoffs: number;
  knowledgeGaps: number;
  followups: number;
  avgFirstResponseSec: number | null;
  conversionRate: number;
  aiHandledRate: number;
  byChannel: { channel: string; conversations: number }[];
}

export async function computeStats(ws: Workspace, from: Date, to: Date): Promise<Stats> {
  const w = ws.id;
  const f = from.toISOString();
  const t = to.toISOString();
  const range = (col: string) => sql.raw(`${col} >= '${f}'::timestamptz AND ${col} < '${t}'::timestamptz`);

  const [conv, active, msgs, leads, qualified, ord, book, handoffs, gaps, followups, channelsRows] = await Promise.all([
    one<{ n: number; avg_ms: number | null }>(sql`
      SELECT count(*)::int AS n, avg(first_response_ms)::float AS avg_ms FROM conversations
      WHERE workspace_id = ${w} AND is_test = false AND ${range('created_at')}`),
    one<{ n: number }>(sql`
      SELECT count(DISTINCT m.conversation_id)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.workspace_id = ${w} AND c.is_test = false AND m.direction = 'in' AND ${range('m.created_at')}`),
    many<{ sender: string; n: number }>(sql`
      SELECT m.sender, count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.workspace_id = ${w} AND c.is_test = false AND ${range('m.created_at')} GROUP BY m.sender`),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${w} AND is_test = false AND ${range('created_at')}`),
    many<{ to: string; n: number }>(sql`
      SELECT e.data->>'to' AS to, count(DISTINCT e.contact_id)::int AS n FROM events e JOIN contacts ct ON ct.id = e.contact_id
      WHERE e.workspace_id = ${w} AND e.type = 'lead_stage_changed' AND ct.is_test = false AND ${range('e.created_at')}
      GROUP BY 1`),
    one<{ n: number; revenue: number }>(sql`
      SELECT count(*)::int AS n, coalesce(sum(total), 0)::float AS revenue FROM orders
      WHERE workspace_id = ${w} AND is_test = false AND status <> 'cancelled' AND ${range('created_at')}`),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bookings
      WHERE workspace_id = ${w} AND is_test = false AND status <> 'cancelled' AND ${range('created_at')}`),
    one<{ n: number; convs: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT conversation_id)::int AS convs FROM events
      WHERE workspace_id = ${w} AND type = 'handoff' AND coalesce(data->>'test', 'false') <> 'true' AND ${range('created_at')}`),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM knowledge_gaps WHERE workspace_id = ${w} AND ${range('created_at')}`),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events WHERE workspace_id = ${w} AND type = 'followup_sent' AND ${range('created_at')}`),
    many<{ channel: string; n: number }>(sql`
      SELECT ch.type AS channel, count(*)::int AS n FROM conversations c JOIN channels ch ON ch.id = c.channel_id
      WHERE c.workspace_id = ${w} AND c.is_test = false AND ${range('c.created_at')} GROUP BY ch.type ORDER BY n DESC`),
  ]);

  const bySender = Object.fromEntries(msgs.map((m) => [m.sender, num(m.n)]));
  const stage = Object.fromEntries(qualified.map((q) => [q.to, num(q.n)]));
  const newConversations = num(conv.n);
  const activeConversations = num(active.n);
  const orders = num(ord.n);
  const revenue = num(ord.revenue);
  const bookings = num(book.n);
  return {
    newConversations,
    activeConversations,
    inboundMessages: bySender.customer ?? 0,
    aiReplies: bySender.ai ?? 0,
    humanReplies: bySender.human ?? 0,
    newLeads: num(leads.n),
    qualifiedLeads: (stage.qualified ?? 0) + (stage.negotiating ?? 0),
    lostLeads: stage.lost ?? 0,
    orders,
    revenue: Math.round(revenue * 100) / 100,
    avgOrderValue: orders ? Math.round((revenue / orders) * 100) / 100 : 0,
    bookings,
    handoffs: num(handoffs.n),
    knowledgeGaps: num(gaps.n),
    followups: num(followups.n),
    avgFirstResponseSec: conv.avg_ms === null || conv.avg_ms === undefined ? null : Math.round(num(conv.avg_ms) / 1000),
    conversionRate: newConversations ? Math.round(((orders + bookings) / newConversations) * 1000) / 10 : 0,
    aiHandledRate: activeConversations ? Math.round((1 - num(handoffs.convs) / activeConversations) * 1000) / 10 : 100,
    byChannel: channelsRows.map((r) => ({ channel: r.channel, conversations: num(r.n) })),
  };
}

export interface DayPoint {
  date: string;
  conversations: number;
  orders: number;
  revenue: number;
  bookings: number;
}

export async function timeseries(ws: Workspace, from: Date, to: Date): Promise<DayPoint[]> {
  const tz = ws.timezone;
  const w = ws.id;
  const f = from.toISOString();
  const t = to.toISOString();
  const [convs, ords, books] = await Promise.all([
    many<{ day: string; n: number }>(sql`
      SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM conversations
      WHERE workspace_id = ${w} AND is_test = false AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz GROUP BY 1`),
    many<{ day: string; n: number; revenue: number }>(sql`
      SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*)::int AS n, coalesce(sum(total), 0)::float AS revenue FROM orders
      WHERE workspace_id = ${w} AND is_test = false AND status <> 'cancelled' AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz GROUP BY 1`),
    many<{ day: string; n: number }>(sql`
      SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM bookings
      WHERE workspace_id = ${w} AND is_test = false AND status <> 'cancelled' AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz GROUP BY 1`),
  ]);
  const c = new Map(convs.map((r) => [r.day, num(r.n)]));
  const o = new Map(ords.map((r) => [r.day, r]));
  const b = new Map(books.map((r) => [r.day, num(r.n)]));
  const out: DayPoint[] = [];
  const last = localDateStr(new Date(to.getTime() - 1), tz);
  for (let d = localDateStr(from, tz), guard = 0; d <= last && guard < 400; d = addDaysStr(d, 1), guard++) {
    out.push({
      date: d,
      conversations: c.get(d) ?? 0,
      orders: num(o.get(d)?.n),
      revenue: Math.round(num(o.get(d)?.revenue) * 100) / 100,
      bookings: b.get(d) ?? 0,
    });
  }
  return out;
}

export async function topItems(ws: Workspace, from: Date, to: Date) {
  const w = ws.id;
  const f = from.toISOString();
  const t = to.toISOString();
  const [viewed, sold] = await Promise.all([
    many<{ name: string; n: number }>(sql`
      SELECT data->>'name' AS name, count(*)::int AS n FROM events
      WHERE workspace_id = ${w} AND type = 'item_viewed' AND coalesce(data->>'test', 'false') <> 'true'
        AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz
      GROUP BY 1 ORDER BY n DESC LIMIT 8`),
    many<{ name: string; qty: number; revenue: number }>(sql`
      SELECT item->>'name' AS name, sum((item->>'quantity')::int)::int AS qty, sum((item->>'total')::numeric)::float AS revenue
      FROM orders, jsonb_array_elements(items) AS item
      WHERE workspace_id = ${w} AND is_test = false AND status <> 'cancelled'
        AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz
      GROUP BY 1 ORDER BY qty DESC LIMIT 8`),
  ]);
  return {
    mostAskedAbout: viewed.map((v) => ({ name: v.name, count: num(v.n) })),
    bestSellers: sold.map((s) => ({ name: s.name, quantity: num(s.qty), revenue: num(s.revenue) })),
  };
}

export async function leadFunnel(ws: Workspace, from: Date, to: Date) {
  const rows = await many<{ stage: string; n: number }>(sql`
    SELECT stage, count(*)::int AS n FROM contacts
    WHERE workspace_id = ${ws.id} AND is_test = false AND created_at >= ${from.toISOString()}::timestamptz AND created_at < ${to.toISOString()}::timestamptz
    GROUP BY stage`);
  const by = Object.fromEntries(rows.map((r) => [r.stage, num(r.n)]));
  const total = rows.reduce((s, r) => s + num(r.n), 0);
  const interestedPlus = (by.interested ?? 0) + (by.qualified ?? 0) + (by.negotiating ?? 0) + (by.won ?? 0);
  const qualifiedPlus = (by.qualified ?? 0) + (by.negotiating ?? 0) + (by.won ?? 0);
  return [
    { stage: 'Conversations', count: total },
    { stage: 'Interested', count: interestedPlus },
    { stage: 'Qualified', count: qualifiedPlus },
    { stage: 'Won', count: by.won ?? 0 },
  ];
}

export async function recentActivity(ws: Workspace, limit = 20) {
  return many<{ id: string; type: string; data: Record<string, unknown>; created_at: string; contact_name: string | null; conversation_id: string | null }>(sql`
    SELECT e.id, e.type, e.data, e.created_at::text AS created_at, ct.name AS contact_name, e.conversation_id
    FROM events e LEFT JOIN contacts ct ON ct.id = e.contact_id
    WHERE e.workspace_id = ${ws.id} AND e.type NOT IN ('item_viewed') AND coalesce(e.data->>'test', 'false') <> 'true'
      AND (ct.id IS NULL OR ct.is_test = false)
    ORDER BY e.created_at DESC LIMIT ${limit}`);
}
