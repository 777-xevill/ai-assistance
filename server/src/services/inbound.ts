import { eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { fetchMetaProfile } from '../channels/meta.ts';
import { db } from '../db/index.ts';
import { contacts, type Channel } from '../db/schema.ts';
import { cancelQueued, enqueue } from '../queue/index.ts';
import type { Attachment } from '../types.ts';
import { findOrCreateContact, type ProfileHint } from './contacts.ts';
import { addMessage, findOrCreateConversation, setAiPaused } from './conversations.ts';
import { getWorkspace } from './workspace.ts';

export interface InboundEvent {
  channel: Channel;
  /** The customer's id on the platform. */
  externalUserId: string;
  externalMessageId?: string | null;
  text?: string | null;
  attachments?: Attachment[];
  profile?: ProfileHint;
  /** The business itself sent this from another app (e.g. Meta Business Suite inbox). */
  echo?: boolean;
  platformTimestamp?: number;
}

export interface InboundResult {
  conversationId: string;
  messageId: string;
}

/** Debounced: customers often send several short messages; reply once they pause. */
export async function scheduleReply(conversationId: string, delayMs = config.replyDebounceMs): Promise<void> {
  await enqueue(
    'conversation.reply',
    { conversationId },
    { delayMs, uniqueKey: `reply:${conversationId}`, debounce: { maxWaitMs: config.replyMaxWaitMs } },
  );
}

export async function handleInbound(ev: InboundEvent): Promise<InboundResult | null> {
  const ws = await getWorkspace(ev.channel.workspaceId);
  if (!ws) return null;
  const text = ev.text?.trim() || null;
  const attachments = ev.attachments ?? [];
  if (!text && attachments.length === 0) return null;

  let { contact, created } = await findOrCreateContact(ws, ev.channel, ev.externalUserId, ev.profile ?? {});
  if (created && !contact.name && (ev.channel.type === 'messenger' || ev.channel.type === 'instagram')) {
    const profile = await fetchMetaProfile(ev.channel, ev.externalUserId);
    if (profile.name || profile.avatarUrl) {
      [contact] = await db
        .update(contacts)
        .set({ name: profile.name ?? null, username: profile.username ?? null, avatarUrl: profile.avatarUrl ?? null })
        .where(eq(contacts.id, contact.id))
        .returning();
    }
  }
  const { conversation } = await findOrCreateConversation(ws, ev.channel, contact);
  const meta = ev.platformTimestamp ? { platformTimestamp: ev.platformTimestamp } : {};

  if (ev.echo) {
    // A team member answered from the platform's own inbox: record it and let the human lead.
    const msg = await addMessage({
      workspaceId: ws.id,
      conversationId: conversation.id,
      direction: 'out',
      sender: 'human',
      text,
      attachments: attachments.map((a) => ({ ...a, status: a.status === 'pending' ? 'ready' : a.status })),
      externalId: ev.externalMessageId,
      status: 'sent',
      meta: { ...meta, via: 'platform_inbox' },
    });
    if (msg) {
      await setAiPaused(conversation.id, true, ws.ai.pauseAfterHumanMinutes || 60);
      await cancelQueued(`reply:${conversation.id}`);
    }
    return msg ? { conversationId: conversation.id, messageId: msg.id } : null;
  }

  const msg = await addMessage({
    workspaceId: ws.id,
    conversationId: conversation.id,
    direction: 'in',
    sender: 'customer',
    text,
    attachments,
    externalId: ev.externalMessageId,
    meta,
  });
  if (!msg) return null; // duplicate webhook delivery

  await db.update(contacts).set({ lastSeenAt: new Date() }).where(eq(contacts.id, contact.id));
  if (attachments.some((a) => a.status === 'pending')) {
    await enqueue('message.media', { messageId: msg.id }, { maxAttempts: 3 });
  }
  await cancelQueued(`followup:${conversation.id}`);
  await scheduleReply(conversation.id);
  return { conversationId: conversation.id, messageId: msg.id };
}
