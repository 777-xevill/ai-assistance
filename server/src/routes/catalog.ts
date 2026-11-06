import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { catalogItems, type CatalogItem } from '../db/schema.ts';
import { badRequest, notFound, parse } from '../lib/http.ts';
import { deleteMedia, saveMedia } from '../lib/storage.ts';
import { parseCsv, toCsv } from '../lib/text.ts';
import { enqueue } from '../queue/index.ts';
import { bumpKnowledge } from '../services/workspace.ts';
import type { Variant } from '../types.ts';
import { requireRole, ws } from './middleware.ts';
import { upload } from './workspace.ts';

export const catalogRouter = Router({ mergeParams: true });

const itemSchema = z.object({
  type: z.enum(['product', 'service']).default('product'),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  category: z.string().trim().max(100).nullable().optional(),
  price: z.number().min(0).nullable().optional(),
  salePrice: z.number().min(0).nullable().optional(),
  sku: z.string().trim().max(100).nullable().optional(),
  stock: z.number().int().min(0).nullable().optional(),
  variants: z
    .array(z.object({ name: z.string().trim().min(1).max(40), options: z.array(z.string().trim().min(1).max(60)).min(1).max(60) }))
    .max(5)
    .default([]),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  images: z.array(z.object({ url: z.string().startsWith('/media/'), description: z.string().max(600).optional() })).max(12).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  attributes: z.record(z.string().max(60), z.string().max(300)).default({}),
  active: z.boolean().default(true),
});

catalogRouter.get('/', async (req, res) => {
  const w = ws(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const type = req.query.type === 'product' || req.query.type === 'service' ? req.query.type : undefined;
  const rows = await db
    .select()
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.workspaceId, w.id),
        type ? eq(catalogItems.type, type) : undefined,
        q ? or(ilike(catalogItems.name, `%${q}%`), ilike(catalogItems.category, `%${q}%`), ilike(catalogItems.sku, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(asc(catalogItems.type), asc(catalogItems.category), asc(catalogItems.name));
  res.json({ items: rows });
});

catalogRouter.post('/', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(itemSchema, req.body);
  const [item] = await db.insert(catalogItems).values({ ...body, images: body.images ?? [], workspaceId: w.id }).returning();
  await bumpKnowledge(w.id);
  if (item.images.length) await enqueue('catalog.describe', { itemId: item.id }, { maxAttempts: 2 });
  res.status(201).json({ item });
});

async function findItem(workspaceId: string, id: string): Promise<CatalogItem> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Item not found');
  const [item] = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.id, id), eq(catalogItems.workspaceId, workspaceId)))
    .limit(1);
  if (!item) throw notFound('Item not found');
  return item;
}

catalogRouter.get('/export.csv', async (req, res) => {
  const w = ws(req);
  const rows = await db.select().from(catalogItems).where(eq(catalogItems.workspaceId, w.id)).orderBy(asc(catalogItems.name));
  const csv = toCsv([
    ['type', 'name', 'description', 'category', 'price', 'sale_price', 'sku', 'stock', 'duration_minutes', 'tags', 'variants', 'active'],
    ...rows.map((r) => [
      r.type,
      r.name,
      r.description,
      r.category,
      r.price,
      r.salePrice,
      r.sku,
      r.stock,
      r.durationMinutes,
      r.tags.join(', '),
      r.variants.map((v) => `${v.name}: ${v.options.join('|')}`).join('; '),
      r.active ? 'yes' : 'no',
    ]),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="catalog.csv"');
  res.send('﻿' + csv);
});

catalogRouter.get('/:id', async (req, res) => {
  res.json({ item: await findItem(ws(req).id, String(req.params.id)) });
});

catalogRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const existing = await findItem(w.id, String(req.params.id));
  const body = parse(itemSchema.partial(), req.body);
  const [item] = await db.update(catalogItems).set(body).where(eq(catalogItems.id, existing.id)).returning();
  await bumpKnowledge(w.id);
  if (item.images.some((i) => !i.description)) await enqueue('catalog.describe', { itemId: item.id }, { maxAttempts: 2 });
  res.json({ item });
});

catalogRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const item = await findItem(w.id, String(req.params.id));
  await db.delete(catalogItems).where(eq(catalogItems.id, item.id));
  await Promise.all(item.images.map((i) => deleteMedia(i.url).catch(() => {})));
  await bumpKnowledge(w.id);
  res.json({ ok: true });
});

catalogRouter.post('/:id/images', requireRole('admin'), upload.array('files', 10), async (req, res) => {
  const w = ws(req);
  const item = await findItem(w.id, String(req.params.id));
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('No images uploaded');
  if (item.images.length + files.length > 12) throw badRequest('An item can have at most 12 photos');
  const added = [];
  for (const f of files) {
    if (!/^image\//.test(f.mimetype)) continue;
    const saved = await saveMedia(w.id, f.buffer, f.mimetype, { name: f.originalname, optimizeImage: true });
    added.push({ url: saved.url });
  }
  const [updated] = await db
    .update(catalogItems)
    .set({ images: [...item.images, ...added] })
    .where(eq(catalogItems.id, item.id))
    .returning();
  await bumpKnowledge(w.id);
  await enqueue('catalog.describe', { itemId: item.id }, { maxAttempts: 2 });
  res.json({ item: updated });
});

catalogRouter.delete('/:id/images', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const item = await findItem(w.id, String(req.params.id));
  const { url } = parse(z.object({ url: z.string() }), req.body);
  const [updated] = await db
    .update(catalogItems)
    .set({ images: item.images.filter((i) => i.url !== url) })
    .where(eq(catalogItems.id, item.id))
    .returning();
  await deleteMedia(url).catch(() => {});
  await bumpKnowledge(w.id);
  res.json({ item: updated });
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

function parseVariants(raw: string): Variant[] {
  // "Size: S|M|L; Color: Red|Blue"
  return raw
    .split(';')
    .map((part) => {
      const [name, opts] = part.split(':');
      if (!name || !opts) return null;
      const options = opts.split(/[|/]/).map((o) => o.trim()).filter(Boolean);
      return options.length ? { name: name.trim(), options } : null;
    })
    .filter((v): v is Variant => v !== null)
    .slice(0, 5);
}

const toNumber = (v: string | undefined) => {
  if (!v || !v.trim()) return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

catalogRouter.post('/import-csv', requireRole('admin'), upload.single('file'), async (req, res) => {
  const w = ws(req);
  const text = req.file ? req.file.buffer.toString('utf8') : typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!text.trim()) throw badRequest('Upload a CSV file');
  const rows = parseCsv(text);
  if (rows.length < 2) throw badRequest('The CSV needs a header row and at least one item');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0 && row[i] !== undefined) return row[i].trim();
    }
    return '';
  };
  if (!header.includes('name') && !header.includes('title') && !header.includes('product_name')) {
    throw badRequest('The CSV must have a "name" column');
  }
  let created = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (let r = 1; r < rows.length && r <= 2000; r++) {
    const row = rows[r];
    const name = col(row, 'name', 'title', 'product_name');
    if (!name) {
      skipped.push({ row: r + 1, reason: 'missing name' });
      continue;
    }
    const type = /service/i.test(col(row, 'type')) ? 'service' : 'product';
    const stockRaw = col(row, 'stock', 'quantity', 'inventory');
    const imageUrls = col(row, 'image_urls', 'image_url', 'images', 'image')
      .split(/[\s,;]+/)
      .filter((u) => /^https?:\/\//i.test(u));
    const [item] = await db
      .insert(catalogItems)
      .values({
        workspaceId: w.id,
        type,
        name: name.slice(0, 200),
        description: col(row, 'description', 'details').slice(0, 5000),
        category: col(row, 'category', 'collection') || null,
        price: toNumber(col(row, 'price', 'regular_price')),
        salePrice: toNumber(col(row, 'sale_price', 'discount_price')),
        sku: col(row, 'sku', 'code') || null,
        stock: stockRaw ? Math.max(0, Math.floor(toNumber(stockRaw) ?? 0)) : null,
        durationMinutes: toNumber(col(row, 'duration_minutes', 'duration')) ?? null,
        tags: col(row, 'tags').split(/[,;]/).map((t) => t.trim()).filter(Boolean).slice(0, 30),
        variants: parseVariants(col(row, 'variants', 'options')),
        active: !/^(no|false|0|inactive)$/i.test(col(row, 'active')),
      })
      .returning({ id: catalogItems.id });
    created++;
    if (imageUrls.length) await enqueue('catalog.fetch_images', { itemId: item.id, urls: imageUrls }, { maxAttempts: 2 });
  }
  await bumpKnowledge(w.id);
  res.json({ created, skipped });
});
