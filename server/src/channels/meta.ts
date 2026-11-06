import type { Channel, Contact, Conversation } from '../db/schema.ts';
import { decryptJson } from '../lib/crypto.ts';
import { fetchRemote, publicUrl } from '../lib/storage.ts';
import type { Attachment, ChannelCredentials } from '../types.ts';
import { graph } from './graph.ts';
import { ChannelError, type ChannelAdapter } from './types.ts';

// Messenger and Instagram (Messenger API for Instagram) share the Send API on the Facebook Page.

export function channelToken(channel: Channel): string {
  const creds = decryptJson<ChannelCredentials>(channel.credentials);
  if (!creds?.accessToken) throw new ChannelError('This channel has no access token. Reconnect it.', { reconnect: true });
  return creds.accessToken;
}

function pageIdOf(channel: Channel): string {
  return channel.type === 'messenger' ? channel.externalId : channel.config.pageId || channel.externalId;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeAdapter(kind: 'messenger' | 'instagram'): ChannelAdapter {
  const adapter: ChannelAdapter = {
    maxTextLength: kind === 'messenger' ? 2000 : 1000,

    canSend(conversation: Conversation, sender) {
      const last = conversation.lastInboundAt?.getTime() ?? 0;
      if (Date.now() - last <= DAY_MS) return { ok: true };
      if (sender === 'human' && Date.now() - last <= 7 * DAY_MS) return { ok: true }; // HUMAN_AGENT tag
      return {
        ok: false,
        reason:
          sender === 'human'
            ? 'Meta only allows replies within 7 days of the customer’s last message.'
            : 'Outside the 24-hour messaging window.',
      };
    },

    async sendText(channel: Channel, contact: Contact, text: string, opts = {}) {
      const outsideDay = opts.conversation?.lastInboundAt
        ? Date.now() - opts.conversation.lastInboundAt.getTime() > DAY_MS
        : false;
      const body: Record<string, unknown> = {
        recipient: { id: contact.externalId },
        message: { text },
        messaging_type: 'RESPONSE',
      };
      if (outsideDay && opts.humanAgent) {
        body.messaging_type = 'MESSAGE_TAG';
        body.tag = 'HUMAN_AGENT';
      }
      const res = await graph<{ message_id?: string }>('POST', `${pageIdOf(channel)}/messages`, {
        token: channelToken(channel),
        body,
      });
      return { externalId: res.message_id };
    },

    async sendImage(channel: Channel, contact: Contact, url: string, caption?: string) {
      const token = channelToken(channel);
      const res = await graph<{ message_id?: string }>('POST', `${pageIdOf(channel)}/messages`, {
        token,
        body: {
          recipient: { id: contact.externalId },
          messaging_type: 'RESPONSE',
          message: { attachment: { type: 'image', payload: { url: publicUrl(url), is_reusable: false } } },
        },
      });
      if (caption) await adapter.sendText(channel, contact, caption);
      return { externalId: res.message_id };
    },

    async typing(channel: Channel, contact: Contact) {
      await graph('POST', `${pageIdOf(channel)}/messages`, {
        token: channelToken(channel),
        body: { recipient: { id: contact.externalId }, sender_action: 'typing_on' },
      }).catch(() => {});
    },

    async download(_channel: Channel, attachment: Attachment) {
      if (!attachment.remoteUrl) throw new Error('Attachment has no URL');
      return fetchRemote(attachment.remoteUrl);
    },
  };
  return adapter;
}

export const messengerAdapter = makeAdapter('messenger');
export const instagramAdapter = makeAdapter('instagram');

/** Best-effort profile lookup for a new Messenger/Instagram contact. */
export async function fetchMetaProfile(
  channel: Channel,
  userId: string,
): Promise<{ name?: string; username?: string; avatarUrl?: string }> {
  try {
    const token = channelToken(channel);
    if (channel.type === 'messenger') {
      const p = await graph<{ first_name?: string; last_name?: string; profile_pic?: string }>('GET', userId, {
        token,
        params: { fields: 'first_name,last_name,profile_pic' },
      });
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
      return { name: name || undefined, avatarUrl: p.profile_pic };
    }
    const p = await graph<{ name?: string; username?: string; profile_pic?: string }>('GET', userId, {
      token,
      params: { fields: 'name,username,profile_pic' },
    });
    return { name: p.name || p.username, username: p.username, avatarUrl: p.profile_pic };
  } catch {
    return {};
  }
}
