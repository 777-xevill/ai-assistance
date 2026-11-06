import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { logger } from '../lib/logger.ts';

// Groq (https://console.groq.com) speaks the OpenAI chat-completions protocol. The rest of the app is
// written against Claude's message format (content blocks, tool_use / tool_result), so this adapter
// translates a Claude-style request into a Groq request and the reply back into a Claude-style message.

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

type OaiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OaiPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** The vision model accepts at most 3 images per request; older ones become text. */
const MAX_IMAGES = 3;
/** Groq rejects base64 images above 4 MB. */
const MAX_IMAGE_B64 = 4_000_000;

type AnyBlock = { type: string; [key: string]: any };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as AnyBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function toGroqMessages(params: Params): { messages: OaiMessage[]; hasImages: boolean } {
  const out: OaiMessage[] = [];
  const system = textOf(params.system);
  if (system) out.push({ role: 'system', content: system });

  // Keep only the newest images; walk backwards to decide which survive.
  const keepImage = new Set<AnyBlock>();
  let kept = 0;
  for (let i = params.messages.length - 1; i >= 0 && kept < MAX_IMAGES; i--) {
    const c = params.messages[i].content;
    if (!Array.isArray(c)) continue;
    for (let j = (c as AnyBlock[]).length - 1; j >= 0 && kept < MAX_IMAGES; j--) {
      const b = (c as AnyBlock[])[j];
      if (b.type === 'image' && b.source?.type === 'base64' && String(b.source.data).length <= MAX_IMAGE_B64) {
        keepImage.add(b);
        kept++;
      }
    }
  }

  for (const m of params.messages) {
    const role = m.role as string;
    const blocks: AnyBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as AnyBlock[]);

    if (role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id as string, type: 'function' as const, function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : '(no reply)'), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    if (role === 'system') {
      out.push({ role: 'system', content: textOf(blocks) });
      continue;
    }

    // user: tool results become `tool` messages; everything else is one user message.
    const parts: OaiPart[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const body = typeof b.content === 'string' ? b.content : textOf(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${body}` : body || 'OK' });
      } else if (b.type === 'text') {
        if (b.text) parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        if (keepImage.has(b)) parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        else parts.push({ type: 'text', text: '(an earlier photo is not shown)' });
      } else if (b.type === 'document') {
        parts.push({ type: 'text', text: '(Customer attached a PDF that you cannot read. Ask what it says.)' });
      }
    }
    if (parts.length === 0) continue;
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
  }
  return { messages: out, hasImages: kept > 0 };
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GroqResponse {
  id: string;
  model: string;
  choices: { finish_reason: string; message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** Calls Groq with a Claude-style request and returns a Claude-style message. */
export async function groqCreate(params: Params): Promise<Anthropic.Beta.BetaMessage> {
  const { messages, hasImages } = toGroqMessages(params);
  const model = hasImages ? config.ai.groq.visionModel : params.model;
  const schema = (params as { output_config?: { format?: { schema?: unknown } } }).output_config?.format?.schema;
  const effort = (params as { output_config?: { effort?: string } }).output_config?.effort;

  if (schema) {
    // JSON mode: the schema goes in the prompt, and the reply must be a JSON object.
    const first = messages[0];
    const note = `\n\nRespond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    if (first?.role === 'system') first.content += note;
    else messages.unshift({ role: 'system', content: note.trim() });
  }

  const tools = (params.tools ?? []) as { name: string; description?: string; input_schema: unknown }[];
  const body: Record<string, unknown> = {
    model,
    messages,
    max_completion_tokens: Math.min(params.max_tokens, schema ? 16_000 : 6_000),
    temperature: 0.4,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } })),
          tool_choice: (params.tool_choice as { type?: string } | undefined)?.type === 'none' ? 'none' : 'auto',
        }
      : {}),
    ...(schema ? { response_format: { type: 'json_object' } } : {}),
    ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: effort === 'low' ? 'low' : effort === 'medium' || !effort ? 'medium' : 'high' } : {}),
    ...(params.metadata?.user_id ? { user: params.metadata.user_id } : {}),
  };

  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(`${config.ai.groq.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ai.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const json = (await res.json()) as GroqResponse;
      return toClaudeMessage(json);
    }
    const detail = (await res.text().catch(() => '')).slice(0, 600);
    // Free-tier rate limits (per minute): wait the advertised time, then retry. Daily limits are not worth waiting for.
    if (res.status === 429 && attempt <= 3) {
      const headerWait = Number(res.headers.get('retry-after'));
      const bodyWait = /try again in ([\d.]+)(ms|s|m)/i.exec(detail);
      const waitMs = Number.isFinite(headerWait) && headerWait > 0 ? headerWait * 1000 : bodyWait ? Number(bodyWait[1]) * (bodyWait[2] === 'ms' ? 1 : bodyWait[2] === 's' ? 1000 : 60_000) : 3000 * attempt;
      if (waitMs <= 25_000) {
        logger.warn('Groq rate limit; retrying', { waitMs, attempt });
        await sleep(waitMs + 250);
        continue;
      }
    }
    // The model sometimes emits a malformed tool call; sampling again almost always fixes it.
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(detail) && attempt <= 3) continue;
    if (res.status >= 500 && attempt <= 2) {
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`Groq API error (HTTP ${res.status}): ${detail}`);
  }
}

function toClaudeMessage(json: GroqResponse): Anthropic.Beta.BetaMessage {
  const choice = json.choices?.[0];
  const content: AnyBlock[] = [];
  const text = stripThinking(choice?.message.content ?? '');
  if (text) content.push({ type: 'text', text });
  for (const call of choice?.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      // Leave empty: the tool's own validation reports the problem back to the model.
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const stop = hasTools ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  const u = json.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: json.id,
    type: 'message',
    role: 'assistant',
    model: json.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Beta.BetaMessage;
}
