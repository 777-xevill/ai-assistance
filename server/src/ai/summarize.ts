import { and, asc, eq, gt } from 'drizzle-orm';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { conversations, messages } from '../db/schema.ts';
import { countMessagesSince, getBundle } from '../services/conversations.ts';
import { recordAiRun } from '../services/usage.ts';
import { complete } from './client.ts';

const KEEP_RECENT = 30;
const TRIGGER_AT = 70;

/**
 * Keeps long conversations within context with "simple compaction": older messages are folded
 * into a running summary; only messages after `summaryUptoAt` are replayed to the model.
 */
export async function maybeSummarize(conversationId: string): Promise<void> {
  if (config.ai.mock) return;
  const bundle = await getBundle(conversationId);
  if (!bundle) return;
  const conv = bundle.conversation;
  const count = await countMessagesSince(conv.id, conv.summaryUptoAt);
  if (count < TRIGGER_AT) return;

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), conv.summaryUptoAt ? gt(messages.createdAt, conv.summaryUptoAt) : undefined))
    .orderBy(asc(messages.createdAt));
  const toFold = rows.slice(0, Math.max(0, rows.length - KEEP_RECENT));
  if (toFold.length === 0) return;
  const transcript = toFold
    .map((m) => {
      const who = m.direction === 'in' ? 'Customer' : m.sender === 'human' ? 'Team' : 'Assistant';
      const extras = m.attachments
        .map((a) => (a.kind === 'audio' && a.transcript ? `[voice] ${a.transcript}` : a.description ? `[${a.kind}: ${a.description}]` : `[${a.kind}]`))
        .join(' ');
      return `${who}: ${[extras, m.text].filter(Boolean).join(' ')}`;
    })
    .join('\n');

  const started = Date.now();
  const { text, usage } = await complete({
    system:
      'You maintain a running summary of a customer chat for a sales assistant. Keep every fact that matters for serving the customer: what they want, items/services discussed with prices, sizes and choices, details they gave (name, phone, address), orders or bookings made, promises made by the business, complaints and open questions. Be concise (under 200 words). Write in English.',
    messages: [
      {
        role: 'user',
        content: `${conv.summary ? `Existing summary:\n${conv.summary}\n\n` : ''}New messages to fold in:\n${transcript}\n\nWrite the updated summary.`,
      },
    ],
    maxTokens: 8000,
    effort: 'low',
    userId: conv.contactId,
  });
  await recordAiRun(bundle.workspace.id, { kind: 'summary', conversationId: conv.id, usage, durationMs: Date.now() - started });
  if (!text) return;
  const upto = toFold[toFold.length - 1].createdAt;
  await db
    .update(conversations)
    .set({ summary: text.slice(0, 4000), summaryUptoAt: upto })
    .where(and(eq(conversations.id, conv.id), conv.summaryUptoAt ? eq(conversations.summaryUptoAt, conv.summaryUptoAt) : undefined));
}
