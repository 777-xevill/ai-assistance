import { config } from '../config.ts';
import { readMedia } from '../lib/storage.ts';
import { recordAiRun } from '../services/usage.ts';
import { complete } from './client.ts';

const PROMPTS = {
  product: (name: string) =>
    `This is a catalog photo of "${name}". Describe what is visible, for visual product search, in one or two sentences: product type, colors, patterns, material, style, notable details, and any visible text or brand. No marketing language.`,
  customer: () =>
    'A customer sent this image to a business chat. Describe it in one or two sentences so a sales assistant can remember it later: for a product, its type, colors, pattern, material and any brand or text; for a screenshot or receipt, the key text and amounts; otherwise what it shows.',
};

/** Short factual description of an image, used for search and to keep older chat images in context cheaply. */
export async function describeImage(
  workspaceId: string,
  url: string,
  purpose: 'product' | 'customer',
  opts: { productName?: string; conversationId?: string } = {},
): Promise<string | null> {
  if (config.ai.mock) return null;
  const data = await readMedia(url);
  if (!data || data.length > 4_500_000) return null;
  const started = Date.now();
  const { text, usage } = await complete({
    system: 'You write short, factual image descriptions.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } },
          { type: 'text', text: purpose === 'product' ? PROMPTS.product(opts.productName ?? 'product') : PROMPTS.customer() },
        ],
      },
    ],
    maxTokens: 4000,
    effort: 'low',
    userId: opts.conversationId,
  });
  await recordAiRun(workspaceId, {
    kind: 'vision',
    conversationId: opts.conversationId ?? null,
    usage,
    durationMs: Date.now() - started,
  });
  return text ? text.slice(0, 600) : null;
}
