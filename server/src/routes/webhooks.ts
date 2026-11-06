import { eq } from 'drizzle-orm';
import express, { Router } from 'express';
import { verifyMetaSignature } from '../channels/graph.ts';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { channels, webhookLogs } from '../db/schema.ts';
import { safeEqual } from '../lib/crypto.ts';
import { logger } from '../lib/logger.ts';
import { enqueue } from '../queue/index.ts';

// Platform webhooks. They respond immediately and do the work in background jobs, because Meta
// and Telegram retry (and eventually disable) webhooks that answer slowly.

export const webhooksRouter = Router();

// Meta verification handshake (App Dashboard → Webhooks → Verify and save).
webhooksRouter.get('/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && config.meta.verifyToken && typeof token === 'string' && safeEqual(token, config.meta.verifyToken)) {
    res.status(200).type('text/plain').send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

// One callback URL for Messenger, Instagram and WhatsApp.
webhooksRouter.post('/meta', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'))) {
    logger.warn('Rejected Meta webhook with an invalid signature');
    res.sendStatus(401);
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }
  await db.insert(webhookLogs).values({ source: 'meta', payload: body });
  await enqueue('webhook.meta', { body: body as Record<string, unknown> }, { maxAttempts: 3 });
  res.sendStatus(200);
});

webhooksRouter.post('/telegram/:channelId', express.json({ limit: '2mb' }), async (req, res) => {
  const channelId = String(req.params.channelId);
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    res.sendStatus(404);
    return;
  }
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const secret = channel?.config.webhookSecret;
  const given = req.get('x-telegram-bot-api-secret-token') ?? '';
  if (!channel || channel.type !== 'telegram' || !secret || !safeEqual(given, secret)) {
    res.sendStatus(401);
    return;
  }
  await db.insert(webhookLogs).values({ source: 'telegram', payload: req.body });
  await enqueue('webhook.telegram', { channelId, update: req.body }, { maxAttempts: 3 });
  res.sendStatus(200);
});

// ManyChat "External Request" action. The secret is part of the URL because that is the one thing
// a business pastes into ManyChat.
webhooksRouter.post('/manychat/:channelId/:secret', express.json({ limit: '1mb' }), async (req, res) => {
  const channelId = String(req.params.channelId);
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    res.sendStatus(404);
    return;
  }
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const secret = channel?.config.webhookSecret;
  if (!channel || channel.type !== 'manychat' || channel.status === 'disconnected' || !secret || !safeEqual(String(req.params.secret), secret)) {
    res.sendStatus(401);
    return;
  }
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  await db.insert(webhookLogs).values({ source: 'manychat', payload });
  await enqueue('webhook.manychat', { channelId, payload }, { maxAttempts: 3 });
  // ManyChat shows the response in its flow builder; the reply itself is sent through its API.
  res.json({ ok: true });
});
