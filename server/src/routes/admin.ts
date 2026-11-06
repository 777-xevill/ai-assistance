import crypto from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { channels, jobs, memberships, users, workspaces } from '../db/schema.ts';
import { hashPassword } from '../lib/crypto.ts';
import { BUSINESS_TYPES } from '../lib/defaults.ts';
import { notFound, parse } from '../lib/http.ts';
import { PLANS } from '../lib/plans.ts';
import { isValidTimezone, monthKey } from '../lib/time.ts';
import { createWorkspace } from '../services/workspace.ts';
import type { BusinessType } from '../types.ts';
import { me } from './middleware.ts';

// Super-admin console for running the SaaS: every business, its plan, usage and health.
// Also where you set clients up yourself, so a client never has to sign up or share anything.

export const adminRouter = Router();

const businessTypeIds = BUSINESS_TYPES.map((t) => t.id) as [BusinessType, ...BusinessType[]];
const planIds = PLANS.map((p) => p.id) as [string, ...string[]];
const emailField = z.string().trim().toLowerCase().email().max(200);

/** Readable one-time password (no look-alike characters). */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Creates (or finds) a login for a client and makes them owner of the workspace.
 * A new login gets a generated password; an existing one keeps its password unless resetPassword is set.
 */
async function grantLogin(workspaceId: string, input: { email: string; name?: string; password?: string; resetPassword?: boolean }) {
  const [existing] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  let password: string | null = null;
  let userId: string;
  if (existing) {
    userId = existing.id;
    if (input.resetPassword || input.password) {
      password = input.password ?? generatePassword();
      await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, existing.id));
    }
  } else {
    password = input.password ?? generatePassword();
    const [created] = await db
      .insert(users)
      .values({
        email: input.email,
        name: input.name?.trim() || input.email.split('@')[0],
        passwordHash: await hashPassword(password),
        isSuperadmin: config.superadminEmails.includes(input.email),
      })
      .returning();
    userId = created.id;
  }
  await db
    .insert(memberships)
    .values({ workspaceId, userId, role: 'owner' })
    .onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: 'owner' } });
  return { email: input.email, password, existingUser: Boolean(existing) };
}

async function chatPath(workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ externalId: channels.externalId })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, 'webchat')))
    .limit(1);
  return row ? `${config.appUrl}/chat/${row.externalId}` : null;
}

const loginFields = {
  email: emailField,
  name: z.string().trim().max(100).optional(),
  password: z.string().min(8).max(200).optional(),
};

/**
 * Set a client up yourself. Nothing is asked of them: you only need a business name and type.
 * Without a client email, you own the business and open it from this console (they just get the chat link).
 * With one, the client also gets their own login (password generated for you to pass on).
 */
adminRouter.post('/clients', async (req, res) => {
  const body = parse(
    z.object({
      businessName: z.string().trim().min(1).max(120),
      businessType: z.enum(businessTypeIds).default('ecommerce'),
      timezone: z.string().optional(),
      currency: z.string().trim().length(3).optional(),
      plan: z.enum(planIds).optional(),
      trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
      login: z.object({ ...loginFields, email: emailField.optional() }).optional(),
    }),
    req.body,
  );
  const admin = me(req);
  const workspace = await createWorkspace({
    name: body.businessName,
    businessType: body.businessType,
    ownerId: admin.id,
    timezone: body.timezone && isValidTimezone(body.timezone) ? body.timezone : undefined,
    currency: body.currency?.toUpperCase(),
  });
  if (body.plan || body.trialEndsAt !== undefined) {
    await db
      .update(workspaces)
      .set({
        ...(body.plan ? { plan: body.plan } : {}),
        ...(body.trialEndsAt !== undefined ? { trialEndsAt: body.trialEndsAt ? new Date(body.trialEndsAt) : null } : {}),
      })
      .where(eq(workspaces.id, workspace.id));
  }
  const login = body.login?.email ? await grantLogin(workspace.id, { ...body.login, email: body.login.email }) : null;
  res.status(201).json({
    workspace: { id: workspace.id, name: workspace.name },
    chatUrl: await chatPath(workspace.id),
    login,
  });
});

/** Gives a client their own login to an existing business, or resets the password of an existing one. */
adminRouter.post('/workspaces/:id/login', async (req, res) => {
  const body = parse(z.object({ ...loginFields, resetPassword: z.boolean().optional() }), req.body);
  const workspaceId = String(req.params.id);
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw notFound();
  res.json({ login: await grantLogin(workspaceId, body) });
});

adminRouter.get('/overview', async (_req, res) => {
  const month = monthKey();
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM workspaces) AS workspaces,
      (SELECT count(*)::int FROM workspaces WHERE status = 'active') AS active_workspaces,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM channels WHERE status = 'active' AND type <> 'playground') AS channels,
      (SELECT count(*)::int FROM messages WHERE created_at > now() - interval '24 hours') AS messages_24h,
      (SELECT coalesce(sum(ai_replies), 0)::int FROM usage WHERE month = ${month}) AS ai_replies_month,
      (SELECT coalesce(sum(cost_usd), 0)::float FROM usage WHERE month = ${month}) AS ai_cost_month,
      (SELECT count(*)::int FROM jobs WHERE status = 'failed' AND updated_at > now() - interval '24 hours') AS failed_jobs_24h,
      (SELECT count(*)::int FROM jobs WHERE status = 'queued' AND run_at < now() - interval '2 minutes') AS delayed_jobs`);
  res.json({ overview: result.rows[0], plans: PLANS });
});

adminRouter.get('/workspaces', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const month = monthKey();
  const result = await db.execute(sql`
    SELECT w.id, w.name, w.business_type, w.plan, w.status,
      to_char(w.trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trial_ends_at,
      to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
      to_char(w.onboarded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS onboarded_at,
      (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY u.is_superadmin, m.created_at LIMIT 1) AS owner_email,
      (SELECT u.is_superadmin FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY u.is_superadmin, m.created_at LIMIT 1) AS owner_is_admin,
      (SELECT c.external_id FROM channels c WHERE c.workspace_id = w.id AND c.type = 'webchat' ORDER BY c.created_at LIMIT 1) AS chat_key,
      (SELECT count(*)::int FROM channels c WHERE c.workspace_id = w.id AND c.status = 'active' AND c.type <> 'playground') AS channels,
      (SELECT count(*)::int FROM conversations c WHERE c.workspace_id = w.id AND c.is_test = false AND c.last_message_at > now() - interval '30 days') AS conversations_30d,
      (SELECT count(*)::int FROM orders o WHERE o.workspace_id = w.id AND o.is_test = false AND o.created_at > now() - interval '30 days') AS orders_30d,
      coalesce(us.ai_replies, 0)::int AS ai_replies_month,
      coalesce(us.cost_usd, 0)::float AS ai_cost_month
    FROM workspaces w
    LEFT JOIN usage us ON us.workspace_id = w.id AND us.month = ${month}
    WHERE ${q ? sql`w.name ILIKE ${'%' + q + '%'}` : sql`true`}
    ORDER BY w.created_at DESC
    LIMIT 500`);
  res.json({ workspaces: result.rows, chatUrlBase: `${config.appUrl}/chat/` });
});

adminRouter.patch('/workspaces/:id', async (req, res) => {
  const body = parse(
    z.object({
      plan: z.enum(planIds).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
    }),
    req.body,
  );
  const [row] = await db
    .update(workspaces)
    .set({
      ...(body.plan ? { plan: body.plan } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.trialEndsAt !== undefined ? { trialEndsAt: body.trialEndsAt ? new Date(body.trialEndsAt) : null } : {}),
    })
    .where(eq(workspaces.id, String(req.params.id)))
    .returning();
  if (!row) throw notFound();
  res.json({ workspace: row });
});

adminRouter.get('/jobs', async (req, res) => {
  const status = req.query.status === 'queued' || req.query.status === 'running' ? req.query.status : 'failed';
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, status), gte(jobs.updatedAt, new Date(Date.now() - 7 * 86_400_000))))
    .orderBy(desc(jobs.updatedAt))
    .limit(100);
  res.json({ jobs: rows });
});
