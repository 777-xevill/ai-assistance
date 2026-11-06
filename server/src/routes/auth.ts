import { and, eq, gt, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { aiConfigured } from '../ai/client.ts';
import { transcriptionEnabled } from '../ai/transcribe.ts';
import { config, metaConfigured } from '../config.ts';
import { db } from '../db/index.ts';
import { invites, memberships, passwordResets, sessions, users, workspaces, type User } from '../db/schema.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { BUSINESS_TYPES } from '../lib/defaults.ts';
import { badRequest, conflict, forbidden, HttpError, notFound, parse, rateLimit, unauthorized } from '../lib/http.ts';
import { emailLayout, sendMail } from '../lib/mailer.ts';
import { isValidTimezone } from '../lib/time.ts';
import { createWorkspace } from '../services/workspace.ts';
import type { BusinessType } from '../types.ts';
import { createSession, destroySession, me, requireUser } from './middleware.ts';

export const authRouter = Router();

const businessTypeIds = BUSINESS_TYPES.map((t) => t.id) as [BusinessType, ...BusinessType[]];
const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, isSuperadmin: u.isSuperadmin };
}

async function userWorkspaces(userId: string, isSuperadmin: boolean) {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      businessType: workspaces.businessType,
      onboardedAt: workspaces.onboardedAt,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.createdAt);
  return rows.map((r) => ({ ...r, onboarded: Boolean(r.onboardedAt), isSuperadmin }));
}

function appInfo() {
  return {
    appName: config.appName,
    aiConfigured: aiConfigured(),
    aiMock: config.ai.mock,
    model: config.ai.model,
    transcription: transcriptionEnabled(),
    metaConfigured: metaConfigured(),
    emailConfigured: Boolean(config.mail.smtpUrl),
    signupsEnabled: config.signupsEnabled,
  };
}

authRouter.get('/app', (_req, res) => {
  res.json(appInfo());
});

authRouter.post('/signup', async (req, res) => {
  rateLimit(`signup:${req.ip}`, 10, 60 * 60_000);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(100),
      email,
      password,
      businessName: z.string().trim().min(1).max(120),
      businessType: z.enum(businessTypeIds).default('ecommerce'),
      timezone: z.string().optional(),
      currency: z.string().trim().length(3).optional(),
    }),
    req.body,
  );
  if (!config.signupsEnabled && !config.superadminEmails.includes(body.email)) {
    throw forbidden('Sign-up is closed. Ask us to set up your account.');
  }
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
  if (existing) throw conflict('An account with this email already exists. Sign in instead.');
  const [user] = await db
    .insert(users)
    .values({
      email: body.email,
      name: body.name,
      passwordHash: await hashPassword(body.password),
      isSuperadmin: config.superadminEmails.includes(body.email),
    })
    .returning();
  await createWorkspace({
    name: body.businessName,
    businessType: body.businessType,
    ownerId: user.id,
    timezone: body.timezone && isValidTimezone(body.timezone) ? body.timezone : 'UTC',
    currency: body.currency?.toUpperCase(),
  });
  await createSession(res, user, req);
  res.status(201).json({ user: publicUser(user), workspaces: await userWorkspaces(user.id, user.isSuperadmin), app: appInfo() });
});

authRouter.post('/login', async (req, res) => {
  rateLimit(`login:${req.ip}`, 20, 15 * 60_000);
  const body = parse(z.object({ email, password: z.string().min(1) }), req.body);
  rateLimit(`login:${body.email}`, 10, 15 * 60_000);
  const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw unauthorized('Wrong email or password');
  if (!user.isSuperadmin && config.superadminEmails.includes(user.email)) {
    await db.update(users).set({ isSuperadmin: true }).where(eq(users.id, user.id));
    user.isSuperadmin = true;
  }
  await createSession(res, user, req);
  res.json({ user: publicUser(user), workspaces: await userWorkspaces(user.id, user.isSuperadmin), app: appInfo() });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  if (!req.user) {
    res.json({ user: null, workspaces: [], app: appInfo() });
    return;
  }
  res.json({ user: publicUser(req.user), workspaces: await userWorkspaces(req.user.id, req.user.isSuperadmin), app: appInfo() });
});

authRouter.patch('/me', requireUser, async (req, res) => {
  const user = me(req);
  const body = parse(
    z.object({ name: z.string().trim().min(1).max(100).optional(), currentPassword: z.string().optional(), newPassword: password.optional() }),
    req.body,
  );
  const patch: Partial<User> = {};
  if (body.name) patch.name = body.name;
  if (body.newPassword) {
    if (!body.currentPassword || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw badRequest('Your current password is not correct');
    }
    patch.passwordHash = await hashPassword(body.newPassword);
  }
  const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
  if (body.newPassword) {
    // Sign out other devices.
    const token = req.cookies?.sid as string | undefined;
    const keep = token ? sha256(token) : '';
    const all = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    for (const s of all) if (s.tokenHash !== keep) await db.delete(sessions).where(eq(sessions.id, s.id));
  }
  res.json({ user: publicUser(updated) });
});

authRouter.post('/forgot', async (req, res) => {
  rateLimit(`forgot:${req.ip}`, 5, 60 * 60_000);
  const body = parse(z.object({ email }), req.body);
  const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (user) {
    const token = randomToken(32);
    await db.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) });
    const link = `${config.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: user.email,
      subject: `Reset your ${config.appName} password`,
      html: emailLayout('Reset your password', '<p>Click the button below to choose a new password. The link is valid for one hour.</p>', {
        label: 'Choose a new password',
        url: link,
      }),
      text: `Reset your password: ${link}`,
    });
  }
  res.json({ ok: true });
});

authRouter.post('/reset', async (req, res) => {
  rateLimit(`reset:${req.ip}`, 10, 60 * 60_000);
  const body = parse(z.object({ token: z.string().min(10), password }), req.body);
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, sha256(body.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
    .limit(1);
  if (!row) throw badRequest('This reset link is invalid or has expired');
  await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, row.userId));
  await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
  await db.delete(sessions).where(eq(sessions.userId, row.userId));
  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  await createSession(res, user, req);
  res.json({ user: publicUser(user), workspaces: await userWorkspaces(user.id, user.isSuperadmin) });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

async function findInvite(token: string) {
  const [row] = await db
    .select({ invite: invites, workspaceName: workspaces.name })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

authRouter.get('/invite/:token', async (req, res) => {
  const row = await findInvite(String(req.params.token));
  if (!row) throw notFound('This invitation is invalid or has expired');
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.invite.email)).limit(1);
  res.json({ email: row.invite.email, role: row.invite.role, workspaceName: row.workspaceName, userExists: Boolean(existing) });
});

authRouter.post('/invite/:token/accept', async (req, res) => {
  const row = await findInvite(String(req.params.token));
  if (!row) throw notFound('This invitation is invalid or has expired');
  const inv = row.invite;
  let user = req.user;
  if (user && user.email !== inv.email) {
    throw new HttpError(403, `This invitation is for ${inv.email}. Sign out and accept it with that account.`);
  }
  if (!user) {
    const [existing] = await db.select().from(users).where(eq(users.email, inv.email)).limit(1);
    if (existing) {
      const body = parse(z.object({ password: z.string().min(1) }), req.body);
      if (!(await verifyPassword(body.password, existing.passwordHash))) throw unauthorized('Wrong password');
      user = existing;
    } else {
      const body = parse(z.object({ name: z.string().trim().min(1).max(100), password }), req.body);
      [user] = await db
        .insert(users)
        .values({ email: inv.email, name: body.name, passwordHash: await hashPassword(body.password), isSuperadmin: config.superadminEmails.includes(inv.email) })
        .returning();
    }
    await createSession(res, user, req);
  }
  await db.insert(memberships).values({ workspaceId: inv.workspaceId, userId: user.id, role: inv.role }).onConflictDoNothing();
  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
  res.json({ user: publicUser(user), workspaces: await userWorkspaces(user.id, user.isSuperadmin), workspaceId: inv.workspaceId });
});

// Additional businesses for the same account.
authRouter.post('/workspaces', requireUser, async (req, res) => {
  const user = me(req);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(120),
      businessType: z.enum(businessTypeIds).default('ecommerce'),
      timezone: z.string().optional(),
      currency: z.string().trim().length(3).optional(),
    }),
    req.body,
  );
  const ws = await createWorkspace({
    name: body.name,
    businessType: body.businessType,
    ownerId: user.id,
    timezone: body.timezone && isValidTimezone(body.timezone) ? body.timezone : 'UTC',
    currency: body.currency?.toUpperCase(),
  });
  res.status(201).json({ id: ws.id, workspaces: await userWorkspaces(user.id, user.isSuperadmin) });
});
