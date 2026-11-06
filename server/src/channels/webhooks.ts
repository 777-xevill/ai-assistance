import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { channels, messages, type Channel } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { handleInbound } from '../services/inbound.ts';
import type { Attachment, ChannelType } from '../types.ts';
import { manychatContactId, type ManychatPlatform } from './manychat.ts';

// Converts platform webhook payloads into InboundEvents.

async function findChannel(types: ChannelType[], externalId: string): Promise<Channel | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(inArray(channels.type, types), eq(channels.externalId, externalId), eq(channels.status, 'active')))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Messenger + Instagram
// ---------------------------------------------------------------------------

interface MetaAttachment {
  type: string;
  payload?: { url?: string; sticker_id?: number; title?: string; coordinates?: { lat: number; long: number } };
  title?: string;
}

function mapMetaAttachment(a: MetaAttachment): Attachment | null {
  const url = a.payload?.url;
  switch (a.type) {
    case 'image':
      return { kind: a.payload?.sticker_id ? 'sticker' : 'image', remoteUrl: url, status: url ? 'pending' : 'failed' };
    case 'audio':
      return { kind: 'audio', remoteUrl: url, status: url ? 'pending' : 'failed' };
    case 'video':
    case 'ig_reel':
    case 'reel':
      return { kind: 'video', remoteUrl: url, status: 'ready' };
    case 'file':
      return { kind: 'file', remoteUrl: url, name: a.payload?.title, status: url ? 'pending' : 'failed' };
    case 'location': {
      const c = a.payload?.coordinates;
      return c ? { kind: 'location', location: { lat: c.lat, lng: c.long, name: a.title }, status: 'ready' } : null;
    }
    case 'share':
    case 'story_mention':
    case 'ig_post':
      // A shared post/story: usually a product photo the customer is asking about.
      return url ? { kind: 'image', remoteUrl: url, name: a.type, status: 'pending' } : null;
    default:
      return url ? { kind: 'file', remoteUrl: url, name: a.type, status: 'ready' } : null;
  }
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    app_id?: number | string;
    attachments?: MetaAttachment[];
    quick_reply?: { payload?: string };
    reply_to?: { story?: { url?: string } };
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

async function handleMessagingEvent(channel: Channel, ev: MessagingEvent): Promise<void> {
  if (ev.message) {
    const m = ev.message;
    if (m.is_deleted) return;
    const echo = Boolean(m.is_echo);
    // Our own outgoing messages come back as echoes tagged with our app id.
    if (echo && m.app_id !== undefined && String(m.app_id) === config.meta.appId) return;
    const customerId = echo ? ev.recipient?.id : ev.sender?.id;
    if (!customerId) return;
    const attachments = (m.attachments ?? []).map(mapMetaAttachment).filter((a): a is Attachment => a !== null);
    let text = m.text ?? m.quick_reply?.payload ?? null;
    if (m.reply_to?.story) text = `(Replying to your story) ${text ?? ''}`.trim();
    await handleInbound({
      channel,
      externalUserId: customerId,
      externalMessageId: m.mid,
      text,
      attachments,
      echo,
      platformTimestamp: ev.timestamp,
    });
  } else if (ev.postback && ev.sender?.id) {
    await handleInbound({
      channel,
      externalUserId: ev.sender.id,
      externalMessageId: ev.postback.mid ?? null,
      text: ev.postback.title || ev.postback.payload || null,
      platformTimestamp: ev.timestamp,
    });
  }
  // Reactions, reads and deliveries are ignored.
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud API
// ---------------------------------------------------------------------------

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string; description?: string } };
  button?: { text?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  order?: { product_items?: { product_retailer_id?: string; quantity?: number; item_price?: number; currency?: string }[]; text?: string };
  referral?: { headline?: string; body?: string; source_url?: string };
}

function mapWhatsApp(m: WhatsAppMessage): { text: string | null; attachments: Attachment[] } | null {
  const att = (a: Attachment) => [a];
  switch (m.type) {
    case 'text':
      return { text: m.text?.body ?? null, attachments: [] };
    case 'image':
      return { text: m.image?.caption ?? null, attachments: att({ kind: 'image', remoteId: m.image!.id, mime: m.image?.mime_type, status: 'pending' }) };
    case 'sticker':
      return { text: null, attachments: att({ kind: 'sticker', remoteId: m.sticker!.id, mime: m.sticker?.mime_type, status: 'pending' }) };
    case 'audio':
      return { text: null, attachments: att({ kind: 'audio', remoteId: m.audio!.id, mime: m.audio?.mime_type, status: 'pending' }) };
    case 'video':
      return { text: m.video?.caption ?? null, attachments: att({ kind: 'video', remoteId: m.video!.id, mime: m.video?.mime_type, status: 'ready' }) };
    case 'document':
      return {
        text: m.document?.caption ?? null,
        attachments: att({ kind: 'file', remoteId: m.document!.id, mime: m.document?.mime_type, name: m.document?.filename, status: 'pending' }),
      };
    case 'location': {
      const l = m.location!;
      return {
        text: `(Shared location) ${[l.name, l.address].filter(Boolean).join(', ')}`.trim(),
        attachments: att({ kind: 'location', location: { lat: l.latitude, lng: l.longitude, name: l.name, address: l.address }, status: 'ready' }),
      };
    }
    case 'interactive':
      return { text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null, attachments: [] };
    case 'button':
      return { text: m.button?.text ?? null, attachments: [] };
    case 'contacts':
      return {
        text: `(Shared contact) ${(m.contacts ?? []).map((c) => `${c.name?.formatted_name ?? ''} ${(c.phones ?? []).map((p) => p.phone).join(', ')}`.trim()).join('; ')}`,
        attachments: [],
      };
    case 'order':
      return {
        text: `(Sent a cart) ${(m.order?.product_items ?? []).map((p) => `${p.quantity ?? 1} × ${p.product_retailer_id}`).join(', ')}${m.order?.text ? ` — ${m.order.text}` : ''}`,
        attachments: [],
      };
    case 'reaction':
      return null;
    default:
      return { text: '(Sent a message type that cannot be displayed)', attachments: [] };
  }
}

interface WhatsAppValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WhatsAppMessage[];
  statuses?: { id: string; status: string; errors?: { title?: string; message?: string }[] }[];
}

async function handleWhatsAppValue(value: WhatsAppValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;
  const channel = await findChannel(['whatsapp'], phoneNumberId);
  if (!channel) {
    logger.warn('WhatsApp webhook for unknown phone number', { phoneNumberId });
    return;
  }
  const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
  for (const m of value.messages ?? []) {
    const mapped = mapWhatsApp(m);
    if (!mapped) continue;
    if (m.referral?.headline) mapped.text = `(Came from ad: ${m.referral.headline}) ${mapped.text ?? ''}`.trim();
    await handleInbound({
      channel,
      externalUserId: m.from,
      externalMessageId: m.id,
      text: mapped.text,
      attachments: mapped.attachments,
      profile: { name: names.get(m.from) ?? null, phone: `+${m.from}` },
      platformTimestamp: m.timestamp ? Number(m.timestamp) * 1000 : undefined,
    });
  }
  for (const s of value.statuses ?? []) {
    const status = ['sent', 'delivered', 'read', 'failed'].includes(s.status) ? s.status : null;
    if (!status) continue;
    await db
      .update(messages)
      .set({
        status: status as 'sent' | 'delivered' | 'read' | 'failed',
        ...(status === 'failed' ? { error: s.errors?.[0]?.message || s.errors?.[0]?.title || 'Delivery failed' } : {}),
      })
      .where(eq(messages.externalId, s.id));
  }
}

// ---------------------------------------------------------------------------

export async function processMetaWebhook(body: any): Promise<void> {
  if (body?.object === 'page' || body?.object === 'instagram') {
    for (const entry of body.entry ?? []) {
      const id = String(entry.id ?? '');
      const preferred: ChannelType[] = body.object === 'page' ? ['messenger', 'instagram'] : ['instagram', 'messenger'];
      let channel = await findChannel([preferred[0]], id);
      if (!channel) channel = await findChannel([preferred[1]], id);
      if (!channel) {
        logger.warn('Meta webhook for an account that is not connected', { object: body.object, id });
        continue;
      }
      for (const ev of entry.messaging ?? []) await handleMessagingEvent(channel, ev);
    }
    return;
  }
  if (body?.object === 'whatsapp_business_account') {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'messages' && change.value) await handleWhatsAppValue(change.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  message?: {
    message_id: number;
    date?: number;
    chat: { id: number; type: string };
    from?: { first_name?: string; last_name?: string; username?: string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; width: number }[];
    voice?: { file_id: string; mime_type?: string; duration?: number };
    audio?: { file_id: string; mime_type?: string; file_name?: string };
    video?: { file_id: string; mime_type?: string };
    video_note?: { file_id: string };
    document?: { file_id: string; mime_type?: string; file_name?: string };
    sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean };
    location?: { latitude: number; longitude: number };
    contact?: { phone_number?: string; first_name?: string };
  };
}

export async function processTelegramUpdate(channel: Channel, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  if (!m || m.chat.type !== 'private') return;
  const attachments: Attachment[] = [];
  if (m.photo?.length) {
    const largest = [...m.photo].sort((a, b) => b.width - a.width)[0];
    attachments.push({ kind: 'image', remoteId: largest.file_id, mime: 'image/jpeg', status: 'pending' });
  }
  if (m.voice) attachments.push({ kind: 'audio', remoteId: m.voice.file_id, mime: m.voice.mime_type ?? 'audio/ogg', status: 'pending' });
  if (m.audio) attachments.push({ kind: 'audio', remoteId: m.audio.file_id, mime: m.audio.mime_type, name: m.audio.file_name, status: 'pending' });
  if (m.video || m.video_note) attachments.push({ kind: 'video', status: 'ready' });
  if (m.document) attachments.push({ kind: 'file', remoteId: m.document.file_id, mime: m.document.mime_type, name: m.document.file_name, status: 'pending' });
  if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) attachments.push({ kind: 'sticker', remoteId: m.sticker.file_id, mime: 'image/webp', status: 'pending' });
  if (m.location) attachments.push({ kind: 'location', location: { lat: m.location.latitude, lng: m.location.longitude }, status: 'ready' });

  let text = m.text ?? m.caption ?? null;
  if (text?.startsWith('/start')) text = 'Hi';
  if (m.contact?.phone_number) text = `${text ?? ''} (Shared phone number: ${m.contact.phone_number})`.trim();
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ');
  await handleInbound({
    channel,
    externalUserId: String(m.chat.id),
    externalMessageId: String(m.message_id),
    text,
    attachments,
    profile: { name: name || null, username: m.from?.username ?? null, phone: m.contact?.phone_number ?? null },
    platformTimestamp: m.date ? m.date * 1000 : undefined,
  });
}

// ---------------------------------------------------------------------------
// ManyChat (External Request action → Facebook, Instagram and WhatsApp without our own Meta app)
// ---------------------------------------------------------------------------

export interface ManychatPayload {
  subscriber_id?: string | number;
  platform?: string;
  name?: string;
  username?: string;
  phone?: string;
  email?: string;
  text?: string;
  image_url?: string;
  audio_url?: string;
  message_id?: string;
}

// ManyChat sends unset fields as "" or as the literal placeholder, e.g. "{{last_input_text}}".
function field(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s && !/^\{\{.*\}\}$/.test(s) ? s : null;
}

function platformOf(v: unknown): ManychatPlatform {
  const p = (field(v) ?? '').toLowerCase();
  if (p.startsWith('ig') || p.startsWith('insta')) return 'instagram';
  if (p.startsWith('wa') || p.startsWith('whats')) return 'whatsapp';
  return 'facebook';
}

// Meta CDN links: what "Last Text Input" holds when the customer sent a photo or voice note.
const MEDIA_URL = /^https:\/\/\S*(fbcdn\.net|fbsbx\.com|cdninstagram\.com|whatsapp\.net)\/\S*$/i;

export async function processManychatMessage(channel: Channel, p: ManychatPayload): Promise<void> {
  const subscriberId = field(p.subscriber_id);
  if (!subscriberId || !/^\d+$/.test(subscriberId)) {
    logger.warn('ManyChat request without a numeric subscriber_id', { channelId: channel.id });
    return;
  }
  let text = field(p.text);
  const attachments: Attachment[] = [];
  const image = field(p.image_url);
  const audio = field(p.audio_url);
  if (image) attachments.push({ kind: 'image', remoteUrl: image, status: 'pending' });
  if (audio) attachments.push({ kind: 'audio', remoteUrl: audio, status: 'pending' });
  if (text && MEDIA_URL.test(text) && attachments.length === 0) {
    const isAudio = /\.(mp4|m4a|aac|ogg|opus|mp3|wav)(\?|$)/i.test(text) || /audioclip/i.test(text);
    attachments.push({ kind: isAudio ? 'audio' : 'image', remoteUrl: text, status: 'pending' });
    text = null;
  }
  if (!text && attachments.length === 0) return;
  await handleInbound({
    channel,
    externalUserId: manychatContactId(platformOf(p.platform), subscriberId),
    externalMessageId: field(p.message_id),
    text,
    attachments,
    profile: { name: field(p.name), username: field(p.username), phone: field(p.phone), email: field(p.email) },
  });
}
