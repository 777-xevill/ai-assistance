import { eq } from 'drizzle-orm';
import { transcribe } from '../ai/transcribe.ts';
import { adapterFor } from '../channels/index.ts';
import { db } from '../db/index.ts';
import { messages } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { isImageMime, readMedia, saveMedia } from '../lib/storage.ts';
import type { Attachment } from '../types.ts';
import { getBundle, updateMessage } from './conversations.ts';

const inflight = new Map<string, Promise<void>>();

/**
 * Downloads a message's attachments from the platform (their URLs expire), stores them,
 * and transcribes voice messages. Safe to call repeatedly; concurrent calls share one run.
 */
export function processMessageMedia(messageId: string): Promise<void> {
  const running = inflight.get(messageId);
  if (running) return running;
  const p = run(messageId).finally(() => inflight.delete(messageId));
  inflight.set(messageId, p);
  return p;
}

async function run(messageId: string): Promise<void> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || !msg.attachments.some((a) => a.status === 'pending')) return;
  const bundle = await getBundle(msg.conversationId);
  if (!bundle) return;
  const { channel, workspace } = bundle;
  const adapter = adapterFor(channel.type);

  const next: Attachment[] = [];
  for (const att of msg.attachments) {
    if (att.status !== 'pending') {
      next.push(att);
      continue;
    }
    try {
      let data: Buffer | null = null;
      let mime = att.mime ?? 'application/octet-stream';
      let url = att.url;
      if (url) {
        data = await readMedia(url); // already stored (website chat / playground uploads)
      } else if (adapter.download) {
        const file = await adapter.download(channel, att);
        data = file.data;
        mime = att.mime || file.mime;
      }
      if (!data) {
        next.push({ ...att, status: 'failed' });
        continue;
      }
      let kind = att.kind;
      if ((kind === 'image' || kind === 'sticker') && !isImageMime(mime)) kind = /^video\//.test(mime) ? 'video' : 'file';
      let size = att.size ?? data.length;
      if (!url) {
        const saved = await saveMedia(workspace.id, data, mime, { name: att.name, optimizeImage: kind === 'image' });
        url = saved.url;
        mime = saved.mime;
        size = saved.size;
      }
      const updated: Attachment = { ...att, kind, url, mime, size, status: 'ready' };
      if (kind === 'audio') {
        try {
          const text = await transcribe(data, mime, workspace.id);
          if (text) updated.transcript = text;
        } catch (err) {
          logger.warn('Voice transcription failed', { err, messageId });
        }
      }
      next.push(updated);
    } catch (err) {
      logger.warn('Attachment download failed', { err, messageId, kind: att.kind });
      next.push({ ...att, status: 'failed' });
    }
  }
  await updateMessage(messageId, { attachments: next });
}
