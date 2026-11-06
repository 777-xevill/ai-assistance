import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { aiRuns, usage, workspaces, type Workspace } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { getPlan } from '../lib/plans.ts';
import { monthKey } from '../lib/time.ts';
import { notify } from './notify.ts';

// USD per million tokens, for cost tracking. Cache writes use the 5-minute TTL price.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(model: string): TokenUsage {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function costOf(u: TokenUsage): number {
  const key = Object.keys(PRICES).find((k) => u.model === k || u.model.startsWith(`${k}-`));
  // Non-Claude models (Groq's free tier) are tracked at $0. Add them to PRICES if you move to a paid plan.
  if (!key && !u.model.startsWith('claude-')) return 0;
  const p = PRICES[key ?? 'claude-opus-5-5'];
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

export async function recordAiRun(
  workspaceId: string,
  run: {
    kind: 'reply' | 'followup' | 'vision' | 'report' | 'import' | 'summary';
    conversationId?: string | null;
    usage: TokenUsage;
    durationMs: number;
    toolCalls?: { name: string; input: unknown; isError?: boolean }[];
    stopReason?: string | null;
    error?: string | null;
    countsAsReply?: boolean;
  },
): Promise<void> {
  const cost = costOf(run.usage);
  try {
    await db.insert(aiRuns).values({
      workspaceId,
      conversationId: run.conversationId ?? null,
      kind: run.kind,
      model: run.usage.model,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      cacheReadTokens: run.usage.cacheReadTokens,
      cacheWriteTokens: run.usage.cacheWriteTokens,
      costUsd: cost,
      durationMs: run.durationMs,
      toolCalls: run.toolCalls ?? [],
      stopReason: run.stopReason ?? null,
      error: run.error ?? null,
    });
    const replies = run.countsAsReply ? 1 : 0;
    await db
      .insert(usage)
      .values({
        workspaceId,
        month: monthKey(),
        aiReplies: replies,
        aiRuns: 1,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cacheReadTokens: run.usage.cacheReadTokens,
        cacheWriteTokens: run.usage.cacheWriteTokens,
        costUsd: cost,
      })
      .onConflictDoUpdate({
        target: [usage.workspaceId, usage.month],
        set: {
          aiReplies: sql`${usage.aiReplies} + ${replies}`,
          aiRuns: sql`${usage.aiRuns} + 1`,
          inputTokens: sql`${usage.inputTokens} + ${run.usage.inputTokens}`,
          outputTokens: sql`${usage.outputTokens} + ${run.usage.outputTokens}`,
          cacheReadTokens: sql`${usage.cacheReadTokens} + ${run.usage.cacheReadTokens}`,
          cacheWriteTokens: sql`${usage.cacheWriteTokens} + ${run.usage.cacheWriteTokens}`,
          costUsd: sql`${usage.costUsd} + ${cost}`,
        },
      });
  } catch (err) {
    logger.warn('Could not record AI usage', { err });
  }
}

export async function recordTranscription(workspaceId: string, seconds: number): Promise<void> {
  await db
    .insert(usage)
    .values({ workspaceId, month: monthKey(), transcribedSeconds: Math.round(seconds) })
    .onConflictDoUpdate({
      target: [usage.workspaceId, usage.month],
      set: { transcribedSeconds: sql`${usage.transcribedSeconds} + ${Math.round(seconds)}` },
    })
    .catch((err) => logger.warn('Could not record transcription usage', { err }));
}

export async function getMonthUsage(workspaceId: string, month = monthKey()) {
  const [row] = await db
    .select()
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), eq(usage.month, month)))
    .limit(1);
  return (
    row ?? {
      workspaceId,
      month,
      aiReplies: 0,
      aiRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      transcribedSeconds: 0,
    }
  );
}

/** Whether the workspace may use AI right now (status, trial, monthly limit). */
export async function checkAiAllowed(ws: Workspace): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (ws.status !== 'active') return { ok: false, reason: 'This workspace is suspended.' };
  if (ws.plan === 'trial' && ws.trialEndsAt && ws.trialEndsAt.getTime() < Date.now()) {
    return { ok: false, reason: 'The free trial has ended. Choose a plan to keep the AI assistant running.' };
  }
  const plan = getPlan(ws.plan);
  const used = await getMonthUsage(ws.id);
  if (used.aiReplies >= plan.aiRepliesPerMonth) {
    const month = monthKey();
    if (ws.limitNotifiedMonth !== month) {
      await db.update(workspaces).set({ limitNotifiedMonth: month }).where(eq(workspaces.id, ws.id));
      await notify(ws, {
        type: 'limit',
        title: 'Monthly AI reply limit reached',
        body: `Your ${plan.name} plan includes ${plan.aiRepliesPerMonth.toLocaleString()} AI replies per month. New messages will wait for your team until you upgrade or the month resets.`,
        link: '/settings?tab=billing',
        email: true,
      });
    }
    return { ok: false, reason: 'Monthly AI reply limit reached.' };
  }
  return { ok: true };
}
