import { and, asc, desc, eq, gte, ilike, isNotNull, lt, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { adapterFor } from '../channels/index.ts';
import { db } from '../db/index.ts';
import { bookings, catalogItems, contacts, orders, type Booking, type Order } from '../db/schema.ts';
import { badRequest, notFound, parse } from '../lib/http.ts';
import { toCsv } from '../lib/text.ts';
import { getAvailability } from '../services/bookings.ts';
import { getBundle } from '../services/conversations.ts';
import { sendOutbound } from '../services/outbound.ts';
import type { OrderStatus } from '../types.ts';
import { me, ws } from './middleware.ts';

export const ordersRouter = Router({ mergeParams: true });
export const bookingsRouter = Router({ mergeParams: true });

const ORDER_STATUSES = ['new', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
const INACTIVE: OrderStatus[] = ['cancelled', 'returned'];

/** Sends a message to the customer in the conversation an order/booking came from. */
async function messageCustomer(conversationId: string | null, text: string, userId: string): Promise<{ sent: boolean; error?: string }> {
  if (!conversationId) return { sent: false, error: 'This record has no conversation' };
  const bundle = await getBundle(conversationId);
  if (!bundle) return { sent: false, error: 'Conversation not found' };
  const can = adapterFor(bundle.channel.type).canSend?.(bundle.conversation, 'human');
  if (can && !can.ok) return { sent: false, error: can.reason };
  const msg = await sendOutbound(bundle, { text, sender: 'human', userId });
  return msg.status === 'failed' ? { sent: false, error: msg.error ?? 'Delivery failed' } : { sent: true };
}

ordersRouter.get('/', async (req, res) => {
  const w = ws(req);
  const status = ORDER_STATUSES.includes(req.query.status as OrderStatus) ? (req.query.status as OrderStatus) : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(0, Number(req.query.page ?? 0) || 0);
  const num = Number(q.replace(/^#/, ''));
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.workspaceId, w.id),
        eq(orders.isTest, req.query.test === '1'),
        status ? eq(orders.status, status) : undefined,
        req.query.changes === '1' ? isNotNull(orders.changeRequest) : undefined,
        q
          ? or(
              ilike(orders.customerName, `%${q}%`),
              ilike(orders.phone, `%${q}%`),
              Number.isInteger(num) && num > 0 ? eq(orders.number, num) : undefined,
            )
          : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(50)
    .offset(page * 50);
  const counts = await db.execute(
    sql`SELECT status, count(*)::int AS n FROM orders WHERE workspace_id = ${w.id} AND is_test = false GROUP BY status`,
  );
  res.json({
    orders: rows,
    statusCounts: Object.fromEntries((counts.rows as { status: string; n: number }[]).map((c) => [c.status, Number(c.n)])),
  });
});

ordersRouter.get('/export.csv', async (req, res) => {
  const w = ws(req);
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.workspaceId, w.id), eq(orders.isTest, false)))
    .orderBy(desc(orders.createdAt));
  const csv = toCsv([
    ['number', 'date', 'status', 'customer', 'phone', 'address', 'delivery_area', 'payment', 'items', 'subtotal', 'delivery_fee', 'total', 'currency', 'notes'],
    ...rows.map((o) => [
      o.number,
      o.createdAt.toISOString(),
      o.status,
      o.customerName,
      o.phone,
      o.address,
      o.deliveryZone,
      o.paymentMethod,
      o.items.map((i) => `${i.quantity} x ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join('; '),
      o.subtotal,
      o.deliveryFee,
      o.total,
      o.currency,
      o.notes,
    ]),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('﻿' + csv);
});

async function findOrder(workspaceId: string, id: string): Promise<Order> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Order not found');
  const [o] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  if (!o) throw notFound('Order not found');
  return o;
}

ordersRouter.get('/:id', async (req, res) => {
  const w = ws(req);
  const order = await findOrder(w.id, String(req.params.id));
  const [contact] = order.contactId ? await db.select().from(contacts).where(eq(contacts.id, order.contactId)).limit(1) : [];
  res.json({ order, contact: contact ?? null });
});

ordersRouter.patch('/:id', async (req, res) => {
  const w = ws(req);
  const order = await findOrder(w.id, String(req.params.id));
  const body = parse(
    z.object({
      status: z.enum(ORDER_STATUSES).optional(),
      notes: z.string().max(2000).nullable().optional(),
      customerName: z.string().trim().min(1).max(120).optional(),
      phone: z.string().trim().min(3).max(60).optional(),
      address: z.string().trim().max(500).nullable().optional(),
      clearChangeRequest: z.boolean().optional(),
      customerMessage: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  const { clearChangeRequest, customerMessage, ...fields } = body;
  const updated = await db.transaction(async (tx) => {
    // Put tracked stock back when an order is cancelled or returned.
    if (body.status && INACTIVE.includes(body.status) && !INACTIVE.includes(order.status)) {
      for (const line of order.items) {
        if (!line.itemId) continue;
        await tx
          .update(catalogItems)
          .set({ stock: sql`${catalogItems.stock} + ${line.quantity}` })
          .where(and(eq(catalogItems.id, line.itemId), isNotNull(catalogItems.stock)));
      }
    }
    const [row] = await tx
      .update(orders)
      .set({ ...fields, ...(clearChangeRequest ? { changeRequest: null } : {}) })
      .where(eq(orders.id, order.id))
      .returning();
    return row;
  });
  const notified = customerMessage ? await messageCustomer(order.conversationId, customerMessage, me(req).id) : null;
  res.json({ order: updated, notified });
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

bookingsRouter.get('/', async (req, res) => {
  const w = ws(req);
  const from = typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from) : new Date(Date.now() - 86_400_000);
  const to = typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to)) ? new Date(req.query.to) : new Date(Date.now() + 60 * 86_400_000);
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.workspaceId, w.id), eq(bookings.isTest, false), gte(bookings.startAt, from), lt(bookings.startAt, to)))
    .orderBy(asc(bookings.startAt))
    .limit(500);
  res.json({ bookings: rows });
});

bookingsRouter.get('/availability', async (req, res) => {
  const w = ws(req);
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
  const serviceId = typeof req.query.serviceId === 'string' && req.query.serviceId ? req.query.serviceId : undefined;
  res.json({ days: await getAvailability(w, { date, days: Math.min(Number(req.query.days) || 7, 14), serviceId }) });
});

async function findBooking(workspaceId: string, id: string): Promise<Booking> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Booking not found');
  const [b] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.workspaceId, workspaceId)))
    .limit(1);
  if (!b) throw notFound('Booking not found');
  return b;
}

bookingsRouter.patch('/:id', async (req, res) => {
  const w = ws(req);
  const booking = await findBooking(w.id, String(req.params.id));
  const body = parse(
    z.object({
      status: z.enum(['confirmed', 'completed', 'cancelled', 'no_show']).optional(),
      startAt: z.string().datetime({ offset: true }).optional(),
      notes: z.string().max(2000).nullable().optional(),
      customerMessage: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  const patch: Partial<Booking> = {};
  if (body.status) patch.status = body.status;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.startAt) {
    const start = new Date(body.startAt);
    if (Number.isNaN(start.getTime())) throw badRequest('Invalid start time');
    patch.startAt = start;
    patch.endAt = new Date(start.getTime() + (booking.endAt.getTime() - booking.startAt.getTime()));
  }
  const [updated] = await db.update(bookings).set(patch).where(eq(bookings.id, booking.id)).returning();
  const notified = body.customerMessage ? await messageCustomer(booking.conversationId, body.customerMessage, me(req).id) : null;
  res.json({ booking: updated, notified });
});
