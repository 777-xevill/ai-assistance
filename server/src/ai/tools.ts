import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { conversations, type Workspace } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { readMedia } from '../lib/storage.ts';
import { formatLocal } from '../lib/time.ts';
import { cancelBooking, createBooking, getAvailability, rescheduleBooking } from '../services/bookings.ts';
import { formatMoney, getItem, itemForAI, searchCatalog } from '../services/catalog.ts';
import { updateContactDetails, updateLead } from '../services/contacts.ts';
import type { Bundle } from '../services/conversations.ts';
import { logEvent } from '../services/events.ts';
import { logKnowledgeGap, searchKnowledge } from '../services/knowledge.ts';
import { notify } from '../services/notify.ts';
import { createOrder, ordersForContact, quoteOrder, requestOrderChange, ToolError } from '../services/orders.ts';

export interface ToolState {
  /** Product photos to send after the text reply. */
  photos: { url: string; caption?: string }[];
  /** True once something irreversible happened (order, booking, handoff...). */
  sideEffects: boolean;
  handoff: boolean;
  viewed: Set<string>;
}

export interface ToolContext {
  ws: Workspace;
  bundle: Bundle;
  state: ToolState;
}

type ToolOutput = string | Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>;

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  enabled?: (ws: Workspace, opts: { faqOverflow: boolean }) => boolean;
  run: (input: any, ctx: ToolContext) => Promise<ToolOutput>;
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (v === undefined ? undefined : v));

const orderLine = z.object({
  item_id: z.string().describe('Item id from search_catalog or the catalog overview'),
  quantity: z.number().int().min(1),
  variant: z.string().optional().describe('Chosen options, e.g. "Size M, Red"'),
});

const ordersOn = (ws: Workspace) => ws.commerce.ordersEnabled;
const bookingOn = (ws: Workspace) => ws.booking.enabled;

const TOOLS: ToolDef[] = [
  {
    name: 'search_catalog',
    description:
      'Search the business catalog of products and services. Call this before answering any question about what is sold, prices, sizes or availability, and whenever a customer sends a photo of an item. Returns up to 6 matches with id, price and availability.',
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'What to look for: a name, category or need, or a visual description of a customer photo (type, color, pattern, material). Write it in the catalog language (usually English) and include synonyms.',
        ),
      type: z.enum(['product', 'service']).optional().describe('Restrict to products or services'),
      max_price: z.number().positive().optional().describe('Only items priced at or below this'),
    }),
    async run(input, { ws }) {
      const { items, exact } = await searchCatalog(ws, input.query, { type: input.type, maxPrice: input.max_price, limit: 6 });
      if (items.length === 0) return 'The catalog has no items yet. Collect the customer’s needs and contact details and offer to have the team follow up.';
      return json({
        matches: items.map((i) => itemForAI(i, ws.currency)),
        note: exact ? undefined : 'Nothing matched closely. These are other items you could suggest, or ask a clarifying question.',
      });
    },
  },
  {
    name: 'get_item_details',
    description:
      'Get full details of one product or service, including its photos, so you can confirm specifics (sizes, materials, what a service includes) or compare it with a photo the customer sent.',
    schema: z.object({ item_id: z.string().describe('Item id from search_catalog or the catalog overview') }),
    async run(input, { ws, bundle, state }) {
      const item = await getItem(ws.id, input.item_id);
      if (!item || !item.active) throw new ToolError('Unknown item_id. Use search_catalog first.');
      if (!state.viewed.has(item.id)) {
        state.viewed.add(item.id);
        await logEvent(ws.id, 'item_viewed', {
          contactId: bundle.contact.id,
          conversationId: bundle.conversation.id,
          data: { itemId: item.id, name: item.name, test: bundle.conversation.isTest },
        });
      }
      const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [
        { type: 'text', text: json(itemForAI(item, ws.currency, 'full')) },
      ];
      for (const img of item.images.slice(0, 3)) {
        const data = await readMedia(img.url);
        if (!data || data.length > 4_500_000) continue;
        blocks.push({ type: 'text', text: `Photo of ${item.name}:` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } });
      }
      return blocks;
    },
  },
  {
    name: 'send_item_photos',
    description:
      'Send photos of a product or service to the customer; they arrive right after your text message. Use when the customer asks to see it or when a photo would help them decide.',
    schema: z.object({
      item_id: z.string(),
      count: z.number().int().min(1).max(5).optional().describe('How many photos (default 2)'),
    }),
    async run(input, { ws, state }) {
      const item = await getItem(ws.id, input.item_id);
      if (!item) throw new ToolError('Unknown item_id.');
      if (!item.images.length) return `"${item.name}" has no photos. Describe it in words instead.`;
      const picks = item.images.slice(0, input.count ?? 2);
      for (const img of picks) {
        if (!state.photos.some((p) => p.url === img.url)) state.photos.push({ url: img.url, caption: item.name });
      }
      return `${picks.length} photo(s) of "${item.name}" will be sent right after your message. Don't say you can't send photos.`;
    },
  },
  {
    name: 'save_customer_details',
    description:
      'Save contact details the customer shared (name, phone, email, address, city) or a short note worth remembering (preferences, sizes, context). Call as soon as they share any of these.',
    schema: z.object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      address: z.string().optional().describe('Full address as given'),
      city: z.string().optional(),
      note: z.string().optional().describe('Something useful to remember about this customer'),
    }),
    async run(input, ctx) {
      const contact = ctx.bundle.contact;
      const notes = input.note ? [contact.notes, input.note].filter(Boolean).join('\n').slice(-2000) : undefined;
      ctx.bundle.contact = await updateContactDetails(contact.id, {
        name: input.name,
        phone: input.phone,
        email: input.email,
        address: input.address,
        city: input.city,
        notes,
      });
      return 'Saved.';
    },
  },
  {
    name: 'update_lead',
    description:
      'Update the CRM record for this customer when their intent becomes clearer: stage (interested / qualified / negotiating / lost), a 0-100 likelihood-to-buy score, what they want, budget, timeline, and answers to qualification questions.',
    schema: z.object({
      stage: z.enum(['interested', 'qualified', 'negotiating', 'lost']).optional(),
      score: z.number().min(0).max(100).optional().describe('How likely they are to buy, 0-100'),
      intent: z.string().optional().describe('What they want, in a few words'),
      budget: z.string().optional(),
      timeline: z.string().optional(),
      answers: z.record(z.string(), z.string()).optional().describe('Qualification answers: question → answer'),
      lost_reason: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Short labels, e.g. "wholesale", "repeat customer"'),
    }),
    async run(input, ctx) {
      ctx.bundle.contact = await updateLead(
        ctx.ws,
        ctx.bundle.contact,
        {
          stage: input.stage,
          score: input.score,
          tags: input.tags,
          lead: {
            ...(input.intent ? { intent: input.intent } : {}),
            ...(input.budget ? { budget: input.budget } : {}),
            ...(input.timeline ? { timeline: input.timeline } : {}),
            ...(input.answers ? { answers: input.answers } : {}),
            ...(input.lost_reason ? { lostReason: input.lost_reason } : {}),
          },
        },
        ctx.bundle.conversation.id,
      );
      return 'Lead updated.';
    },
  },
  {
    name: 'log_unanswered_question',
    description:
      "Record a customer question you couldn't answer from the business information, so the owner can add the answer. Call it whenever you have to say you'll check with the team.",
    schema: z.object({ question: z.string().min(3).describe('The question, phrased generally (no personal details)') }),
    async run(input, { ws, bundle }) {
      if (!bundle.conversation.isTest) await logKnowledgeGap(ws, input.question, bundle.conversation.id);
      return 'Logged for the team.';
    },
  },
  {
    name: 'request_human',
    description:
      'Hand the conversation to a human team member and notify them. Use when the customer asks for a person, is upset, has a complaint, refund, damaged/wrong item or payment problem, needs a custom quote, or anything you cannot resolve.',
    schema: z.object({
      reason: z.string().describe('Short reason, e.g. "refund request"'),
      summary: z.string().describe('One or two sentences for the team: who the customer is and what they need'),
      urgency: z.enum(['normal', 'urgent']).optional(),
    }),
    async run(input, { ws, bundle, state }) {
      const conv = bundle.conversation;
      const pauseMin = ws.ai.pauseAfterHandoffMinutes || 180;
      await db
        .update(conversations)
        .set({
          needsHuman: true,
          handoffReason: input.reason.slice(0, 200),
          aiPaused: true,
          aiPausedUntil: new Date(Date.now() + pauseMin * 60_000),
        })
        .where(eq(conversations.id, conv.id));
      state.handoff = true;
      state.sideEffects = true;
      await logEvent(ws.id, 'handoff', {
        contactId: bundle.contact.id,
        conversationId: conv.id,
        data: { reason: input.reason, urgency: input.urgency ?? 'normal', test: conv.isTest },
      });
      if (!conv.isTest) {
        await notify(ws, {
          type: 'handoff',
          title: `${input.urgency === 'urgent' ? 'URGENT: ' : ''}${bundle.contact.name ?? 'A customer'} needs a team member`,
          body: `${input.reason}\n${input.summary}`,
          link: `/inbox?c=${conv.id}`,
          alert: 'handoff',
        });
      }
      return 'The team has been notified and you will stay quiet in this chat for a while. Tell the customer a team member will reply soon (or when the team is back, if it is outside opening hours).';
    },
  },
  {
    name: 'search_faq',
    description: 'Search the full list of frequently asked questions when the answer is not in the business information you already have.',
    schema: z.object({ query: z.string().min(2) }),
    enabled: (_ws, opts) => opts.faqOverflow,
    async run(input, { ws }) {
      const hits = await searchKnowledge(ws, input.query, 5);
      return hits.length ? json(hits.map((h) => ({ q: h.question, a: h.answer }))) : 'No matching answer.';
    },
  },
  // ---------------- Orders ----------------
  {
    name: 'quote_order',
    description:
      'Calculate the exact total for an order (items, delivery charge) and check stock and missing choices such as size. Call before showing an order summary. It does not place the order.',
    schema: z.object({
      items: z.array(orderLine).min(1),
      delivery_zone_id: z.string().optional().describe('Delivery area id from the business information'),
    }),
    enabled: ordersOn,
    async run(input, { ws }) {
      const quote = await quoteOrder(ws, {
        items: input.items.map((l: z.infer<typeof orderLine>) => ({ itemId: l.item_id, quantity: l.quantity, variant: l.variant })),
        deliveryZoneId: input.delivery_zone_id,
      });
      return json({
        summary: quote.summary,
        total: formatMoney(quote.total, ws.currency),
        issues_to_resolve_first: quote.problems.length ? quote.problems : undefined,
      });
    },
  },
  {
    name: 'create_order',
    description:
      'Place the order. Only call after the customer has seen the summary from quote_order and clearly confirmed it. Returns the order number.',
    schema: z.object({
      items: z.array(orderLine).min(1),
      delivery_zone_id: z.string().optional(),
      customer_name: z.string().min(1),
      phone: z.string().min(3),
      address: z.string().optional(),
      email: z.string().optional(),
      payment_method_id: z.string().optional(),
      notes: z.string().optional().describe('Delivery instructions or other notes'),
      extra_fields: z.record(z.string(), z.string()).optional().describe('Other order details, keyed by field key'),
    }),
    enabled: ordersOn,
    async run(input, ctx) {
      const order = await createOrder(
        ctx.ws,
        { contact: ctx.bundle.contact, conversationId: ctx.bundle.conversation.id, isTest: ctx.bundle.conversation.isTest },
        {
          items: input.items.map((l: z.infer<typeof orderLine>) => ({ itemId: l.item_id, quantity: l.quantity, variant: l.variant })),
          deliveryZoneId: input.delivery_zone_id,
          customerName: input.customer_name,
          phone: input.phone,
          address: input.address,
          email: input.email,
          paymentMethodId: input.payment_method_id,
          notes: input.notes,
          extra: input.extra_fields,
        },
      );
      ctx.state.sideEffects = true;
      ctx.bundle.contact = { ...ctx.bundle.contact, stage: 'won' };
      return json({
        order_number: order.number,
        total: formatMoney(order.total, ctx.ws.currency),
        payment: order.paymentMethod ?? undefined,
        next_steps: ctx.ws.commerce.afterOrderMessage || 'The team will process the order and keep the customer updated.',
      });
    },
  },
  {
    name: 'get_my_orders',
    description: "Look up this customer's recent orders and their status (for questions like \"where is my order?\").",
    schema: z.object({}),
    enabled: ordersOn,
    async run(_input, { ws, bundle }) {
      const list = await ordersForContact(ws.id, bundle.contact.id, 5);
      if (!list.length) return 'This customer has no orders on record in this chat.';
      return json(
        list.map((o) => ({
          number: o.number,
          status: o.status,
          total: formatMoney(o.total, o.currency),
          items: o.items.map((i) => `${i.quantity} × ${i.name}${i.variant ? ` (${i.variant})` : ''}`),
          placed: formatLocal(o.createdAt, ws.timezone),
          pending_change_request: o.changeRequest ?? undefined,
        })),
      );
    },
  },
  {
    name: 'request_order_change',
    description: 'Pass a change or cancellation request for one of the customer’s orders to the team. The team confirms it; do not promise it is done.',
    schema: z.object({
      order_number: z.number().int(),
      request: z.string().describe('What the customer wants changed, e.g. "cancel", "change size to L", "new address: …"'),
    }),
    enabled: ordersOn,
    async run(input, ctx) {
      await requestOrderChange(ctx.ws, ctx.bundle.contact, input.order_number, input.request, ctx.bundle.conversation.id);
      ctx.state.sideEffects = true;
      return 'Request passed to the team. Tell the customer the team will confirm the change shortly.';
    },
  },
  // ---------------- Bookings ----------------
  {
    name: 'check_availability',
    description:
      'Get free appointment times (business local time) for one or more days. Always call before suggesting or confirming a time.',
    schema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('First day to check, YYYY-MM-DD in the business timezone. Defaults to today.'),
      days: z.number().int().min(1).max(7).optional().describe('How many days to check (default 1)'),
      service_id: z.string().optional().describe('Service id, so the right duration is used'),
    }),
    enabled: bookingOn,
    async run(input, { ws }) {
      const days = await getAvailability(ws, { serviceId: input.service_id, date: input.date, days: input.days ?? 1 });
      if (!days.length) return 'That date is outside the booking window.';
      return json(days.map((d) => ({ date: d.date, weekday: d.weekday, free_times: d.slots.length ? d.slots : 'fully booked or closed' })));
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book an appointment at a free time returned by check_availability, after confirming the service, date, time, name and phone with the customer.',
    schema: z.object({
      service_id: z.string().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time: z.string().regex(/^\d{2}:\d{2}$/).describe('24-hour local time, e.g. 15:30'),
      customer_name: z.string().min(1),
      phone: z.string().min(3),
      notes: z.string().optional(),
    }),
    enabled: bookingOn,
    async run(input, ctx) {
      const booking = await createBooking(
        ctx.ws,
        { contact: ctx.bundle.contact, conversationId: ctx.bundle.conversation.id, isTest: ctx.bundle.conversation.isTest },
        { serviceId: input.service_id, date: input.date, time: input.time, customerName: input.customer_name, phone: input.phone, notes: input.notes },
      );
      ctx.state.sideEffects = true;
      return json({
        booking_number: booking.number,
        service: booking.serviceName,
        when: formatLocal(booking.startAt, ctx.ws.timezone),
        duration_minutes: Math.round((booking.endAt.getTime() - booking.startAt.getTime()) / 60000),
      });
    },
  },
  {
    name: 'manage_booking',
    description: "Cancel or reschedule one of this customer's bookings. For rescheduling, check_availability first.",
    schema: z.object({
      booking_number: z.number().int(),
      action: z.enum(['cancel', 'reschedule']),
      new_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      new_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    enabled: bookingOn,
    async run(input, ctx) {
      const conversationId = ctx.bundle.conversation.id;
      if (input.action === 'cancel') {
        await cancelBooking(ctx.ws, ctx.bundle.contact, input.booking_number, conversationId);
        ctx.state.sideEffects = true;
        return `Booking #${input.booking_number} is cancelled.`;
      }
      if (!input.new_date || !input.new_time) throw new ToolError('new_date and new_time are required to reschedule.');
      const b = await rescheduleBooking(ctx.ws, ctx.bundle.contact, input.booking_number, input.new_date, input.new_time, conversationId);
      ctx.state.sideEffects = true;
      return `Booking #${b.number} moved to ${formatLocal(b.startAt, ctx.ws.timezone)}.`;
    },
  },
];

function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const raw = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'propertyNames') continue;
      if ((k === 'maximum' || k === 'minimum') && typeof v === 'number' && Math.abs(v) > 1e12) continue;
      out[k] = clean(v);
    }
    return out;
  };
  return clean(raw) as Anthropic.Beta.BetaTool.InputSchema;
}

const definitionCache = new Map<string, Anthropic.Beta.BetaTool>();

/** Tool definitions for a workspace. Order and content are deterministic so the prompt cache holds. */
export function buildTools(ws: Workspace, opts: { faqOverflow: boolean }): Anthropic.Beta.BetaTool[] {
  return TOOLS.filter((t) => !t.enabled || t.enabled(ws, opts)).map((t) => {
    let def = definitionCache.get(t.name);
    if (!def) {
      def = { name: t.name, description: t.description, input_schema: toInputSchema(t.schema) };
      definitionCache.set(t.name, def);
    }
    return def;
  });
}

/** Runs one tool call and returns the tool_result block for Claude. Never throws. */
export async function runTool(
  call: Anthropic.Beta.BetaToolUseBlock,
  ctx: ToolContext,
): Promise<{ result: Anthropic.Beta.BetaToolResultBlockParam; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === call.name);
  const fail = (message: string) => ({
    result: { type: 'tool_result' as const, tool_use_id: call.id, is_error: true, content: message },
    isError: true,
  });
  if (!tool) return fail(`Unknown tool "${call.name}".`);
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  }
  try {
    const content = await tool.run(parsed.data, ctx);
    return { result: { type: 'tool_result', tool_use_id: call.id, content }, isError: false };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    logger.error(`Tool ${call.name} failed`, { err });
    return fail('Something went wrong on our side while doing that. Apologise briefly and offer to have the team follow up.');
  }
}
