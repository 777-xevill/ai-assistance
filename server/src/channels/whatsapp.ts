import type { Channel, Contact, Conversation } from '../db/schema.ts';
import { fetchRemote, publicUrl } from '../lib/storage.ts';
import type { Attachment } from '../types.ts';
import { graph } from './graph.ts';
import { channelToken } from './meta.ts';
import { ChannelError, type ChannelAdapter } from './types.ts';

// WhatsApp Cloud API. The channel's externalId is the business phone_number_id.

const DAY_MS = 24 * 60 * 60 * 1000;

export const whatsappAdapter: ChannelAdapter = {
  maxTextLength: 4096,

  canSend(conversation: Conversation) {
    const last = conversation.lastInboundAt?.getTime() ?? 0;
    if (Date.now() - last <= DAY_MS) return { ok: true };
    return {
      ok: false,
      reason:
        'WhatsApp only allows free-form replies within 24 hours of the customer’s last message. After that an approved template message is required.',
    };
  },

  async sendText(channel: Channel, contact: Contact, text: string) {
    const res = await graph<{ messages?: { id: string }[] }>('POST', `${channel.externalId}/messages`, {
      token: channelToken(channel),
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: contact.externalId,
        type: 'text',
        text: { body: text, preview_url: /https?:\/\//.test(text) },
      },
    });
    return { externalId: res.messages?.[0]?.id };
  },

  async sendImage(channel: Channel, contact: Contact, url: string, caption?: string) {
    const res = await graph<{ messages?: { id: string }[] }>('POST', `${channel.externalId}/messages`, {
      token: channelToken(channel),
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: contact.externalId,
        type: 'image',
        image: { link: publicUrl(url), ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      },
    });
    return { externalId: res.messages?.[0]?.id };
  },

  /** Marks the customer's last message as read and shows the typing indicator. */
  async typing(channel: Channel, _contact: Contact, lastInboundExternalId?: string | null) {
    if (!lastInboundExternalId) return;
    await graph('POST', `${channel.externalId}/messages`, {
      token: channelToken(channel),
      body: {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: lastInboundExternalId,
        typing_indicator: { type: 'text' },
      },
    }).catch(() => {});
  },

  async download(channel: Channel, attachment: Attachment) {
    if (!attachment.remoteId) throw new Error('Attachment has no media id');
    const token = channelToken(channel);
    const meta = await graph<{ url?: string; mime_type?: string }>('GET', attachment.remoteId, { token });
    if (!meta.url) throw new ChannelError('WhatsApp did not return a media URL');
    const file = await fetchRemote(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    return { data: file.data, mime: meta.mime_type || file.mime };
  },
};
