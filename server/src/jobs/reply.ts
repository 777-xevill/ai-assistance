import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq } from 'drizzle-orm';
import { runAgent, toBubbles, type AgentResult } from '../ai/agent.ts';
import { maybeSummarize } from '../ai/summarize.ts';
import { adapterFor } from '../channels/index.ts';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { conversations, messages, type Message } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { formatForChannel, splitForChannel } from '../lib/text.ts';
import { enqueue, PermanentJobError } from '../queue/index.ts';
import { acquireLock, getBundle, isAiPaused, newerInboundExists, releaseLock, type Bundle } from '../services/conversations.ts';
import { logEvent } from '../services/events.ts';
import { scheduleReply } from '../services/inbound.ts';
import { processMessageMedia } from '../services/media.ts';
import { notify } from '../services/notify.ts';
import { sendOutbound } from '../services/outbound.ts';
import { checkAiAllowed, recordAiRun } from '../services/usage.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function latestMessage(conversationId: string): Promise<Message | null> {
  const [m] = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m ?? null;
}

/** Why the AI should (not) answer this conversation right now. */
export async function replyBlocker(bundle: Bundle, mode: 'reply' | 'followup'): Promise<string | null> {
  const { workspace: ws, channel, conversation } = bundle;
  if (!ws.ai.enabled) return 'AI assistant is turned off for this business.';
  if (!channel.aiEnabled) return 'AI is turned off for this channel.';
  if (channel.status !== 'active') return 'Channel is not active.';
  if (isAiPaused(conversation)) return 'AI is paused for this conversation.';
  const allowed = await checkAiAllowed(ws);
  if (!allowed.ok) return allowed.reason;
  const can = adapterFor(channel.type).canSend?.(conversation, 'ai');
  if (can && !can.ok) return can.reason;
  const last = await latestMessage(conversation.id);
  if (mode === 'reply' && last?.direction !== 'in') return 'Nothing new to answer.';
  if (mode === 'followup' && last?.direction !== 'out') return 'Customer already replied.';
  return null;
}

/** Sends the agent's reply with human-like pacing. */
export async function deliver(bundle: Bundle, result: AgentResult): Promise<void> {
  const { channel, contact, workspace: ws } = bundle;
  const adapter = adapterFor(channel.type);
  const paced = config.typingDelay && channel.type !== 'playground';
  const bubbles = result.text ? toBubbles(result.text) : [];
  let first = true;
  for (const bubble of bubbles) {
    for (const chunk of splitForChannel(formatForChannel(bubble, channel.type), adapter.maxTextLength)) {
      if (paced) {
        if (first) {
          const since = result.basedOnInboundAt ? Date.now() - result.basedOnInboundAt.getTime() : 0;
          await sleep(Math.max(0, (ws.ai.replyDelaySeconds ?? 0) * 1000 - since));
        } else {
          await adapter.typing?.(channel, contact).catch(() => {});
          await sleep(Math.min(3500, 700 + chunk.length * 18));
        }
      }
      first = false;
      await sendOutbound(bundle, { text: chunk, sender: 'ai' });
    }
  }
  for (const photo of result.photos.slice(0, 6)) {
    await sendOutbound(bundle, { imageUrl: photo.url, caption: photo.caption, sender: 'ai' });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runAndRecord(bundle: Bundle, mode: 'reply' | 'followup', note?: string): Promise<AgentResult> {
  const started = Date.now();
  try {
    const result = await runAgent(bundle, { mode, note });
    await recordAiRun(bundle.workspace.id, {
      kind: mode,
      conversationId: bundle.conversation.id,
      usage: result.usage,
      durationMs: Date.now() - started,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      countsAsReply: !result.noReply,
    });
    return result;
  } catch (err) {
    await recordAiRun(bundle.workspace.id, {
      kind: mode,
      conversationId: bundle.conversation.id,
      usage: { model: config.ai.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: Date.now() - started,
      error: errorMessage(err).slice(0, 500),
    });
    // Bad requests and auth problems won't fix themselves by retrying.
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new PermanentJobError(errorMessage(err));
    }
    throw err;
  }
}

async function scheduleFollowup(bundle: Bundle, result: AgentResult): Promise<void> {
  const { workspace: ws, contact, conversation, channel } = bundle;
  const f = ws.ai.followUp;
  if (!f?.enabled || result.handoff || channel.type === 'playground') return;
  if (!['interested', 'qualified', 'negotiating'].includes(contact.stage) && result.toolCalls.every((t) => t.name !== 'quote_order')) return;
  const step = conversation.followupStep + 1;
  const minutes = step === 1 ? f.firstAfterMinutes : step === 2 ? f.secondAfterMinutes : 0;
  if (!minutes || minutes <= 0) return;
  await enqueue('conversation.followup', { conversationId: conversation.id, step }, {
    runAt: new Date(Date.now() + minutes * 60_000),
    uniqueKey: `followup:${conversation.id}`,
    maxAttempts: 2,
  });
}

export async function handleReplyJob({ conversationId }: { conversationId: string }): Promise<void> {
  let bundle = await getBundle(conversationId);
  if (!bundle) return;
  const blocker = await replyBlocker(bundle, 'reply');
  if (blocker) {
    logger.debug(`No AI reply for ${conversationId}: ${blocker}`);
    return;
  }
  if (!(await acquireLock(conversationId))) {
    await scheduleReply(conversationId, 2500);
    return;
  }
  try {
    // Make sure photos and voice notes are downloaded and transcribed first.
    const pending = await db
      .select({ id: messages.id, attachments: messages.attachments })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in')))
      .orderBy(desc(messages.createdAt))
      .limit(10);
    await Promise.all(pending.filter((m) => m.attachments.some((a) => a.status === 'pending')).map((m) => processMessageMedia(m.id)));

    bundle = (await getBundle(conversationId))!;
    const adapter = adapterFor(bundle.channel.type);
    const lastIn = await db
      .select({ externalId: messages.externalId })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in')))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    await adapter.typing?.(bundle.channel, bundle.contact, lastIn[0]?.externalId).catch(() => {});

    const result = await runAndRecord(bundle, 'reply');

    // The customer kept typing while we were thinking: let the queued reply answer everything at once.
    if (!result.sideEffects && result.basedOnInboundAt && (await newerInboundExists(conversationId, result.basedOnInboundAt))) {
      return;
    }
    if (result.refused) {
      await db.update(conversations).set({ needsHuman: true, handoffReason: 'AI could not answer' }).where(eq(conversations.id, conversationId));
      if (!bundle.conversation.isTest) {
        await notify(bundle.workspace, {
          type: 'handoff',
          title: `${bundle.contact.name ?? 'A customer'} needs a team member`,
          body: 'The AI assistant could not answer this conversation.',
          link: `/inbox?c=${conversationId}`,
          alert: 'handoff',
        });
      }
    }
    if (!result.noReply) await deliver(bundle, result);
    const fresh = (await getBundle(conversationId))!;
    await scheduleFollowup(fresh, result);
    await enqueue('conversation.describe_images', { conversationId }, { uniqueKey: `describe:${conversationId}`, delayMs: 2000, maxAttempts: 2 });
    await enqueue('conversation.summarize', { conversationId }, { uniqueKey: `summarize:${conversationId}`, delayMs: 5000, maxAttempts: 2 });
  } finally {
    await releaseLock(conversationId);
  }
}

export async function handleFollowupJob({ conversationId, step }: { conversationId: string; step: number }): Promise<void> {
  const bundle = await getBundle(conversationId);
  if (!bundle) return;
  const { conversation, contact, workspace: ws } = bundle;
  if (conversation.followupStep >= step || conversation.needsHuman) return;
  if (['won', 'lost'].includes(contact.stage)) return;
  if (await replyBlocker(bundle, 'followup')) return;
  if (!(await acquireLock(conversationId))) return;
  try {
    const silentFor = conversation.lastInboundAt ? Math.round((Date.now() - conversation.lastInboundAt.getTime()) / 60_000) : null;
    const note = `Follow-up check: the customer has not replied${silentFor ? ` for about ${silentFor >= 120 ? `${Math.round(silentFor / 60)} hours` : `${silentFor} minutes`}` : ''}. If it makes sense, send ONE short, friendly follow-up that makes it easy to continue (answer a likely question, mention a helpful detail, or ask if they'd like to go ahead). Don't repeat earlier messages, don't pressure, and don't offer discounts unless the business information allows it. If a follow-up isn't appropriate (they said they'd think about it, said goodbye, or the chat ended naturally), reply with exactly [[NO_REPLY]].`;
    const result = await runAndRecord(bundle, 'followup', note);
    await db.update(conversations).set({ followupStep: step }).where(eq(conversations.id, conversationId));
    if (result.noReply) return;
    await deliver(bundle, result);
    await logEvent(ws.id, 'followup_sent', { contactId: contact.id, conversationId, data: { step } });
    const fresh = (await getBundle(conversationId))!;
    await scheduleFollowup(fresh, result);
  } finally {
    await releaseLock(conversationId);
  }
}

export { maybeSummarize };
