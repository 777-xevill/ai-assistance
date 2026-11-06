import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { catalogItems, contacts, orders, type Contact, type Order, type Workspace } from '../db/schema.ts';
import type { DeliveryZone, OrderItem } from '../types.ts';
import { effectivePrice, formatMoney, getItemsByIds } from './catalog.ts';
import { logEvent } from './events.ts';
import { notify } from './notify.ts';
import { nextOrderNumber } from './workspace.ts';

/** An error whose message is safe and useful to show to the AI (it will relay or fix it). */
export class ToolError extends Error {}

export interface OrderLineInput {
  itemId: string;
  quantity: number;
  variant?: string;
}

export interface Quote {
  lines: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  zone: DeliveryZone | null;
  problems: string[];
  summary: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function quoteOrder(ws: Workspace, input: { items: OrderLineInput[]; deliveryZoneId?: string }): Promise<Quote> {
  const problems: string[] = [];
  if (!input.items.length) throw new ToolError('No items given.');
  const rows = await getItemsByIds(ws.id, input.items.map((i) => i.itemId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: OrderItem[] = [];
  for (const line of input.items) {
    const item = byId.get(line.itemId);
    if (!item || !item.active) {
      problems.push(`Item ${line.itemId} was not found. Use search_catalog to get a valid item_id.`);
      continue;
    }
    const qty = Math.max(1, Math.floor(line.quantity || 1));
    const price = effectivePrice(item);
    if (price === null) problems.push(`"${item.name}" has no price set; the team must confirm the price.`);
    if (item.stock !== null && item.stock < qty) {
      problems.push(item.stock <= 0 ? `"${item.name}" is out of stock.` : `Only ${item.stock} of "${item.name}" left.`);
    }
    if (item.variants.length > 0) {
      const chosen = (line.variant ?? '').toLowerCase();
      const missing = item.variants.filter((v) => !v.options.some((o) => chosen.includes(o.toLowerCase())));
      if (missing.length) problems.push(`Ask which ${missing.map((v) => v.name.toLowerCase()).join(' and ')} they want for "${item.name}" (options: ${missing.map((v) => v.options.join('/')).join('; ')}).`);
    }
    lines.push({
      itemId: item.id,
      name: item.name,
      variant: line.variant?.trim() || undefined,
      quantity: qty,
      unitPrice: price ?? 0,
      total: round2((price ?? 0) * qty),
    });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0));
  const zones = ws.commerce.deliveryZones ?? [];
  let zone: DeliveryZone | null = null;
  if (zones.length > 0) {
    zone = zones.find((z) => z.id === input.deliveryZoneId) ?? null;
    if (!zone) problems.push(`Ask which delivery area applies: ${zones.map((z) => `${z.name} (id ${z.id})`).join(', ')}.`);
  }
  let deliveryFee = zone?.fee ?? 0;
  const freeMin = ws.commerce.freeDeliveryMinimum;
  if (freeMin && subtotal >= freeMin) deliveryFee = 0;
  const total = round2(subtotal + deliveryFee);
  const cur = ws.currency;
  const summary = [
    ...lines.map((l) => `${l.quantity} × ${l.name}${l.variant ? ` (${l.variant})` : ''} = ${formatMoney(l.total, cur)}`),
    zones.length ? `Delivery${zone ? ` (${zone.name})` : ''}: ${zone ? (deliveryFee === 0 ? 'free' : formatMoney(deliveryFee, cur)) : 'depends on area'}` : null,
    `Total: ${formatMoney(total, cur)}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { lines, subtotal, deliveryFee, total, currency: cur, zone, problems, summary };
}

export async function createOrder(
  ws: Workspace,
  ctx: { contact: Contact; conversationId: string | null; isTest: boolean },
  input: {
    items: OrderLineInput[];
    deliveryZoneId?: string;
    customerName: string;
    phone: string;
    address?: string;
    email?: string;
    paymentMethodId?: string;
    notes?: string;
    extra?: Record<string, string>;
  },
): Promise<Order> {
  const quote = await quoteOrder(ws, input);
  if (quote.problems.length) throw new ToolError(`Cannot place the order yet:\n- ${quote.problems.join('\n- ')}`);

  const values: Record<string, string | undefined> = {
    name: input.customerName,
    phone: input.phone,
    address: input.address,
    email: input.email,
    ...(input.extra ?? {}),
  };
  const missing = ws.commerce.orderFields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);
  if (missing.length) throw new ToolError(`Missing required details: ${missing.join(', ')}. Ask the customer for them.`);

  const methods = ws.commerce.paymentMethods ?? [];
  const payment = methods.find((m) => m.id === input.paymentMethodId) ?? (methods.length === 1 ? methods[0] : undefined);
  if (methods.length > 1 && !payment) {
    throw new ToolError(`Ask how they want to pay: ${methods.map((m) => `${m.name} (id ${m.id})`).join(', ')}.`);
  }

  const order = await db.transaction(async (tx) => {
    // Reserve stock for tracked items; fails if someone else bought the last unit meanwhile.
    for (const line of quote.lines) {
      if (!line.itemId) continue;
      const updated = await tx
        .update(catalogItems)
        .set({ stock: sql`${catalogItems.stock} - ${line.quantity}` })
        .where(and(eq(catalogItems.id, line.itemId), sql`${catalogItems.stock} IS NOT NULL`, gte(catalogItems.stock, line.quantity)))
        .returning({ id: catalogItems.id });
      if (updated.length === 0) {
        const [item] = await tx.select({ stock: catalogItems.stock }).from(catalogItems).where(eq(catalogItems.id, line.itemId));
        if (item && item.stock !== null) throw new ToolError(`"${line.name}" just went out of stock.`);
      }
    }
    const number = await nextOrderNumber(ws.id, tx);
    const extra = Object.fromEntries(
      Object.entries(input.extra ?? {}).filter(([k, v]) => !['name', 'phone', 'address', 'email'].includes(k) && v),
    );
    const [row] = await tx
      .insert(orders)
      .values({
        workspaceId: ws.id,
        number,
        contactId: ctx.contact.id,
        conversationId: ctx.conversationId,
        items: quote.lines,
        subtotal: quote.subtotal,
        deliveryFee: quote.deliveryFee,
        total: quote.total,
        currency: ws.currency,
        customerName: input.customerName.trim(),
        phone: input.phone.trim(),
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        deliveryZone: quote.zone?.name ?? null,
        paymentMethod: payment?.name ?? null,
        notes: input.notes?.trim() || null,
        extra,
        source: 'ai',
        isTest: ctx.isTest,
      })
      .returning();
    await tx
      .update(contacts)
      .set({
        name: ctx.contact.name || input.customerName.trim(),
        phone: input.phone.trim(),
        ...(input.address ? { address: input.address.trim() } : {}),
        ...(input.email ? { email: input.email.trim() } : {}),
        stage: 'won',
      })
      .where(eq(contacts.id, ctx.contact.id));
    return row;
  });

  await logEvent(ws.id, 'order_created', {
    contactId: ctx.contact.id,
    conversationId: ctx.conversationId,
    data: { orderId: order.id, number: order.number, total: order.total, items: quote.lines.map((l) => ({ id: l.itemId, name: l.name, qty: l.quantity })), test: ctx.isTest },
  });
  if (!ctx.isTest) {
    await notify(ws, {
      type: 'order',
      title: `New order #${order.number} · ${formatMoney(order.total, ws.currency)}`,
      body: `${order.customerName} · ${order.phone}\n${order.address ?? ''}\n\n${quote.summary}${order.paymentMethod ? `\nPayment: ${order.paymentMethod}` : ''}${order.notes ? `\nNotes: ${order.notes}` : ''}`,
      link: `/orders?id=${order.id}`,
      alert: 'newOrder',
    });
  }
  return order;
}

export async function ordersForContact(workspaceId: string, contactId: string, limit = 5): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), eq(orders.contactId, contactId)))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

export async function requestOrderChange(
  ws: Workspace,
  contact: Contact,
  orderNumber: number,
  request: string,
  conversationId: string | null,
): Promise<Order> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.workspaceId, ws.id), eq(orders.number, orderNumber), eq(orders.contactId, contact.id)))
    .limit(1);
  if (!order) throw new ToolError(`No order #${orderNumber} found for this customer.`);
  if (['shipped', 'delivered'].includes(order.status) && /cancel/i.test(request)) {
    throw new ToolError(`Order #${orderNumber} is already ${order.status}; it can no longer be cancelled in chat. Offer to connect the team.`);
  }
  const [updated] = await db
    .update(orders)
    .set({ changeRequest: request.slice(0, 1000) })
    .where(eq(orders.id, order.id))
    .returning();
  await logEvent(ws.id, 'order_change_requested', { contactId: contact.id, conversationId, data: { number: orderNumber, request } });
  if (!contact.isTest) {
    await notify(ws, {
      type: 'order',
      title: `Change requested for order #${orderNumber}`,
      body: `${contact.name ?? 'Customer'}: ${request}`,
      link: `/orders?id=${order.id}`,
      alert: 'newOrder',
    });
  }
  return updated;
}
