import { config } from '../config.ts';
import type { Channel, Contact } from '../db/schema.ts';
import { decryptJson } from '../lib/crypto.ts';
import { fetchRemote, readMedia } from '../lib/storage.ts';
import type { Attachment, ChannelCredentials } from '../types.ts';
import { ChannelError, type ChannelAdapter } from './types.ts';

// Telegram Bot API. A business creates a bot with @BotFather and pastes its token.

export async function telegramApi<T = any>(token: string, method: string, body?: Record<string, unknown> | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${config.telegramApiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!data.ok) {
    throw new ChannelError(data.description || `Telegram API error (HTTP ${res.status})`, {
      status: res.status,
      code: data.error_code,
      reconnect: data.error_code === 401,
    });
  }
  return data.result as T;
}

function botToken(channel: Channel): string {
  const creds = decryptJson<ChannelCredentials>(channel.credentials);
  if (!creds?.botToken) throw new ChannelError('This bot has no token. Reconnect it.', { reconnect: true });
  return creds.botToken;
}

export async function setTelegramWebhook(token: string, channelId: string, secret: string): Promise<void> {
  await telegramApi(token, 'setWebhook', {
    url: `${config.appUrl}/webhooks/telegram/${channelId}`,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

export const telegramAdapter: ChannelAdapter = {
  maxTextLength: 4096,

  async sendText(channel: Channel, contact: Contact, text: string) {
    const res = await telegramApi<{ message_id: number }>(botToken(channel), 'sendMessage', {
      chat_id: contact.externalId,
      text,
    });
    return { externalId: String(res.message_id) };
  },

  async sendImage(channel: Channel, contact: Contact, url: string, caption?: string) {
    // Upload the bytes so it also works when the server is not publicly reachable.
    const data = url.startsWith('/media/') ? await readMedia(url) : null;
    let res: { message_id: number };
    if (data) {
      const form = new FormData();
      form.set('chat_id', contact.externalId);
      if (caption) form.set('caption', caption.slice(0, 1024));
      form.set('photo', new Blob([new Uint8Array(data)], { type: 'image/jpeg' }), 'photo.jpg');
      res = await telegramApi(botToken(channel), 'sendPhoto', form);
    } else {
      res = await telegramApi(botToken(channel), 'sendPhoto', { chat_id: contact.externalId, photo: url, caption });
    }
    return { externalId: String(res.message_id) };
  },

  async typing(channel: Channel, contact: Contact) {
    await telegramApi(botToken(channel), 'sendChatAction', { chat_id: contact.externalId, action: 'typing' }).catch(() => {});
  },

  async download(channel: Channel, attachment: Attachment) {
    if (!attachment.remoteId) throw new Error('Attachment has no file id');
    const token = botToken(channel);
    const file = await telegramApi<{ file_path?: string }>(token, 'getFile', { file_id: attachment.remoteId });
    if (!file.file_path) throw new ChannelError('Telegram did not return a file path');
    const result = await fetchRemote(`${config.telegramApiBase}/file/bot${token}/${file.file_path}`);
    return { data: result.data, mime: attachment.mime || result.mime };
  },
};
