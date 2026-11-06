import { eq } from 'drizzle-orm';
import { adapterFor } from '../channels/index.ts';
import { ChannelError } from '../channels/types.ts';
import { db } from '../db/index.ts';
import { channels, type Channel, type Message, type Workspace } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import type { Attachment } from '../types.ts';
import { addMessage, updateMessage, type Bundle } from './conversations.ts';
import { notify } from './notify.ts';

export interface OutboundInput {
  text?: string;
  imageUrl?: string;
  caption?: string;
  sender: 'ai' | 'human';
  userId?: string | null;
  meta?: Record<string, unknown>;
}

/** Stores an outgoing message and delivers it through the conversation's channel. */
export async function sendOutbound(bundle: Bundle, input: OutboundInput): Promise<Message> {
  const { channel, contact, conversation, workspace } = bundle;
  const attachments: Attachment[] = input.imageUrl
    ? [{ kind: 'image', url: input.imageUrl, mime: 'image/jpeg', status: 'ready', description: input.caption }]
    : [];
  const msg = await addMessage({
    workspaceId: workspace.id,
    conversationId: conversation.id,
    direction: 'out',
    sender: input.sender,
    senderUserId: input.userId ?? null,
    text: input.text ?? null,
    attachments,
    status: 'queued',
    meta: input.meta,
  });
  if (!msg) throw new Error('Could not store message');

  const adapter = adapterFor(channel.type);
  try {
    const res = input.imageUrl
      ? await adapter.sendImage(channel, contact, input.imageUrl)
      : await adapter.sendText(channel, contact, input.text ?? '', { conversation, humanAgent: input.sender === 'human' });
    const externalId = res.externalId ?? null;
    await updateMessage(msg.id, { status: 'sent', externalId });
    return { ...msg, status: 'sent', externalId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateMessage(msg.id, { status: 'failed', error: message.slice(0, 500) });
    logger.warn('Message delivery failed', { channel: channel.type, conversationId: conversation.id, error: message });
    if (err instanceof ChannelError && err.reconnect) await markChannelBroken(workspace, channel, message);
    return { ...msg, status: 'failed', error: message };
  }
}

/** Flags a channel whose token stopped working and tells the business to reconnect it. */
export async function markChannelBroken(ws: Workspace, channel: Channel, detail: string): Promise<void> {
  if (channel.status === 'error') return;
  await db.update(channels).set({ status: 'error', statusDetail: detail.slice(0, 500) }).where(eq(channels.id, channel.id));
  await notify(ws, {
    type: 'channel',
    title: `Reconnect ${channel.name}`,
    body: `We could not send messages through ${channel.name}: ${detail}\nOpen Channels and reconnect it so customers keep getting replies.`,
    link: '/channels',
    email: true,
  });
}
