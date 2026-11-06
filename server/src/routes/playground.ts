import { and, eq, gt } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { runAgent } from '../ai/agent.ts';
import { db } from '../db/index.ts';
import { bookings, channels, contacts, conversations, messages, orders, type Channel, type Workspace } from '../db/schema.ts';
import { badRequest, parse, rateLimit } from '../lib/http.ts';
import { saveMedia } from '../lib/storage.ts';
import { deliver, replyBlocker } from '../jobs/reply.ts';
import { findOrCreateContact } from '../services/contacts.ts';
import { acquireLock, addMessage, findOrCreateConversation, getBundle, listMessages, releaseLock } from '../services/conversations.ts';
import { processMessageMedia } from '../services/media.ts';
import { costOf, recordAiRun } from '../services/usage.ts';
import type { Attachment } from '../types.ts';
import { me, ws } from './middleware.ts';
import { upload } from './workspace.ts';

// A private test chat in the dashboard. It runs the exact same assistant as real channels,
// but its conversations, orders and bookings are flagged as test data.

export const playgroundRouter = Router({ mergeParams: true });

async function playgroundChannel(w: Workspace): Promise<Channel> {
  const externalId = `playground:${w.id}`;
  const [existing] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, 'playground'), eq(channels.externalId, externalId)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(channels)
    .values({ workspaceId: w.id, type: 'playground', externalId, name: 'Test chat' })
    .onConflictDoNothing()
    .returning();
  return created ?? (await playgroundChannel(w));
}

async function playgroundConversation(w: Workspace, userId: string, userName: string) {
  const channel = await playgroundChannel(w);
  const { contact } = await findOrCreateContact(w, channel, userId, { name: `${userName} (test)` });
  const { conversation } = await findOrCreateConversation(w, channel, contact);
  return { channel, contact, conversation };
}

playgroundRouter.get('/', async (req, res) => {
  const w = ws(req);
  const { conversation } = await playgroundConversation(w, me(req).id, me(req).name);
  res.json({ conversationId: conversation.id, messages: await listMessages(conversation.id, 200) });
});

playgroundRouter.post('/message', upload.single('file'), async (req, res) => {
  const w = ws(req);
  rateLimit(`playground:${w.id}`, 60, 10 * 60_000);
  const body = parse(z.object({ text: z.string().max(4000).optional() }), req.body ?? {});
  const text = body.text?.trim() || null;
  if (!text && !req.file) throw badRequest('Type a message or attach a file');
  const { conversation } = await playgroundConversation(w, me(req).id, me(req).name);

  const attachments: Attachment[] = [];
  if (req.file) {
    const mime = req.file.mimetype;
    const kind: Attachment['kind'] = /^image\//.test(mime) ? 'image' : /^audio\//.test(mime) || mime === 'video/webm' ? 'audio' : /^video\//.test(mime) ? 'video' : 'file';
    const saved = await saveMedia(w.id, req.file.buffer, mime, { name: req.file.originalname, optimizeImage: kind === 'image' });
    attachments.push({
      kind,
      url: saved.url,
      mime: kind === 'audio' && mime === 'video/webm' ? 'audio/webm' : saved.mime,
      size: saved.size,
      name: req.file.originalname,
      status: kind === 'audio' ? 'pending' : 'ready',
    });
  }
  // Testing should keep working after a hand-off, so the test chat is always un-paused.
  await db.update(conversations).set({ aiPaused: false, aiPausedUntil: null, needsHuman: false }).where(eq(conversations.id, conversation.id));
  const inbound = await addMessage({
    workspaceId: w.id,
    conversationId: conversation.id,
    direction: 'in',
    sender: 'customer',
    text,
    attachments,
  });
  if (!inbound) throw badRequest('Could not save the message');
  if (attachments.some((a) => a.status === 'pending')) await processMessageMedia(inbound.id);

  const bundle = (await getBundle(conversation.id))!;
  const blocker = await replyBlocker(bundle, 'reply');
  if (blocker) {
    res.json({ messages: await listMessages(conversation.id, 200), blocker });
    return;
  }
  if (!(await acquireLock(conversation.id, 120))) throw badRequest('Still answering your previous message…');
  const started = Date.now();
  try {
    const result = await runAgent(bundle, { mode: 'reply' });
    await recordAiRun(w.id, {
      kind: 'reply',
      conversationId: conversation.id,
      usage: result.usage,
      durationMs: Date.now() - started,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      countsAsReply: !result.noReply,
    });
    if (!result.noReply) await deliver(bundle, result);
    res.json({
      messages: await listMessages(conversation.id, 200),
      debug: {
        toolCalls: result.toolCalls,
        usage: result.usage,
        costUsd: Math.round(costOf(result.usage) * 100000) / 100000,
        durationMs: Date.now() - started,
        stopReason: result.stopReason,
        handoff: result.handoff,
        noReply: result.noReply,
      },
    });
  } finally {
    await releaseLock(conversation.id);
  }
});

playgroundRouter.post('/reset', async (req, res) => {
  const w = ws(req);
  const { contact, conversation } = await playgroundConversation(w, me(req).id, me(req).name);
  await db.delete(orders).where(and(eq(orders.conversationId, conversation.id), eq(orders.isTest, true)));
  await db.delete(bookings).where(and(eq(bookings.conversationId, conversation.id), eq(bookings.isTest, true)));
  await db.delete(contacts).where(eq(contacts.id, contact.id)); // cascades to the conversation and messages
  res.json({ ok: true });
});

// Polling endpoint so the playground can show messages that arrive later (photos, follow-ups).
playgroundRouter.get('/since', async (req, res) => {
  const w = ws(req);
  const after = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after) : new Date(0);
  const { conversation } = await playgroundConversation(w, me(req).id, me(req).name);
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), gt(messages.createdAt, after)))
    .orderBy(messages.createdAt);
  res.json({ messages: rows });
});
