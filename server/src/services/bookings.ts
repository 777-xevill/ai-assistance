import { and, asc, eq, gt, gte, lt, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { bookings, contacts, type Booking, type CatalogItem, type Contact, type Workspace } from '../db/schema.ts';
import {
  addDaysStr,
  formatLocal,
  localDateStr,
  minutesToTime,
  timeToMinutes,
  weekdayOfDateStr,
  zonedToUtc,
} from '../lib/time.ts';
import type { LeadStage } from '../types.ts';
import { getItem } from './catalog.ts';
import { logEvent } from './events.ts';
import { notify } from './notify.ts';
import { ToolError } from './orders.ts';
import { nextBookingNumber } from './workspace.ts';

export interface DayAvailability {
  date: string;
  weekday: string;
  slots: string[];
}

function durationFor(ws: Workspace, service: CatalogItem | null): number {
  return service?.durationMinutes || ws.booking.defaultDurationMinutes || 60;
}

async function confirmedBetween(workspaceId: string, from: Date, to: Date, excludeId?: string): Promise<Booking[]> {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.status, 'confirmed'),
        lt(bookings.startAt, to),
        gt(bookings.endAt, from),
        excludeId ? ne(bookings.id, excludeId) : undefined,
      ),
    );
}

/** Free start times per day, in the workspace's local time. */
export async function getAvailability(
  ws: Workspace,
  opts: { serviceId?: string; date?: string; days?: number; excludeBookingId?: string },
): Promise<DayAvailability[]> {
  const tz = ws.timezone;
  const service = opts.serviceId ? await getItem(ws.id, opts.serviceId) : null;
  const duration = durationFor(ws, service);
  const hours = ws.booking.hours ?? ws.profile.hours;
  const step = Math.max(5, ws.booking.slotMinutes || 30);
  const capacity = Math.max(1, ws.booking.capacityPerSlot || 1);
  const earliest = Date.now() + (ws.booking.minNoticeMinutes ?? 0) * 60_000;
  const today = localDateStr(new Date(), tz);
  const lastDay = addDaysStr(today, ws.booking.maxDaysAhead || 30);
  const start = opts.date && opts.date >= today ? opts.date : today;
  const days = Math.min(Math.max(opts.days ?? 1, 1), 14);

  const result: DayAvailability[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysStr(start, i);
    if (date > lastDay) break;
    const weekday = weekdayOfDateStr(date);
    const ranges = hours[weekday] ?? [];
    const dayStart = zonedToUtc(date, '00:00', tz);
    const dayEnd = zonedToUtc(addDaysStr(date, 1), '00:00', tz);
    const existing = ranges.length ? await confirmedBetween(ws.id, dayStart, dayEnd, opts.excludeBookingId) : [];
    const slots: string[] = [];
    for (const r of ranges) {
      for (let m = timeToMinutes(r.open); m + duration <= timeToMinutes(r.close); m += step) {
        const slotStart = zonedToUtc(date, minutesToTime(m), tz);
        if (slotStart.getTime() < earliest) continue;
        const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
        const overlapping = existing.filter((b) => b.startAt < slotEnd && b.endAt > slotStart).length;
        if (overlapping < capacity) slots.push(minutesToTime(m));
      }
    }
    result.push({ date, weekday, slots });
  }
  return result;
}

function stageAfterBooking(ws: Workspace, current: LeadStage): LeadStage {
  if (current === 'won') return current;
  return ['agency', 'real_estate', 'education'].includes(ws.businessType) ? 'qualified' : 'won';
}

export async function createBooking(
  ws: Workspace,
  ctx: { contact: Contact; conversationId: string | null; isTest: boolean },
  input: { serviceId?: string; date: string; time: string; customerName: string; phone: string; notes?: string },
): Promise<Booking> {
  if (!ws.booking.enabled) throw new ToolError('Online booking is turned off for this business.');
  const service = input.serviceId ? await getItem(ws.id, input.serviceId) : null;
  if (input.serviceId && !service) throw new ToolError('Unknown service_id. Use search_catalog to find the service.');
  const [day] = await getAvailability(ws, { serviceId: input.serviceId, date: input.date, days: 1 });
  if (!day || day.date !== input.date) throw new ToolError(`${input.date} is not bookable (past date or too far ahead).`);
  if (!day.slots.includes(input.time)) {
    throw new ToolError(
      day.slots.length
        ? `${input.time} on ${input.date} is not available. Free times that day: ${day.slots.slice(0, 12).join(', ')}.`
        : `No free times on ${input.date}. Offer another day.`,
    );
  }
  const duration = durationFor(ws, service);
  const startAt = zonedToUtc(input.date, input.time, ws.timezone);
  const endAt = new Date(startAt.getTime() + duration * 60_000);
  const number = await nextBookingNumber(ws.id);
  const [booking] = await db
    .insert(bookings)
    .values({
      workspaceId: ws.id,
      number,
      contactId: ctx.contact.id,
      conversationId: ctx.conversationId,
      serviceId: service?.id ?? null,
      serviceName: service?.name ?? 'Appointment',
      startAt,
      endAt,
      customerName: input.customerName.trim(),
      phone: input.phone.trim(),
      notes: input.notes?.trim() || null,
      isTest: ctx.isTest,
    })
    .returning();
  await db
    .update(contacts)
    .set({
      name: ctx.contact.name || input.customerName.trim(),
      phone: input.phone.trim(),
      stage: stageAfterBooking(ws, ctx.contact.stage),
    })
    .where(eq(contacts.id, ctx.contact.id));
  await logEvent(ws.id, 'booking_created', {
    contactId: ctx.contact.id,
    conversationId: ctx.conversationId,
    data: { bookingId: booking.id, number, service: booking.serviceName, startAt: startAt.toISOString(), test: ctx.isTest },
  });
  if (!ctx.isTest) {
    await notify(ws, {
      type: 'booking',
      title: `New booking: ${booking.serviceName}`,
      body: `${booking.customerName} · ${booking.phone}\n${formatLocal(startAt, ws.timezone)} (${duration} min)${booking.notes ? `\nNotes: ${booking.notes}` : ''}`,
      link: `/bookings?id=${booking.id}`,
      alert: 'newBooking',
    });
  }
  return booking;
}

export async function findContactBooking(ws: Workspace, contact: Contact, number: number): Promise<Booking> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.workspaceId, ws.id), eq(bookings.number, number), eq(bookings.contactId, contact.id)))
    .limit(1);
  if (!booking) throw new ToolError(`No booking #${number} found for this customer.`);
  return booking;
}

export async function cancelBooking(ws: Workspace, contact: Contact, number: number, conversationId: string | null): Promise<Booking> {
  const booking = await findContactBooking(ws, contact, number);
  if (booking.status !== 'confirmed') throw new ToolError(`Booking #${number} is already ${booking.status}.`);
  const [updated] = await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id)).returning();
  await logEvent(ws.id, 'booking_changed', { contactId: contact.id, conversationId, data: { number, action: 'cancelled' } });
  if (!contact.isTest) {
    await notify(ws, {
      type: 'booking',
      title: `Booking #${number} cancelled by customer`,
      body: `${booking.customerName} · ${booking.serviceName} · ${formatLocal(booking.startAt, ws.timezone)}`,
      link: `/bookings?id=${booking.id}`,
      alert: 'newBooking',
    });
  }
  return updated;
}

export async function rescheduleBooking(
  ws: Workspace,
  contact: Contact,
  number: number,
  date: string,
  time: string,
  conversationId: string | null,
): Promise<Booking> {
  const booking = await findContactBooking(ws, contact, number);
  if (booking.status !== 'confirmed') throw new ToolError(`Booking #${number} is ${booking.status} and cannot be moved.`);
  const [day] = await getAvailability(ws, { serviceId: booking.serviceId ?? undefined, date, days: 1, excludeBookingId: booking.id });
  if (!day || day.date !== date || !day.slots.includes(time)) {
    throw new ToolError(
      day?.slots.length ? `${time} is not free on ${date}. Free times: ${day.slots.slice(0, 12).join(', ')}.` : `No free times on ${date}.`,
    );
  }
  const duration = booking.endAt.getTime() - booking.startAt.getTime();
  const startAt = zonedToUtc(date, time, ws.timezone);
  const [updated] = await db
    .update(bookings)
    .set({ startAt, endAt: new Date(startAt.getTime() + duration) })
    .where(eq(bookings.id, booking.id))
    .returning();
  await logEvent(ws.id, 'booking_changed', { contactId: contact.id, conversationId, data: { number, action: 'rescheduled', startAt: startAt.toISOString() } });
  if (!contact.isTest) {
    await notify(ws, {
      type: 'booking',
      title: `Booking #${number} rescheduled`,
      body: `${booking.customerName} · ${booking.serviceName}\nNew time: ${formatLocal(startAt, ws.timezone)}`,
      link: `/bookings?id=${booking.id}`,
      alert: 'newBooking',
    });
  }
  return updated;
}

export async function upcomingBookingsForContact(workspaceId: string, contactId: string): Promise<Booking[]> {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.contactId, contactId),
        eq(bookings.status, 'confirmed'),
        gte(bookings.startAt, new Date()),
      ),
    )
    .orderBy(asc(bookings.startAt))
    .limit(5);
}
