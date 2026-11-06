import { and, eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { memberships, sessions, users, workspaces, type User } from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { forbidden, notFound, unauthorized } from '../lib/http.ts';
import type { Role } from '../types.ts';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;

export async function createSession(res: Response, user: User, req: Request): Promise<void> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt,
    userAgent: (req.get('user-agent') ?? '').slice(0, 300),
    ip: req.ip ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://') && config.isProd,
    expires: expiresAt,
    path: '/',
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Attaches req.user when a valid session cookie is present. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token && typeof token === 'string') {
    const [row] = await db
      .select({ user: users, session: sessions })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sha256(token)))
      .limit(1);
    if (row && row.session.expiresAt.getTime() > Date.now()) {
      req.user = row.user;
      // Sliding expiry: extend sessions that are used.
      if (row.session.expiresAt.getTime() - Date.now() < (SESSION_DAYS / 2) * 86_400_000) {
        await db
          .update(sessions)
          .set({ expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
          .where(eq(sessions.id, row.session.id));
      }
    }
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw unauthorized();
  next();
}

export function requireSuperadmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw unauthorized();
  if (!req.user.isSuperadmin) throw forbidden();
  next();
}

/** Resolves :wid and checks membership. Super admins can open any workspace. */
export async function requireWorkspace(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw unauthorized();
  const wid = String(req.params.wid ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(wid)) throw notFound('Workspace not found');
  const [row] = await db
    .select({ workspace: workspaces, membership: memberships })
    .from(workspaces)
    .leftJoin(memberships, and(eq(memberships.workspaceId, workspaces.id), eq(memberships.userId, req.user.id)))
    .where(eq(workspaces.id, wid))
    .limit(1);
  if (!row) throw notFound('Workspace not found');
  if (!row.membership && !req.user.isSuperadmin) throw notFound('Workspace not found');
  req.workspace = row.workspace;
  req.membership =
    row.membership ??
    ({ id: 'superadmin', workspaceId: wid, userId: req.user.id, role: 'owner', emailAlerts: false, createdAt: new Date() } as const);
  next();
}

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.membership?.role;
    if (!role || RANK[role] < RANK[min]) throw forbidden('Your role does not allow this action');
    next();
  };
}

/** Typed accessors for handlers behind requireWorkspace. */
export function ws(req: Request) {
  if (!req.workspace) throw new Error('requireWorkspace middleware missing');
  return req.workspace;
}

export function me(req: Request) {
  if (!req.user) throw unauthorized();
  return req.user;
}
