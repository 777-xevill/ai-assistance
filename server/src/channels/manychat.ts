import { config } from '../config.ts';
import type { Channel, Contact, Conversation } from '../db/schema.ts';
import { decryptJson } from '../lib/crypto.ts';
import { fetchRemote } from '../lib/storage.ts';
import type { Attachment, ChannelCredentials } from '../types.ts';
import { ChannelError, type ChannelAdapter } from './types.ts';

// ManyChat bridge. ManyChat is already approved by Meta, so a business connects its Facebook Page,
// Instagram and WhatsApp there (in ManyChat's own login window) and this server needs no Meta app
// or App Review. A ManyChat "External Request" forwards each customer message to
// /webhooks/manychat/<channel id>/<secret>; replies go back through ManyChat's Sending API.

export type ManychatPlatform = 'facebook' | 'instagram' | 'whatsapp';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function manychatApi<T = any>(apiKey: string, path: string, body?: Record<string, unknown> | string): Promise<T> {
  const res = await fetch(`${config.manychatApiBase}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { status?: string; data?: T; message?: string; details?: unknown };
  if (!res.ok || data.status !== 'success') {
    const detail = data.details ? ` ${JSON.stringify(data.details).slice(0, 300)}` : '';
    throw new ChannelError(`${data.message || `ManyChat API error (HTTP ${res.status})`}${detail}`, {
      status: res.status,
      reconnect: res.status === 401 || res.status === 403,
    });
  }
  return data.data as T;
}

/** Contacts are stored as "<platform>:<subscriber id>" so one ManyChat account can serve several apps. */
export function manychatContactId(platform: ManychatPlatform, subscriberId: string): string {
  return `${platform}:${subscriberId}`;
}

function parseContactId(externalId: string): { platform: ManychatPlatform; subscriberId: string } {
  const [platform, subscriberId] = externalId.split(':');
  if (!subscriberId || !/^\d+$/.test(subscriberId)) throw new ChannelError(`Invalid ManyChat contact id: ${externalId}`);
  return { platform: platform === 'instagram' || platform === 'whatsapp' ? platform : 'facebook', subscriberId };
}

function apiKey(channel: Channel): string {
  const creds = decryptJson<ChannelCredentials>(channel.credentials);
  if (!creds?.apiKey) throw new ChannelError('This ManyChat account has no API key. Reconnect it.', { reconnect: true });
  return creds.apiKey;
}

async function sendContent(channel: Channel, contact: Contact, messages: Record<string, unknown>[]): Promise<void> {
  const { platform, subscriberId } = parseContactId(contact.externalId);
  const content: Record<string, unknown> = { messages, actions: [], quick_replies: [] };
  if (platform !== 'facebook') content.type = platform;
  // ManyChat expects a numeric subscriber_id; ids can be longer than a JS number keeps exactly.
  const body = JSON.stringify({ subscriber_id: '__SID__', data: { version: 'v2', content } }).replace('"__SID__"', subscriberId);
  await manychatApi(apiKey(channel), '/fb/sending/sendContent', body);
}

export const manychatAdapter: ChannelAdapter = {
  // Instagram's limit is the strictest of the three apps ManyChat delivers to.
  maxTextLength: 1000,

  async sendText(channel: Channel, contact: Contact, text: string) {
    await sendContent(channel, contact, [{ type: 'text', text }]);
    return {};
  },

  async sendImage(channel: Channel, contact: Contact, url: string, caption?: string) {
    const absolute = url.startsWith('/') ? `${config.appUrl}${url}` : url;
    await sendContent(channel, contact, [{ type: 'image', url: absolute }, ...(caption ? [{ type: 'text', text: caption.slice(0, 1000) }] : [])]);
    return {};
  },

  async download(_channel: Channel, attachment: Attachment) {
    if (!attachment.remoteUrl) throw new Error('Attachment has no URL');
    const result = await fetchRemote(attachment.remoteUrl);
    return { data: result.data, mime: attachment.mime || result.mime };
  },

  // Meta (and so ManyChat) only lets automated replies go out within 24 hours of the customer's last message.
  canSend(conversation: Conversation) {
    const last = conversation.lastInboundAt?.getTime() ?? 0;
    if (Date.now() - last <= DAY_MS) return { ok: true };
    return { ok: false, reason: 'Outside the 24-hour messaging window.' };
  },
};
