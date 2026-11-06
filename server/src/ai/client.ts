import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { emptyUsage, type TokenUsage } from '../services/usage.ts';
import { groqCreate } from './groq.ts';

let client: Anthropic | null = null;

/** Shared Anthropic client. Credentials come from ANTHROPIC_API_KEY (or the SDK's other sources). */
export function anthropic(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3, timeout: 120_000 });
  return client;
}

export function aiConfigured(): boolean {
  if (config.ai.mock) return true;
  if (config.ai.provider === 'groq') return Boolean(config.ai.groq.apiKey);
  return Boolean(config.ai.apiKey || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Server-side refusal fallback: if the model declines for policy reasons, the API re-runs the
 * request on Anthropic's recommended fallback model. On models without fallback support the
 * "default" form is a no-op, so it is safe to send everywhere.
 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models that accept `role: "system"` entries inside `messages` (operator context per turn). */
export function supportsMidConversationSystem(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|opus-4-8|fable-5|mythos-5|sonnet-5-5|haiku-5-5)(\b|-)/.test(model);
}

export function addUsage(total: TokenUsage, response: Anthropic.Beta.BetaMessage): void {
  const u = response.usage;
  total.model = response.model || total.model;
  total.inputTokens += u.input_tokens ?? 0;
  total.outputTokens += u.output_tokens ?? 0;
  total.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
}

/**
 * One entry point for every model call. Requests are written in Claude's format; with
 * AI_PROVIDER=groq they are translated to Groq and the reply is translated back.
 */
export function createMessage(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> {
  if (config.ai.provider === 'groq') return groqCreate(params);
  return anthropic().beta.messages.create(params);
}

export { emptyUsage };

/** Stable, non-identifying id for Anthropic's abuse monitoring (metadata.user_id). */
export function endUserId(id: string): string {
  return crypto.createHash('sha256').update(`user:${id}`).digest('hex').slice(0, 32);
}

/** Extracts the concatenated text of a response. */
export function responseText(response: Anthropic.Beta.BetaMessage): string {
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** A single-shot request with the project's defaults (adaptive thinking, effort, fallback). */
export async function complete(params: {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  userId?: string;
}): Promise<{ text: string; response: Anthropic.Beta.BetaMessage; usage: TokenUsage }> {
  const model = params.model ?? config.ai.backgroundModel;
  const response = await createMessage({
    model,
    max_tokens: params.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: params.effort ?? 'low' },
    system: [{ type: 'text', text: params.system }],
    messages: params.messages,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    ...(params.userId ? { metadata: { user_id: endUserId(params.userId) } } : {}),
  });
  const usage = emptyUsage(model);
  addUsage(usage, response);
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  return { text: responseText(response), response, usage };
}
