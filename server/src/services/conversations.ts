import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  channels,
  contacts,
  conversations,
  messages,
  workspaces,
  type Channel,
  type Contact,
  type Conversation,
  type Message,
  type Workspace,
} from '../db/schema.ts';
import { truncate } from '../lib/text.ts';
import type { Attachment, MessageStatus } from '../types.ts';
import { logEvent } from './events.ts';

export interface Bundle {
  workspace: Workspace;
  channel: Channel;
  contact: Contact;
  conversation: Conversation;
}

export async function getBundle(conversationId: string): Promise<Bundle | null> {
  const [row] = await db
    .select({ conversation: conversations, contact: contacts, channel: channels, workspace: workspaces })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export async function findOrCreateConversation(
  ws: Workspace,
  channel: Channel,
  contact: Contact,
): Promise<{ conversation: Conversation; created: boolean }> {
  const [existing] = await db.select().from(conversations).where(eq(conversations.contactId, contact.id)).limit(1);
  if (existing) return { conversation: existing, created: false };
  const inserted = await db
    .insert(conversations)
    .values({ workspaceId: ws.id, channelId: channel.id, contactId: contact.id, isTest: channel.type === 'playground' })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    await logEvent(ws.id, 'conversation_started', {
      contactId: contact.id,
      conversationId: inserted[0].id,
      data: { channel: channel.type, test: channel.type === 'playground' },
    });
    return { conversation: inserted[0], created: true };
  }
  const [row] = await db.select().from(conversations).where(eq(conversations.contactId, contact.id)).limit(1);
  return { conversation: row, created: false };
}

export function previewOf(text: string | null | undefined, attachments: Attachment[] = []): string {
  if (text && text.trim()) return truncate(text.replace(/\s+/g, ' ').trim(), 140);
  const a = attachments[0];
  if (!a) return '';
  const labels: Record<Attachment['kind'], string> = {
    image: '📷 Photo',
    audio: '🎤 Voice message',
    video: '🎬 Video',
    file: '📎 File',
    location: '📍 Location',
    sticker: 'Sticker',
  };
  return labels[a.kind];
}

export interface NewMessage {
  workspaceId: string;
  conversationId: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'ai' | 'human' | 'system';
  senderUserId?: string | null;
  text?: string | null;
  attachments?: Attachment[];
  externalId?: string | null;
  status?: MessageStatus;
  meta?: Record<string, unknown>;
  createdAt?: Date;
}

/** Stores a message and updates the conversation summary fields. Returns null for duplicates. */
export async function addMessage(input: NewMessage): Promise<Message | null> {
  const createdAt = input.createdAt ?? new Date();
  const [msg] = await db
    .insert(messages)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      direction: input.direction,
      sender: input.sender,
      senderUserId: input.senderUserId ?? null,
      text: input.text ?? null,
      attachments: input.attachments ?? [],
      externalId: input.externalId ?? null,
      status: input.status ?? (input.direction === 'in' ? 'received' : 'queued'),
      meta: input.meta ?? {},
      createdAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!msg) return null;

  const preview = previewOf(input.text, input.attachments);
  if (input.direction === 'in') {
    await db
      .update(conversations)
      .set({
        lastMessageAt: createdAt,
        lastMessagePreview: preview,
        lastInboundAt: createdAt,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: 'open',
        followupStep: 0,
      })
      .where(eq(conversations.id, input.conversationId));
  } else if (input.sender !== 'system') {
    await db
      .update(conversations)
      .set({
        lastMessageAt: createdAt,
        lastMessagePreview: preview,
        lastOutboundAt: createdAt,
        // Response time of the first reply, for analytics.
        firstResponseMs: sql`COALESCE(${conversations.firstResponseMs}, CASE WHEN ${conversations.lastInboundAt} IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (${createdAt.toISOString()}::timestamptz - ${conversations.lastInboundAt})) * 1000)::int END)`,
      })
      .where(eq(conversations.id, input.conversationId));
  }
  return msg;
}

export async function updateMessage(id: string, patch: Partial<Pick<Message, 'status' | 'externalId' | 'error' | 'attachments' | 'meta'>>) {
  await db.update(messages).set(patch).where(eq(messages.id, id));
}

/** Messages for the AI context: everything after the rolling summary, most recent `limit`. */
export async function loadHistory(conv: Conversation, limit = 50): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        conv.summaryUptoAt ? gt(messages.createdAt, conv.summaryUptoAt) : undefined,
        or(eq(messages.direction, 'in'), eq(messages.status, 'sent'), eq(messages.status, 'delivered'), eq(messages.status, 'read')),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function countMessagesSince(conversationId: string, since: Date | null): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), since ? gt(messages.createdAt, since) : undefined));
  return Number(row?.n ?? 0);
}

export async function newerInboundExists(conversationId: string, after: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in'), gt(messages.createdAt, after)))
    .limit(1);
  return Boolean(row);
}

export function isAiPaused(conv: Conversation, now = new Date()): boolean {
  if (!conv.aiPaused) return false;
  return !conv.aiPausedUntil || conv.aiPausedUntil.getTime() > now.getTime();
}

export async function setAiPaused(conversationId: string, paused: boolean, minutes?: number | null): Promise<void> {
  await db
    .update(conversations)
    .set({
      aiPaused: paused,
      aiPausedUntil: paused && minutes ? new Date(Date.now() + minutes * 60_000) : null,
      ...(paused ? {} : { needsHuman: false }),
    })
    .where(eq(conversations.id, conversationId));
}

/** Per-conversation lock so two replies are never generated at the same time. */
export async function acquireLock(conversationId: string, seconds = 180): Promise<boolean> {
  const until = new Date(Date.now() + seconds * 1000);
  const rows = await db
    .update(conversations)
    .set({ lockedUntil: until })
    .where(
      and(
        eq(conversations.id, conversationId),
        or(isNull(conversations.lockedUntil), lt(conversations.lockedUntil, new Date())),
      ),
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}

export async function releaseLock(conversationId: string): Promise<void> {
  await db.update(conversations).set({ lockedUntil: null }).where(eq(conversations.id, conversationId));
}

export async function listMessages(conversationId: string, limit = 200): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function firstMessages(conversationId: string, n: number): Promise<Message[]> {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(n);
}
