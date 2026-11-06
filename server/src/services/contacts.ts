import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { contacts, type Channel, type Contact, type Workspace } from '../db/schema.ts';
import type { LeadInfo, LeadStage } from '../types.ts';
import { logEvent } from './events.ts';
import { notify } from './notify.ts';

export interface ProfileHint {
  name?: string | null;
  username?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
}

export async function findOrCreateContact(
  ws: Workspace,
  channel: Channel,
  externalId: string,
  profile: ProfileHint = {},
): Promise<{ contact: Contact; created: boolean }> {
  const isTest = channel.type === 'playground';
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.channelId, channel.id), eq(contacts.externalId, externalId)))
    .limit(1);
  if (existing) {
    const patch: Partial<Contact> = {};
    if (!existing.name && profile.name) patch.name = profile.name;
    if (!existing.username && profile.username) patch.username = profile.username;
    if (!existing.phone && profile.phone) patch.phone = profile.phone;
    if (!existing.email && profile.email) patch.email = profile.email;
    if (profile.avatarUrl && existing.avatarUrl !== profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
    if (Object.keys(patch).length === 0) return { contact: existing, created: false };
    const [updated] = await db.update(contacts).set(patch).where(eq(contacts.id, existing.id)).returning();
    return { contact: updated, created: false };
  }
  const inserted = await db
    .insert(contacts)
    .values({
      workspaceId: ws.id,
      channelId: channel.id,
      externalId,
      name: profile.name ?? null,
      username: profile.username ?? null,
      phone: profile.phone ?? null,
      email: profile.email ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      isTest,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { contact: inserted[0], created: true };
  // Lost a race with a concurrent webhook; read the winner.
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.channelId, channel.id), eq(contacts.externalId, externalId)))
    .limit(1);
  return { contact: row, created: false };
}

export async function updateContactDetails(
  contactId: string,
  patch: { name?: string; phone?: string; email?: string; address?: string; city?: string; notes?: string; language?: string },
): Promise<Contact> {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, (v as string).trim()]),
  );
  if (Object.keys(clean).length === 0) {
    const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
    return c;
  }
  const [updated] = await db.update(contacts).set(clean).where(eq(contacts.id, contactId)).returning();
  return updated;
}

const STAGE_RANK: Record<LeadStage, number> = { new: 0, interested: 1, qualified: 2, negotiating: 3, won: 4, lost: -1 };

export async function updateLead(
  ws: Workspace,
  contact: Contact,
  patch: { stage?: LeadStage; score?: number; lead?: Partial<LeadInfo>; tags?: string[]; notes?: string },
  conversationId?: string | null,
): Promise<Contact> {
  const set: Partial<Contact> = {};
  if (patch.stage && patch.stage !== contact.stage) set.stage = patch.stage;
  if (typeof patch.score === 'number') set.score = Math.max(0, Math.min(100, Math.round(patch.score)));
  if (patch.lead) {
    const answers = { ...(contact.lead.answers ?? {}), ...(patch.lead.answers ?? {}) };
    set.lead = { ...contact.lead, ...patch.lead, answers };
  }
  if (patch.tags?.length) set.tags = [...new Set([...contact.tags, ...patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)])];
  if (patch.notes) set.notes = patch.notes.slice(0, 2000);
  if (Object.keys(set).length === 0) return contact;

  const [updated] = await db.update(contacts).set(set).where(eq(contacts.id, contact.id)).returning();

  if (set.stage) {
    await logEvent(ws.id, 'lead_stage_changed', {
      contactId: contact.id,
      conversationId,
      data: { from: contact.stage, to: set.stage },
    });
  }
  const becameHot =
    (set.stage && STAGE_RANK[set.stage] >= STAGE_RANK.qualified && STAGE_RANK[contact.stage] < STAGE_RANK.qualified && set.stage !== 'won') ||
    (typeof set.score === 'number' && set.score >= 70 && contact.score < 70);
  if (becameHot && !contact.isTest) {
    const name = updated.name || 'A customer';
    const details = [
      updated.lead.intent && `Wants: ${updated.lead.intent}`,
      updated.lead.budget && `Budget: ${updated.lead.budget}`,
      updated.lead.timeline && `Timeline: ${updated.lead.timeline}`,
      updated.phone && `Phone: ${updated.phone}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notify(ws, {
      type: 'hot_lead',
      title: `Hot lead: ${name}`,
      body: details || 'A conversation looks ready to buy.',
      link: conversationId ? `/inbox?c=${conversationId}` : `/contacts?id=${contact.id}`,
      alert: 'hotLead',
    });
  }
  return updated;
}

export function stageAfterPurchase(current: LeadStage): LeadStage {
  return current === 'won' ? current : 'won';
}
