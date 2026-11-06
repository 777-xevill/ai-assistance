import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import type { Message } from '../db/schema.ts';
import { readMedia } from '../lib/storage.ts';
import { upcomingBookingsForContact } from '../services/bookings.ts';
import { loadHistory, type Bundle } from '../services/conversations.ts';
import { ordersForContact } from '../services/orders.ts';
import { emptyUsage, type TokenUsage } from '../services/usage.ts';
import type { Attachment } from '../types.ts';
import { addUsage, createMessage, endUserId, FALLBACK_BETA, supportsMidConversationSystem } from './client.ts';
import { buildTurnContext, getSystemPrompt } from './prompt.ts';
import { buildTools, runTool, type ToolContext } from './tools.ts';

type Param = Anthropic.Beta.BetaMessageParam;
type UserBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock;

const MAX_ITERATIONS = 8;
const MAX_NEW_IMAGES = 6;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface AgentResult {
  /** Final reply text (may contain blank-line separated chat bubbles). */
  text: string;
  photos: { url: string; caption?: string }[];
  toolCalls: { name: string; input: unknown; isError?: boolean }[];
  sideEffects: boolean;
  handoff: boolean;
  noReply: boolean;
  refused: boolean;
  usage: TokenUsage;
  stopReason: string | null;
  /** Time of the newest customer message the reply is based on. */
  basedOnInboundAt: Date | null;
}

export interface AgentOptions {
  mode: 'reply' | 'followup';
  /** Extra operator note for this turn (e.g. follow-up instructions). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Chat history → Claude messages
// ---------------------------------------------------------------------------

async function attachmentBlocks(a: Attachment, isNew: boolean, budget: { images: number }): Promise<UserBlock[]> {
  switch (a.kind) {
    case 'image': {
      if (isNew && a.status === 'ready' && a.url && budget.images > 0) {
        const data = await readMedia(a.url);
        const mime = (a.mime ?? 'image/jpeg').split(';')[0];
        if (data && data.length < 4_500_000 && IMAGE_TYPES.has(mime)) {
          budget.images--;
          return [
            { type: 'text', text: a.name === 'share' ? '(Customer shared a post:)' : '(Customer sent a photo:)' },
            { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: data.toString('base64') } },
          ];
        }
      }
      if (a.status === 'failed' || a.status === 'pending') return [{ type: 'text', text: '(Customer sent a photo that could not be loaded.)' }];
      return [{ type: 'text', text: `(Customer sent a photo${a.description ? `: ${a.description}` : ''})` }];
    }
    case 'sticker':
      return [{ type: 'text', text: '(Sent a sticker)' }];
    case 'audio':
      return [
        {
          type: 'text',
          text: a.transcript
            ? `(Voice message) ${a.transcript}`
            : '(Customer sent a voice message that could not be transcribed. Kindly ask them to type their question.)',
        },
      ];
    case 'video':
      return [{ type: 'text', text: '(Customer sent a video, which you cannot watch. Ask what they would like to know about it.)' }];
    case 'location': {
      const l = a.location;
      return [{ type: 'text', text: `(Shared a location: ${[l?.name, l?.address, l ? `${l.lat},${l.lng}` : ''].filter(Boolean).join(', ')})` }];
    }
    case 'file': {
      if (isNew && a.status === 'ready' && a.url && a.mime === 'application/pdf') {
        const data = await readMedia(a.url);
        if (data && data.length < 10_000_000) {
          return [
            { type: 'text', text: `(Customer sent a PDF${a.name ? ` "${a.name}"` : ''}:)` },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
          ];
        }
      }
      return [{ type: 'text', text: `(Customer sent a file${a.name ? ` "${a.name}"` : ''})` }];
    }
  }
}

function outboundText(m: Message): string {
  const parts: string[] = [];
  for (const a of m.attachments) {
    if (a.kind === 'image') parts.push(`(Sent a photo${a.description ? ` of ${a.description}` : ''})`);
    else parts.push(`(Sent a ${a.kind})`);
  }
  if (m.text) parts.push(m.text);
  return parts.join('\n') || '(sent an attachment)';
}

async function toClaudeMessages(history: Message[]): Promise<{ messages: Param[]; newestInboundAt: Date | null }> {
  let lastOut = -1;
  history.forEach((m, i) => {
    if (m.direction === 'out') lastOut = i;
  });
  const budget = { images: MAX_NEW_IMAGES };
  const messages: Param[] = [];
  let newestInboundAt: Date | null = null;

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.sender === 'system') continue;
    if (m.direction === 'in') {
      newestInboundAt = m.createdAt;
      const isNew = i > lastOut;
      const blocks: UserBlock[] = [];
      for (const a of m.attachments) blocks.push(...(await attachmentBlocks(a, isNew, budget)));
      if (m.text?.trim()) blocks.push({ type: 'text', text: m.text.trim() });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(empty message)' });
      const prev = messages[messages.length - 1];
      if (prev?.role === 'user' && Array.isArray(prev.content)) (prev.content as UserBlock[]).push(...blocks);
      else messages.push({ role: 'user', content: blocks });
    } else {
      const text = outboundText(m);
      const prev = messages[messages.length - 1];
      if (prev?.role === 'assistant' && typeof prev.content === 'string') prev.content = `${prev.content}\n\n${text}`;
      else messages.push({ role: 'assistant', content: text });
    }
  }
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: '(Earlier messages are not shown.)' });
  return { messages, newestInboundAt };
}

function lastUserMessage(messages: Param[]): Anthropic.Beta.BetaUserMessageParam | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m;
  }
  return null;
}

/** Marks the end of the conversation so far as a cache read point for the next turn. */
function markHistoryBreakpoint(messages: Param[]): void {
  const last = lastUserMessage(messages);
  if (!last) return;
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  const blocks = last.content as Array<{ cache_control?: Anthropic.Beta.BetaCacheControlEphemeral | null }>;
  const tail = blocks[blocks.length - 1];
  if (tail) tail.cache_control = { type: 'ephemeral' };
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgent(bundle: Bundle, opts: AgentOptions = { mode: 'reply' }): Promise<AgentResult> {
  const { workspace: ws, conversation, contact } = bundle;
  const model = config.ai.model;
  const usage = emptyUsage(model);
  const history = await loadHistory(conversation, 50);
  const { messages, newestInboundAt } = await toClaudeMessages(history);

  const ctx: ToolContext = {
    ws,
    bundle: { ...bundle },
    state: { photos: [], sideEffects: false, handoff: false, viewed: new Set() },
  };
  const result: AgentResult = {
    text: '',
    photos: ctx.state.photos,
    toolCalls: [],
    sideEffects: false,
    handoff: false,
    noReply: false,
    refused: false,
    usage,
    stopReason: null,
    basedOnInboundAt: newestInboundAt,
  };

  if (config.ai.mock) return mockReply(history, result);

  if (opts.mode === 'followup' || messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: '(No new message from the customer.)' });
  }
  markHistoryBreakpoint(messages);

  const [prompt, orders, bookings] = await Promise.all([
    getSystemPrompt(ws),
    ws.commerce.ordersEnabled ? ordersForContact(ws.id, contact.id, 3) : Promise.resolve([]),
    ws.booking.enabled ? upcomingBookingsForContact(ws.id, contact.id) : Promise.resolve([]),
  ]);
  const tools = buildTools(ws, { faqOverflow: prompt.faqOverflow });
  const turnContext = buildTurnContext(bundle, {
    orders,
    bookings,
    firstContact: !history.some((m) => m.direction === 'out'),
    note: opts.note,
  });
  if (supportsMidConversationSystem(model)) {
    // Operator context goes after the history so the cached prefix stays byte-identical.
    messages.push({ role: 'system', content: turnContext });
  } else {
    const last = lastUserMessage(messages)!;
    (last.content as UserBlock[]).push({ type: 'text', text: turnContext });
  }

  const texts: string[] = [];
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const finalRound = i === MAX_ITERATIONS - 1;
    const response = await createMessage({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: config.ai.effort },
      system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
      tools,
      ...(finalRound ? { tool_choice: { type: 'none' as const } } : {}),
      messages,
      cache_control: { type: 'ephemeral' },
      metadata: { user_id: endUserId(contact.id) },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
    addUsage(usage, response);
    result.stopReason = response.stop_reason;

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim());
    }
    if (response.stop_reason === 'refusal') {
      result.refused = true;
      break;
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    // A tool input cut off by max_tokens may parse as a valid partial object: never run it.
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const { result: toolResult, isError } = await runTool(call, ctx);
      results.push(toolResult);
      result.toolCalls.push({ name: call.name, input: call.input, ...(isError ? { isError } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  result.sideEffects = ctx.state.sideEffects;
  result.handoff = ctx.state.handoff;
  const raw = texts.join('\n\n').trim();
  if (result.refused && !raw) {
    result.text = 'Thanks for your message! A member of our team will get back to you shortly.';
  } else if (/^\[\[NO_REPLY\]\]$/.test(raw) || (!raw && ctx.state.photos.length === 0)) {
    result.noReply = true;
  } else {
    result.text = raw.replace(/\[\[NO_REPLY\]\]/g, '').trim();
  }
  return result;
}

/** Splits a reply into chat bubbles on blank lines (at most `max`). */
export function toBubbles(text: string, max = 3): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= max) return parts;
  // Keep lists together: merge the overflow into the last bubble.
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')];
}

function mockReply(history: Message[], result: AgentResult): AgentResult {
  const last = [...history].reverse().find((m) => m.direction === 'in');
  const said = last?.text?.trim() || last?.attachments.map((a) => a.transcript ?? `[${a.kind}]`).join(' ') || 'your message';
  result.text = `Thanks for reaching out! (AI mock mode is on.)\n\nYou said: "${said.slice(0, 200)}"`;
  return result;
}
