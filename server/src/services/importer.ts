import type Anthropic from '@anthropic-ai/sdk';
import { createMessage, FALLBACK_BETA, responseText } from '../ai/client.ts';
import { config } from '../config.ts';
import type { Workspace } from '../db/schema.ts';
import { HttpError } from '../lib/http.ts';
import { safeFetch } from '../lib/safe-fetch.ts';
import { htmlToText } from '../lib/text.ts';
import { emptyUsage, recordAiRun } from './usage.ts';
import { addUsage } from '../ai/client.ts';

// "Import from website": reads a few pages of the business's site and drafts the business
// profile, FAQs and catalog. Nothing is saved until the owner reviews and confirms it.

const KEYWORDS = /(about|faq|help|contact|shipping|delivery|return|refund|polic|terms|service|pricing|price|menu|product|shop|collection|course|package)/i;
const MAX_PAGES = 6;
const MAX_CHARS = 60_000;

export interface ImportSuggestion {
  business_description: string;
  phone: string;
  email: string;
  address: string;
  shipping_policy: string;
  returns_policy: string;
  payment_info: string;
  faqs: { question: string; answer: string }[];
  items: { type: 'product' | 'service'; name: string; description: string; price: number | null; category: string; image_url: string }[];
  pages_read: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    business_description: { type: 'string', description: '2-4 sentence description of what the business offers and to whom' },
    phone: { type: 'string' },
    email: { type: 'string' },
    address: { type: 'string' },
    shipping_policy: { type: 'string', description: 'Delivery areas, charges and times, if stated' },
    returns_policy: { type: 'string' },
    payment_info: { type: 'string', description: 'Accepted payment methods, if stated' },
    faqs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer'],
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['product', 'service'] },
          name: { type: 'string' },
          description: { type: 'string' },
          price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          category: { type: 'string' },
          image_url: { type: 'string', description: 'Absolute image URL if one is listed for the item, else empty' },
        },
        required: ['type', 'name', 'description', 'price', 'category', 'image_url'],
      },
    },
  },
  required: ['business_description', 'phone', 'email', 'address', 'shipping_policy', 'returns_policy', 'payment_info', 'faqs', 'items'],
};

function extractLinks(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
      if (KEYWORDS.test(u.pathname) || KEYWORDS.test(m[2])) out.add(u.toString().split('#')[0]);
    } catch {
      // ignore bad hrefs
    }
  }
  return [...out];
}

function extractImages(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\s[^>]*src=["']([^"']+)["'][^>]*?(?:alt=["']([^"']*)["'])?[^>]*>/gi)) {
    try {
      const u = new URL(m[1], base);
      if (/^https?:$/.test(u.protocol) && !/\.svg($|\?)/i.test(u.pathname)) out.push(`${m[2] ? `${m[2]}: ` : ''}${u.toString()}`);
    } catch {
      // ignore
    }
  }
  return out.slice(0, 60);
}

export async function suggestFromWebsite(ws: Workspace, rawUrl: string): Promise<ImportSuggestion> {
  if (config.ai.mock) throw new HttpError(400, 'Website import needs the AI to be configured (AI_MOCK is on).');
  const start = await safeFetch(rawUrl, { maxBytes: 3 * 1024 * 1024 }).catch((err: Error) => {
    throw new HttpError(400, `Could not read that website: ${err.message}`);
  });
  if (!/html|text/i.test(start.mime)) throw new HttpError(400, 'That link does not point to a web page.');
  const base = new URL(start.finalUrl);
  const firstHtml = start.data.toString('utf8');
  const pages: { url: string; text: string; images: string[] }[] = [
    { url: start.finalUrl, text: htmlToText(firstHtml), images: extractImages(firstHtml, base) },
  ];
  for (const link of extractLinks(firstHtml, base).slice(0, MAX_PAGES - 1)) {
    try {
      const page = await safeFetch(link, { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 });
      if (!/html|text/i.test(page.mime)) continue;
      const html = page.data.toString('utf8');
      pages.push({ url: page.finalUrl, text: htmlToText(html), images: extractImages(html, new URL(page.finalUrl)) });
    } catch {
      // Skip pages that fail.
    }
  }
  let budget = MAX_CHARS;
  const corpus = pages
    .map((p) => {
      const chunk = `### Page: ${p.url}\n${p.text.slice(0, Math.max(0, Math.min(budget, 20_000)))}\n${p.images.length ? `Images on this page:\n${p.images.join('\n')}` : ''}`;
      budget -= chunk.length;
      return budget > -20_000 ? chunk : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const started = Date.now();
  const usage = emptyUsage(config.ai.backgroundModel);
  const response = await createMessage({
    model: config.ai.backgroundModel,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system:
      'You extract accurate business information from website text to set up a customer-service assistant. Only include facts stated on the pages. Use empty strings or empty arrays when something is not stated. Write FAQs as real customer questions with complete answers based on the pages. List at most 60 catalog items, using the prices shown (numbers only, no currency symbols).',
    messages: [{ role: 'user', content: `Business name: ${ws.name}\n\n${corpus}` }],
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  addUsage(usage, response);
  await recordAiRun(ws.id, { kind: 'import', usage, durationMs: Date.now() - started, stopReason: response.stop_reason });
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI could not process that website.');
  let parsed: Omit<ImportSuggestion, 'pages_read'>;
  try {
    parsed = JSON.parse(responseText(response));
  } catch {
    throw new HttpError(422, 'The AI returned an unexpected result. Please try again.');
  }
  return { ...parsed, pages_read: pages.map((p) => p.url) };
}
