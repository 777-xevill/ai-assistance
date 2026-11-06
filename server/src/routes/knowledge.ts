import { and, asc, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { catalogItems, knowledgeEntries, knowledgeGaps, workspaces } from '../db/schema.ts';
import { notFound, parse, rateLimit } from '../lib/http.ts';
import { enqueue } from '../queue/index.ts';
import { suggestFromWebsite } from '../services/importer.ts';
import { bumpKnowledge } from '../services/workspace.ts';
import { requireRole, ws } from './middleware.ts';

export const knowledgeRouter = Router({ mergeParams: true });

const faqSchema = z.object({
  question: z.string().trim().min(2).max(500),
  answer: z.string().trim().min(1).max(5000),
  active: z.boolean().default(true),
});

knowledgeRouter.get('/faqs', async (req, res) => {
  const rows = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.workspaceId, ws(req).id)).orderBy(asc(knowledgeEntries.createdAt));
  res.json({ faqs: rows });
});

knowledgeRouter.post('/faqs', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(faqSchema, req.body);
  const [faq] = await db.insert(knowledgeEntries).values({ ...body, workspaceId: w.id }).returning();
  await bumpKnowledge(w.id);
  res.status(201).json({ faq });
});

knowledgeRouter.patch('/faqs/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(faqSchema.partial(), req.body);
  const [faq] = await db
    .update(knowledgeEntries)
    .set(body)
    .where(and(eq(knowledgeEntries.id, String(req.params.id)), eq(knowledgeEntries.workspaceId, w.id)))
    .returning();
  if (!faq) throw notFound();
  await bumpKnowledge(w.id);
  res.json({ faq });
});

knowledgeRouter.delete('/faqs/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  await db.delete(knowledgeEntries).where(and(eq(knowledgeEntries.id, String(req.params.id)), eq(knowledgeEntries.workspaceId, w.id)));
  await bumpKnowledge(w.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Unanswered questions ("knowledge gaps")
// ---------------------------------------------------------------------------

knowledgeRouter.get('/gaps', async (req, res) => {
  const status = req.query.status === 'resolved' || req.query.status === 'ignored' ? req.query.status : 'open';
  const rows = await db
    .select()
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.workspaceId, ws(req).id), eq(knowledgeGaps.status, status)))
    .orderBy(desc(knowledgeGaps.occurrences), desc(knowledgeGaps.updatedAt))
    .limit(200);
  res.json({ gaps: rows });
});

knowledgeRouter.post('/gaps/:id/resolve', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(z.object({ answer: z.string().trim().min(1).max(5000), question: z.string().trim().min(2).max(500).optional() }), req.body);
  const [gap] = await db
    .select()
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.id, String(req.params.id)), eq(knowledgeGaps.workspaceId, w.id)))
    .limit(1);
  if (!gap) throw notFound();
  const [faq] = await db
    .insert(knowledgeEntries)
    .values({ workspaceId: w.id, question: body.question ?? gap.question, answer: body.answer })
    .returning();
  await db.update(knowledgeGaps).set({ status: 'resolved', answer: body.answer }).where(eq(knowledgeGaps.id, gap.id));
  await bumpKnowledge(w.id);
  res.json({ faq });
});

knowledgeRouter.post('/gaps/:id/ignore', requireRole('admin'), async (req, res) => {
  await db
    .update(knowledgeGaps)
    .set({ status: 'ignored' })
    .where(and(eq(knowledgeGaps.id, String(req.params.id)), eq(knowledgeGaps.workspaceId, ws(req).id)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Import from website (review first, then apply)
// ---------------------------------------------------------------------------

knowledgeRouter.post('/import-website', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  rateLimit(`import:${w.id}`, 10, 60 * 60_000);
  const { url } = parse(z.object({ url: z.string().trim().min(4).max(500) }), req.body);
  const suggestion = await suggestFromWebsite(w, /^https?:\/\//i.test(url) ? url : `https://${url}`);
  res.json({ suggestion });
});

knowledgeRouter.post('/import-website/apply', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(
    z.object({
      profile: z
        .object({
          description: z.string().max(5000).optional(),
          phone: z.string().max(60).optional(),
          email: z.string().max(200).optional(),
          address: z.string().max(500).optional(),
          website: z.string().max(300).optional(),
          shipping: z.string().max(5000).optional(),
          returns: z.string().max(5000).optional(),
          payment: z.string().max(5000).optional(),
        })
        .optional(),
      faqs: z.array(z.object({ question: z.string().trim().min(2).max(500), answer: z.string().trim().min(1).max(5000) })).max(200).optional(),
      items: z
        .array(
          z.object({
            type: z.enum(['product', 'service']),
            name: z.string().trim().min(1).max(200),
            description: z.string().max(5000).default(''),
            price: z.number().min(0).nullable().optional(),
            category: z.string().max(100).optional(),
            image_url: z.string().max(1000).optional(),
          }),
        )
        .max(200)
        .optional(),
    }),
    req.body,
  );
  if (body.profile) {
    const p = body.profile;
    const keep = (next: string | undefined, current: string | undefined) => (next && next.trim() ? next.trim() : current);
    const profile = {
      ...w.profile,
      description: keep(p.description, w.profile.description) ?? '',
      phone: keep(p.phone, w.profile.phone),
      email: keep(p.email, w.profile.email),
      address: keep(p.address, w.profile.address),
      website: keep(p.website, w.profile.website),
      policies: {
        ...w.profile.policies,
        shipping: keep(p.shipping, w.profile.policies?.shipping),
        returns: keep(p.returns, w.profile.policies?.returns),
        payment: keep(p.payment, w.profile.policies?.payment),
      },
    };
    await db.update(workspaces).set({ profile }).where(eq(workspaces.id, w.id));
  }
  if (body.faqs?.length) {
    await db.insert(knowledgeEntries).values(body.faqs.map((f) => ({ workspaceId: w.id, question: f.question, answer: f.answer })));
  }
  let itemsCreated = 0;
  for (const it of body.items ?? []) {
    const [row] = await db
      .insert(catalogItems)
      .values({
        workspaceId: w.id,
        type: it.type,
        name: it.name,
        description: it.description,
        price: it.price ?? null,
        category: it.category || null,
      })
      .returning({ id: catalogItems.id });
    itemsCreated++;
    if (it.image_url && /^https?:\/\//i.test(it.image_url)) {
      await enqueue('catalog.fetch_images', { itemId: row.id, urls: [it.image_url] }, { maxAttempts: 2 });
    }
  }
  await bumpKnowledge(w.id);
  res.json({ ok: true, faqsCreated: body.faqs?.length ?? 0, itemsCreated });
});
