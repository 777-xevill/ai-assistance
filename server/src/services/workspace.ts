import { and, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.ts';
import { db, type Executor } from '../db/index.ts';
import { channels, memberships, users, workspaces, type Workspace } from '../db/schema.ts';
import { randomToken } from '../lib/crypto.ts';
import { defaultSettings } from '../lib/defaults.ts';
import type { BusinessType } from '../types.ts';

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return ws ?? null;
}

export async function createWorkspace(input: {
  name: string;
  businessType: BusinessType;
  ownerId: string;
  timezone?: string;
  currency?: string;
}): Promise<Workspace> {
  const defaults = defaultSettings(input.businessType);
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        businessType: input.businessType,
        timezone: input.timezone || 'UTC',
        currency: input.currency || 'USD',
        trialEndsAt: new Date(Date.now() + config.trialDays * 86_400_000),
        ...defaults,
      })
      .returning();
    await tx.insert(memberships).values({ workspaceId: ws.id, userId: input.ownerId, role: 'owner' });
    await insertChatLink(tx, ws);
    return ws;
  });
}

/**
 * Every business gets a public chat link (/chat/<key>) from day one. Customers open it in any browser
 * (from a Facebook or Instagram bio, a QR code, a WhatsApp status...), so nothing has to be connected.
 */
async function insertChatLink(executor: Executor, ws: Workspace): Promise<void> {
  await executor.insert(channels).values({
    workspaceId: ws.id,
    type: 'webchat',
    externalId: `wc_${randomToken(12)}`,
    name: 'Chat link',
    config: { widgetTitle: ws.name, widgetColor: '#0f766e', welcomeMessage: 'Hi! 👋 How can we help you today?' },
  });
}

/** Creates the chat link for businesses that were made before it existed. */
export async function ensureChatLink(ws: Workspace): Promise<void> {
  const [existing] = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.workspaceId, ws.id), eq(channels.type, 'webchat'))).limit(1);
  if (!existing) await insertChatLink(db, ws);
}

/** Invalidates cached AI prompts and catalog indexes for the workspace. */
export async function bumpKnowledge(workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ knowledgeVersion: sql`${workspaces.knowledgeVersion} + 1` })
    .where(eq(workspaces.id, workspaceId));
}

export async function nextOrderNumber(workspaceId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .update(workspaces)
    .set({ orderSeq: sql`${workspaces.orderSeq} + 1` })
    .where(eq(workspaces.id, workspaceId))
    .returning({ seq: workspaces.orderSeq });
  return row.seq;
}

export async function nextBookingNumber(workspaceId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .update(workspaces)
    .set({ bookingSeq: sql`${workspaces.bookingSeq} + 1` })
    .where(eq(workspaces.id, workspaceId))
    .returning({ seq: workspaces.bookingSeq });
  return row.seq;
}

/** Emails of owners/admins who want alerts, plus extra report recipients. */
export async function alertRecipients(ws: Workspace): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, ws.id),
        inArray(memberships.role, ['owner', 'admin']),
        eq(memberships.emailAlerts, true),
      ),
    );
  return [...new Set([...rows.map((r) => r.email), ...(ws.reporting.extraRecipients ?? [])])];
}
