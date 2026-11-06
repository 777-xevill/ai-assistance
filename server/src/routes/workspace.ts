import { and, count, desc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import {
  catalogItems,
  channels,
  conversations,
  invites,
  knowledgeEntries,
  memberships,
  notifications,
  users,
  workspaces,
} from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/http.ts';
import { emailLayout, sendMail } from '../lib/mailer.ts';
import { getPlan, PLANS } from '../lib/plans.ts';
import { saveMedia } from '../lib/storage.ts';
import { escapeHtml } from '../lib/text.ts';
import { isValidTimezone } from '../lib/time.ts';
import { getMonthUsage } from '../services/usage.ts';
import type { Role } from '../types.ts';
import { me, requireRole, ws } from './middleware.ts';
import { aiSchema, bookingSchema, businessTypeSchema, commerceSchema, profileSchema, reportingSchema } from './schemas.ts';

export const workspaceRouter = Router({ mergeParams: true });
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

workspaceRouter.get('/', async (req, res) => {
  const w = ws(req);
  const [[items], [faqs], [chans], [tested], [live], [others], usageRow] = await Promise.all([
    db.select({ n: count() }).from(catalogItems).where(eq(catalogItems.workspaceId, w.id)),
    db.select({ n: count() }).from(knowledgeEntries).where(eq(knowledgeEntries.workspaceId, w.id)),
    db
      .select({ n: count() })
      .from(channels)
      .where(and(eq(channels.workspaceId, w.id), ne(channels.type, 'playground'), ne(channels.status, 'disconnected'))),
    db.select({ n: count() }).from(conversations).where(and(eq(conversations.workspaceId, w.id), eq(conversations.isTest, true))),
    db.select({ n: count() }).from(conversations).where(and(eq(conversations.workspaceId, w.id), eq(conversations.isTest, false))),
    db
      .select({ n: count() })
      .from(channels)
      .where(and(eq(channels.workspaceId, w.id), notInArray(channels.type, ['playground', 'webchat']), ne(channels.status, 'disconnected'))),
    getMonthUsage(w.id),
  ]);
  const plan = getPlan(w.plan);
  res.json({
    workspace: w,
    role: req.membership?.role,
    plan,
    usage: usageRow,
    counts: { catalog: Number(items.n), faqs: Number(faqs.n), channels: Number(chans.n) },
    checklist: {
      profile: Boolean(w.profile.description),
      catalog: Number(items.n) > 0 || Number(faqs.n) > 0,
      tested: Number(tested.n) > 0,
      // Every business has a chat link from day one; this is done once it is shared (a real customer wrote) or a messaging app is connected.
      channel: Number(live.n) > 0 || Number(others.n) > 0,
    },
  });
});

workspaceRouter.patch('/settings', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      businessType: businessTypeSchema.optional(),
      timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      profile: profileSchema.optional(),
      ai: aiSchema.optional(),
      commerce: commerceSchema.optional(),
      booking: bookingSchema.optional(),
      reporting: reportingSchema.optional(),
    }),
    req.body,
  );
  if (body.commerce) {
    const keys = body.commerce.orderFields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Order field keys must be unique');
  }
  const [updated] = await db
    .update(workspaces)
    .set({ ...body, knowledgeVersion: sql`${workspaces.knowledgeVersion} + 1` })
    .where(eq(workspaces.id, w.id))
    .returning();
  res.json({ workspace: updated });
});

workspaceRouter.post('/onboarding/complete', requireRole('admin'), async (req, res) => {
  const [updated] = await db.update(workspaces).set({ onboardedAt: new Date() }).where(eq(workspaces.id, ws(req).id)).returning();
  res.json({ workspace: updated });
});

workspaceRouter.delete('/', requireRole('owner'), async (req, res) => {
  const body = parse(z.object({ confirmName: z.string() }), req.body);
  const w = ws(req);
  if (body.confirmName.trim() !== w.name) throw badRequest('Type the business name exactly to confirm');
  await db.delete(workspaces).where(eq(workspaces.id, w.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

workspaceRouter.get('/team', async (req, res) => {
  const w = ws(req);
  const [members, pending] = await Promise.all([
    db
      .select({ id: memberships.id, role: memberships.role, emailAlerts: memberships.emailAlerts, userId: users.id, name: users.name, email: users.email, joinedAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, w.id))
      .orderBy(memberships.createdAt),
    db
      .select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt, createdAt: invites.createdAt })
      .from(invites)
      .where(and(eq(invites.workspaceId, w.id), isNull(invites.acceptedAt)))
      .orderBy(desc(invites.createdAt)),
  ]);
  res.json({ members, invites: pending, plan: getPlan(w.plan) });
});

workspaceRouter.post('/team/invite', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'agent']).default('agent') }), req.body);
  const plan = getPlan(w.plan);
  const [{ n }] = await db.select({ n: count() }).from(memberships).where(eq(memberships.workspaceId, w.id));
  if (Number(n) >= plan.seats) throw badRequest(`Your ${plan.name} plan includes ${plan.seats} team members. Upgrade to add more.`);
  const [already] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, w.id), eq(users.email, body.email)))
    .limit(1);
  if (already) throw badRequest('This person is already on the team');
  const token = randomToken(24);
  await db.insert(invites).values({
    workspaceId: w.id,
    email: body.email,
    role: body.role,
    tokenHash: sha256(token),
    invitedBy: me(req).id,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  const link = `${config.webUrl}/invite/${token}`;
  await sendMail({
    to: body.email,
    subject: `${me(req).name} invited you to ${w.name} on ${config.appName}`,
    html: emailLayout(
      `Join ${w.name}`,
      `<p>${escapeHtml(me(req).name)} invited you to help manage customer conversations for <strong>${escapeHtml(w.name)}</strong>.</p>`,
      { label: 'Accept invitation', url: link },
    ),
    text: `Accept the invitation: ${link}`,
  });
  res.status(201).json({ link });
});

workspaceRouter.delete('/team/invites/:id', requireRole('admin'), async (req, res) => {
  await db.delete(invites).where(and(eq(invites.id, String(req.params.id)), eq(invites.workspaceId, ws(req).id)));
  res.json({ ok: true });
});

workspaceRouter.patch('/team/me', async (req, res) => {
  const body = parse(z.object({ emailAlerts: z.boolean() }), req.body);
  await db
    .update(memberships)
    .set({ emailAlerts: body.emailAlerts })
    .where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.userId, me(req).id)));
  res.json({ ok: true });
});

workspaceRouter.patch('/team/:id', requireRole('owner'), async (req, res) => {
  const body = parse(z.object({ role: z.enum(['owner', 'admin', 'agent']) }), req.body);
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, String(req.params.id)), eq(memberships.workspaceId, ws(req).id)))
    .limit(1);
  if (!m) throw notFound();
  if (m.userId === me(req).id && body.role !== 'owner') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.role, 'owner')));
    if (Number(n) <= 1) throw badRequest('Make someone else an owner first');
  }
  await db.update(memberships).set({ role: body.role as Role }).where(eq(memberships.id, m.id));
  res.json({ ok: true });
});

workspaceRouter.delete('/team/:id', requireRole('admin'), async (req, res) => {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, String(req.params.id)), eq(memberships.workspaceId, ws(req).id)))
    .limit(1);
  if (!m) throw notFound();
  if (m.role === 'owner') throw forbidden('Owners cannot be removed. Change their role first.');
  await db.delete(memberships).where(eq(memberships.id, m.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

workspaceRouter.get('/notifications', async (req, res) => {
  const w = ws(req);
  const [list, [{ n }]] = await Promise.all([
    db.select().from(notifications).where(eq(notifications.workspaceId, w.id)).orderBy(desc(notifications.createdAt)).limit(30),
    db.select({ n: count() }).from(notifications).where(and(eq(notifications.workspaceId, w.id), isNull(notifications.readAt))),
  ]);
  res.json({ notifications: list, unread: Number(n) });
});

workspaceRouter.post('/notifications/read-all', async (req, res) => {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.workspaceId, ws(req).id), isNull(notifications.readAt)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Plan & usage
// ---------------------------------------------------------------------------

workspaceRouter.get('/billing', async (req, res) => {
  const w = ws(req);
  res.json({ plan: getPlan(w.plan), plans: PLANS, usage: await getMonthUsage(w.id), trialEndsAt: w.trialEndsAt, status: w.status });
});

workspaceRouter.post('/billing/request', requireRole('owner'), async (req, res) => {
  const w = ws(req);
  const body = parse(z.object({ planId: z.string(), note: z.string().max(1000).optional() }), req.body);
  const plan = getPlan(body.planId);
  const admins = await db.select({ email: users.email }).from(users).where(eq(users.isSuperadmin, true));
  const to = [...new Set([...admins.map((a) => a.email), ...config.superadminEmails])];
  await sendMail({
    to,
    subject: `Plan request: ${w.name} → ${plan.name}`,
    html: emailLayout(
      'New plan request',
      `<p><strong>${escapeHtml(w.name)}</strong> (${escapeHtml(me(req).email)}) asked to switch to <strong>${escapeHtml(plan.name)}</strong>.</p>${body.note ? `<p>${escapeHtml(body.note)}</p>` : ''}`,
      { label: 'Open admin', url: `${config.webUrl}/admin` },
    ),
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Media uploads (catalog photos, attachments from the inbox)
// ---------------------------------------------------------------------------

workspaceRouter.post('/media', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) throw badRequest('No file uploaded');
  const saved = await saveMedia(ws(req).id, file.buffer, file.mimetype, { name: file.originalname });
  res.status(201).json(saved);
});
