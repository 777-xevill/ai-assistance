import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { catalogItems, type CatalogItem, type Workspace } from '../db/schema.ts';

// Catalog search: a small in-memory BM25-style ranker per workspace. Rankings are cached per
// knowledgeVersion; result rows are re-read from the database so stock and prices are always current.

const FIELD_WEIGHTS = { name: 3, category: 2, tags: 2, attributes: 1.5, visual: 1.5, variants: 1, description: 1, sku: 3 };
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'is', 'are', 'any', 'do', 'you', 'have', 'i', 'me', 'my', 'want', 'need', 'some']);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function stem(w: string): string {
  if (!/^[a-z]+$/.test(w) || w.length < 4) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

interface IndexedItem {
  id: string;
  type: 'product' | 'service';
  price: number | null;
  active: boolean;
  terms: Map<string, number>;
  length: number;
}

interface WorkspaceIndex {
  version: number;
  items: IndexedItem[];
  df: Map<string, number>;
  avgLength: number;
}

const indexes = new Map<string, WorkspaceIndex>();

function indexItem(item: CatalogItem): IndexedItem {
  const terms = new Map<string, number>();
  const add = (text: string | null | undefined, weight: number) => {
    if (!text) return;
    for (const t of tokenize(text)) terms.set(t, (terms.get(t) ?? 0) + weight);
  };
  add(item.name, FIELD_WEIGHTS.name);
  add(item.category, FIELD_WEIGHTS.category);
  add(item.sku, FIELD_WEIGHTS.sku);
  add(item.tags.join(' '), FIELD_WEIGHTS.tags);
  add(Object.entries(item.attributes).map(([k, v]) => `${k} ${v}`).join(' '), FIELD_WEIGHTS.attributes);
  add(item.variants.map((v) => `${v.name} ${v.options.join(' ')}`).join(' '), FIELD_WEIGHTS.variants);
  add(item.images.map((i) => i.description ?? '').join(' '), FIELD_WEIGHTS.visual);
  add(item.description, FIELD_WEIGHTS.description);
  let length = 0;
  for (const v of terms.values()) length += v;
  return { id: item.id, type: item.type, price: effectivePrice(item), active: item.active, terms, length };
}

async function getIndex(ws: Workspace): Promise<WorkspaceIndex> {
  const cached = indexes.get(ws.id);
  if (cached && cached.version === ws.knowledgeVersion) return cached;
  const rows = await db.select().from(catalogItems).where(eq(catalogItems.workspaceId, ws.id));
  const items = rows.map(indexItem);
  const df = new Map<string, number>();
  for (const it of items) for (const t of it.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLength = items.length ? items.reduce((s, i) => s + i.length, 0) / items.length : 1;
  const index = { version: ws.knowledgeVersion, items, df, avgLength };
  indexes.set(ws.id, index);
  return index;
}

export function effectivePrice(item: Pick<CatalogItem, 'price' | 'salePrice'>): number | null {
  return item.salePrice ?? item.price ?? null;
}

export async function searchCatalog(
  ws: Workspace,
  query: string,
  opts: { type?: 'product' | 'service'; maxPrice?: number; limit?: number } = {},
): Promise<{ items: CatalogItem[]; exact: boolean }> {
  const index = await getIndex(ws);
  const limit = Math.min(opts.limit ?? 6, 15);
  const qTerms = [...new Set(tokenize(query))];
  const N = index.items.length || 1;
  const candidates = index.items.filter(
    (i) => i.active && (!opts.type || i.type === opts.type) && (opts.maxPrice === undefined || i.price === null || i.price <= opts.maxPrice),
  );

  const scored = candidates
    .map((item) => {
      let score = 0;
      for (const q of qTerms) {
        let tf = item.terms.get(q) ?? 0;
        if (tf === 0 && q.length >= 3) {
          // Partial match: query term is a prefix of an item term, or vice versa.
          for (const [t, w] of item.terms) {
            if ((t.length >= 3 && (t.startsWith(q) || q.startsWith(t)))) tf = Math.max(tf, w * 0.5);
          }
        }
        if (tf === 0) continue;
        const df = index.df.get(q) ?? 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const k1 = 1.2;
        const b = 0.6;
        score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * item.length) / index.avgLength));
      }
      return { id: item.id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length > 0) {
    const rows = await getItemsByIds(ws.id, scored.map((s) => s.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: scored.map((s) => byId.get(s.id)).filter((r): r is CatalogItem => Boolean(r)), exact: true };
  }
  // Nothing matched: return a few items so the assistant can suggest alternatives.
  const fallbackIds = candidates.slice(0, Math.min(limit, 5)).map((c) => c.id);
  return { items: fallbackIds.length ? await getItemsByIds(ws.id, fallbackIds) : [], exact: false };
}

export async function getItemsByIds(workspaceId: string, ids: string[]): Promise<CatalogItem[]> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (valid.length === 0) return [];
  return db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.workspaceId, workspaceId), inArray(catalogItems.id, valid)));
}

export async function getItem(workspaceId: string, id: string): Promise<CatalogItem | null> {
  const [row] = await getItemsByIds(workspaceId, [id]);
  return row ?? null;
}

export async function listActiveItems(workspaceId: string): Promise<CatalogItem[]> {
  return db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.workspaceId, workspaceId), eq(catalogItems.active, true)))
    .orderBy(asc(catalogItems.type), asc(catalogItems.category), asc(catalogItems.name));
}

export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return 'price on request';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`;
  }
}

export function stockLabel(item: CatalogItem): string {
  if (item.type === 'service' || item.stock === null) return 'available';
  if (item.stock <= 0) return 'out of stock';
  if (item.stock <= 5) return `only ${item.stock} left`;
  return 'in stock';
}

/** Compact item description used in AI tool results. */
export function itemForAI(item: CatalogItem, currency: string, detail: 'short' | 'full' = 'short') {
  const base = {
    id: item.id,
    type: item.type,
    name: item.name,
    price: formatMoney(item.price, currency),
    ...(item.salePrice !== null && item.salePrice !== undefined
      ? { sale_price: formatMoney(item.salePrice, currency) }
      : {}),
    availability: stockLabel(item),
    category: item.category ?? undefined,
    variants: item.variants.length ? item.variants.map((v) => `${v.name}: ${v.options.join(', ')}`) : undefined,
    duration_minutes: item.type === 'service' ? (item.durationMinutes ?? undefined) : undefined,
    photos: item.images.length,
  };
  if (detail === 'short') {
    return { ...base, summary: item.description.length > 180 ? item.description.slice(0, 177) + '…' : item.description };
  }
  return {
    ...base,
    description: item.description,
    sku: item.sku ?? undefined,
    tags: item.tags.length ? item.tags : undefined,
    attributes: Object.keys(item.attributes).length ? item.attributes : undefined,
    photo_descriptions: item.images.map((i) => i.description).filter(Boolean),
  };
}
