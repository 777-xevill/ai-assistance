import { and, desc, eq, gt, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { adapterFor } from '../channels/index.ts';
import { db } from '../db/index.ts';
import { bookings, channels, contacts, conversations, orders, type Contact } from '../db/schema.ts';
import { badRequest, notFound, parse } from '../lib/http.ts';
import { saveMedia } from '../lib/storage.ts';
import { toCsv } from '../lib/text.ts';
import { cancelQueued } from '../queue/index.ts';
import { getBundle, isAiPaused, listMessages, setAiPaused } from '../services/conversations.ts';
import { scheduleReply } from '../services/inbound.ts';
import { sendOutbound } from '../services/outbound.ts';
import { replyBlocker } from '../jobs/reply.ts';
import type { ChannelType } from '../types.ts';
import { publicChannel } from './channels.ts';
import { me, ws } from './middleware.ts';
import { upload } from './workspace.ts';

export const inboxRouter = Router({ mergeParams: true });
export const contactsRouter = Router({ mergeParams: true });

function contactSummary(c: Contact) {
  return { id: c.id, name: c.name, username: c.username, avatarUrl: c.avatarUrl, phone: c.phone, stage: c.stage, score: c.score };
}

inboxRouter.get('/', async (req, res) => {
  const w = ws(req);
  const filter = String(req.query.filter ?? 'all');
  const channelType = typeof req.query.channel === 'string' && req.query.channel ? req.query.channel : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
  const now = new Date();
  const rows = await db
    .select({ conversation: conversations, contact: contacts, channel: channels })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(
      and(
        eq(conversations.workspaceId, w.id),
        eq(conversations.isTest, false),
        filter === 'needs_human' ? eq(conversations.needsHuman, true) : undefined,
        filter === 'unread' ? gt(conversations.unreadCount, 0) : undefined,
        filter === 'ai_paused'
          ? and(eq(conversations.aiPaused, true), or(isNull(conversations.aiPausedUntil), gt(conversations.aiPausedUntil, now)))
          : undefined,
        filter === 'closed' ? eq(conversations.status, 'closed') : undefined,
        channelType ? eq(channels.type, channelType as ChannelType) : undefined,
        q
          ? or(
              ilike(contacts.name, `%${q}%`),
              ilike(contacts.phone, `%${q}%`),
              ilike(contacts.username, `%${q}%`),
              ilike(conversations.lastMessagePreview, `%${q}%`),
            )
          : undefined,
        before ? lt(conversations.lastMessageAt, before) : undefined,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(40);
  res.json({
    conversations: rows.map((r) => ({
      ...r.conversation,
      aiPaused: isAiPaused(r.conversation),
      contact: contactSummary(r.contact),
      channel: { id: r.channel.id, type: r.channel.type, name: r.channel.name },
    })),
  });
});

inboxRouter.get('/badge', async (req, res) => {
  const w = ws(req);
  const res1 = await db.execute(sql`
    SELECT count(*) FILTER (WHERE unread_count > 0)::int AS unread, count(*) FILTER (WHERE needs_human)::int AS needs_human
    FROM conversations WHERE workspace_id = ${w.id} AND is_test = false`);
  const row = res1.rows[0] as { unread: number; needs_human: number };
  res.json({ unread: Number(row.unread), needsHuman: Number(row.needs_human) });
});

async function loadBundle(workspaceId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Conversation not found');
  const bundle = await getBundle(id);
  if (!bundle || bundle.workspace.id !== workspaceId) throw notFound('Conversation not found');
  return bundle;
}

inboxRouter.get('/:id', async (req, res) => {
  const w = ws(req);
  const bundle = await loadBundle(w.id, String(req.params.id));
  const { conversation, contact, channel } = bundle;
  const [msgs, contactOrders, contactBookings, blocker] = await Promise.all([
    listMessages(conversation.id, 300),
    db.select().from(orders).where(eq(orders.contactId, contact.id)).orderBy(desc(orders.createdAt)).limit(10),
    db.select().from(bookings).where(eq(bookings.contactId, contact.id)).orderBy(desc(bookings.startAt)).limit(10),
    replyBlocker(bundle, 'reply'),
  ]);
  const canSend = adapterFor(channel.type).canSend?.(conversation, 'human') ?? { ok: true };
  res.json({
    conversation: { ...conversation, aiPaused: isAiPaused(conversation) },
    contact,
    channel: publicChannel(channel),
    messages: msgs,
    orders: contactOrders,
    bookings: contactBookings,
    ai: { blocker: blocker === 'Nothing new to answer.' ? null : blocker },
    canReply: canSend,
  });
});

inboxRouter.post('/:id/messages', upload.single('file'), async (req, res) => {
  const w = ws(req);
  const bundle = await loadBundle(w.id, String(req.params.id));
  const body = parse(z.object({ text: z.string().max(4000).optional(), keepAi: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional() }), req.body ?? {});
  const text = body.text?.trim();
  if (!text && !req.file) throw badRequest('Write a message or attach a photo');
  const can = adapterFor(bundle.channel.type).canSend?.(bundle.conversation, 'human');
  if (can && !can.ok) throw badRequest(can.reason);

  const sent = [];
  if (req.file) {
    if (!/^image\//.test(req.file.mimetype)) throw badRequest('Only photos can be attached for now');
    const saved = await saveMedia(w.id, req.file.buffer, req.file.mimetype, { name: req.file.originalname });
    sent.push(await sendOutbound(bundle, { imageUrl: saved.url, sender: 'human', userId: me(req).id }));
  }
  if (text) sent.push(await sendOutbound(bundle, { text, sender: 'human', userId: me(req).id }));

  const keepAi = body.keepAi === true || body.keepAi === 'true';
  await db
    .update(conversations)
    .set({
      needsHuman: false,
      unreadCount: 0,
      ...(keepAi
        ? {}
        : { aiPaused: true, aiPausedUntil: new Date(Date.now() + (w.ai.pauseAfterHumanMinutes || 60) * 60_000) }),
    })
    .where(eq(conversations.id, bundle.conversation.id));
  if (!keepAi) await cancelQueued(`reply:${bundle.conversation.id}`);
  const failed = sent.find((m) => m.status === 'failed');
  res.status(failed ? 502 : 201).json({ messages: sent, error: failed?.error });
});

inboxRouter.post('/:id/ai', async (req, res) => {
  const w = ws(req);
  const bundle = await loadBundle(w.id, String(req.params.id));
  const body = parse(z.object({ paused: z.boolean(), minutes: z.number().int().min(1).max(100_000).nullable().optional() }), req.body);
  await setAiPaused(bundle.conversation.id, body.paused, body.paused ? body.minutes ?? null : null);
  if (!body.paused) {
    await db.update(conversations).set({ needsHuman: false }).where(eq(conversations.id, bundle.conversation.id));
    await scheduleReply(bundle.conversation.id, 500);
  } else {
    await cancelQueued(`reply:${bundle.conversation.id}`);
  }
  res.json({ ok: true });
});

inboxRouter.post('/:id/read', async (req, res) => {
  const w = ws(req);
  await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(and(eq(conversations.id, String(req.params.id)), eq(conversations.workspaceId, w.id)));
  res.json({ ok: true });
});

inboxRouter.patch('/:id', async (req, res) => {
  const w = ws(req);
  const bundle = await loadBundle(w.id, String(req.params.id));
  const body = parse(
    z.object({ status: z.enum(['open', 'closed']).optional(), needsHuman: z.boolean().optional(), assignedUserId: z.string().uuid().nullable().optional() }),
    req.body,
  );
  const [updated] = await db.update(conversations).set(body).where(eq(conversations.id, bundle.conversation.id)).returning();
  res.json({ conversation: updated });
});

// ---------------------------------------------------------------------------
// Contacts / CRM
// ---------------------------------------------------------------------------

const STAGES = ['new', 'interested', 'qualified', 'negotiating', 'won', 'lost'] as const;

contactsRouter.get('/', async (req, res) => {
  const w = ws(req);
  const stage = STAGES.includes(req.query.stage as (typeof STAGES)[number]) ? (req.query.stage as (typeof STAGES)[number]) : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(0, Number(req.query.page ?? 0) || 0);
  const rows = await db
    .select({ contact: contacts, channelType: channels.type, conversationId: conversations.id, lastMessageAt: conversations.lastMessageAt })
    .from(contacts)
    .innerJoin(channels, eq(channels.id, contacts.channelId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(
      and(
        eq(contacts.workspaceId, w.id),
        eq(contacts.isTest, false),
        stage ? eq(contacts.stage, stage) : undefined,
        q ? or(ilike(contacts.name, `%${q}%`), ilike(contacts.phone, `%${q}%`), ilike(contacts.email, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(contacts.updatedAt))
    .limit(50)
    .offset(page * 50);
  const counts = await db.execute(sql`SELECT stage, count(*)::int AS n FROM contacts WHERE workspace_id = ${w.id} AND is_test = false GROUP BY stage`);
  res.json({
    contacts: rows.map((r) => ({ ...r.contact, channelType: r.channelType, conversationId: r.conversationId, lastMessageAt: r.lastMessageAt })),
    stageCounts: Object.fromEntries((counts.rows as { stage: string; n: number }[]).map((c) => [c.stage, Number(c.n)])),
  });
});

contactsRouter.get('/export.csv', async (req, res) => {
  const w = ws(req);
  const rows = await db
    .select({ contact: contacts, channelType: channels.type })
    .from(contacts)
    .innerJoin(channels, eq(channels.id, contacts.channelId))
    .where(and(eq(contacts.workspaceId, w.id), eq(contacts.isTest, false)))
    .orderBy(desc(contacts.createdAt));
  const csv = toCsv([
    ['name', 'phone', 'email', 'address', 'city', 'channel', 'stage', 'score', 'wants', 'budget', 'timeline', 'tags', 'notes', 'created_at'],
    ...rows.map(({ contact: c, channelType }) => [
      c.name,
      c.phone,
      c.email,
      c.address,
      c.city,
      channelType,
      c.stage,
      c.score,
      c.lead.intent,
      c.lead.budget,
      c.lead.timeline,
      c.tags.join(', '),
      c.notes,
      c.createdAt.toISOString(),
    ]),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send('﻿' + csv);
});

contactsRouter.get('/:id', async (req, res) => {
  const w = ws(req);
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const [row] = await db
    .select({ contact: contacts, channel: channels, conversation: conversations })
    .from(contacts)
    .innerJoin(channels, eq(channels.id, contacts.channelId))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(and(eq(contacts.id, id), eq(contacts.workspaceId, w.id)))
    .limit(1);
  if (!row) throw notFound();
  const [contactOrders, contactBookings] = await Promise.all([
    db.select().from(orders).where(eq(orders.contactId, id)).orderBy(desc(orders.createdAt)).limit(20),
    db.select().from(bookings).where(eq(bookings.contactId, id)).orderBy(desc(bookings.startAt)).limit(20),
  ]);
  res.json({ contact: row.contact, channel: publicChannel(row.channel), conversation: row.conversation, orders: contactOrders, bookings: contactBookings });
});

contactsRouter.patch('/:id', async (req, res) => {
  const w = ws(req);
  const body = parse(
    z.object({
      name: z.string().trim().max(120).nullable().optional(),
      phone: z.string().trim().max(60).nullable().optional(),
      email: z.string().trim().max(200).nullable().optional(),
      address: z.string().trim().max(500).nullable().optional(),
      city: z.string().trim().max(100).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      stage: z.enum(STAGES).optional(),
      score: z.number().int().min(0).max(100).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    }),
    req.body,
  );
  const [updated] = await db
    .update(contacts)
    .set(body)
    .where(and(eq(contacts.id, String(req.params.id)), eq(contacts.workspaceId, w.id)))
    .returning();
  if (!updated) throw notFound();
  res.json({ contact: updated });
});
