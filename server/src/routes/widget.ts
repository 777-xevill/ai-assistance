import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { channels, contacts, conversations, jobs, messages, workspaces, type Channel, type Message } from '../db/schema.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, forbidden, notFound, parse, rateLimit } from '../lib/http.ts';
import { saveMedia } from '../lib/storage.ts';
import { escapeHtml } from '../lib/text.ts';
import { handleInbound } from '../services/inbound.ts';
import type { Attachment } from '../types.ts';
import { upload } from './workspace.ts';

// Public API used by the embeddable website chat widget (/widget.js). No login: a visitor is
// identified by a random id stored in their browser.

export const widgetRouter = Router();

widgetRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const visitorIdSchema = z.string().regex(/^v_[A-Za-z0-9_-]{16,48}$/, 'Invalid visitor id');

async function widgetChannel(req: Request): Promise<{ channel: Channel; businessName: string; assistantName: string }> {
  const key = String(req.params.key ?? '');
  if (!/^wc_[A-Za-z0-9_-]{8,40}$/.test(key)) throw notFound('Chat not found');
  const [row] = await db
    .select({ channel: channels, businessName: workspaces.name, ai: workspaces.ai, status: workspaces.status })
    .from(channels)
    .innerJoin(workspaces, eq(workspaces.id, channels.workspaceId))
    .where(and(eq(channels.type, 'webchat'), eq(channels.externalId, key), eq(channels.status, 'active')))
    .limit(1);
  if (!row || row.status !== 'active') throw notFound('Chat not found');
  const allowed = row.channel.config.allowedOrigins ?? [];
  const origin = req.get('origin');
  const hostedPage = origin === new URL(config.appUrl).origin;
  if (allowed.length && origin && !hostedPage && !allowed.some((a) => new URL(a).origin === origin)) throw forbidden('This site is not allowed to use this chat');
  return { channel: row.channel, businessName: row.businessName, assistantName: row.ai.assistantName };
}

function publicMessage(m: Message) {
  return {
    id: m.id,
    from: m.direction === 'in' ? 'visitor' : 'business',
    text: m.text,
    attachments: m.attachments
      .filter((a) => a.url)
      .map((a) => ({ kind: a.kind, url: `${config.appUrl}${a.url}`, name: a.name })),
    createdAt: m.createdAt,
  };
}

async function visitorConversation(channel: Channel, visitorId: string) {
  const [row] = await db
    .select({ contact: contacts, conversation: conversations })
    .from(contacts)
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(and(eq(contacts.channelId, channel.id), eq(contacts.externalId, visitorId)))
    .limit(1);
  return row ?? null;
}

widgetRouter.get('/:key/config', async (req, res) => {
  const { channel, businessName, assistantName } = await widgetChannel(req);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    title: channel.config.widgetTitle || businessName,
    color: channel.config.widgetColor || '#0f766e',
    welcome: channel.config.welcomeMessage || 'Hi! How can we help you today?',
    assistantName,
  });
});

widgetRouter.post('/:key/session', async (req, res) => {
  rateLimit(`widget-session:${req.ip}`, 60, 10 * 60_000);
  const { channel } = await widgetChannel(req);
  const body = parse(z.object({ visitorId: z.string().optional() }), req.body ?? {});
  const valid = body.visitorId && visitorIdSchema.safeParse(body.visitorId).success;
  const visitorId = valid ? body.visitorId! : `v_${randomToken(18)}`;
  const existing = valid ? await visitorConversation(channel, visitorId) : null;
  const history = existing?.conversation
    ? (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, existing.conversation.id))
          .orderBy(desc(messages.createdAt))
          .limit(50)
      ).reverse()
    : [];
  res.json({ visitorId, messages: history.map(publicMessage) });
});

widgetRouter.get('/:key/messages', async (req, res) => {
  rateLimit(`widget-poll:${req.ip}`, 600, 10 * 60_000);
  const { channel } = await widgetChannel(req);
  const visitorId = visitorIdSchema.parse(req.query.visitorId);
  const after = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after) : new Date(0);
  const existing = await visitorConversation(channel, visitorId);
  if (!existing?.conversation) {
    res.json({ messages: [], typing: false });
    return;
  }
  const conv = existing.conversation;
  const [rows, pending] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), gt(messages.createdAt, after)))
      .orderBy(asc(messages.createdAt))
      .limit(50),
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.uniqueKey, `reply:${conv.id}`), eq(jobs.status, 'queued')))
      .limit(1),
  ]);
  const typing = Boolean(conv.lockedUntil && conv.lockedUntil.getTime() > Date.now()) || pending.length > 0;
  res.json({ messages: rows.map(publicMessage), typing });
});

widgetRouter.post('/:key/messages', upload.single('file'), async (req, res) => {
  rateLimit(`widget-send:${req.ip}`, 40, 5 * 60_000);
  const { channel } = await widgetChannel(req);
  const body = parse(
    z.object({ visitorId: visitorIdSchema, text: z.string().max(2000).optional(), name: z.string().max(80).optional() }),
    req.body ?? {},
  );
  const attachments: Attachment[] = [];
  if (req.file) {
    const mime = req.file.mimetype;
    if (req.file.size > 15 * 1024 * 1024) throw badRequest('File is too large (max 15 MB)');
    const kind: Attachment['kind'] = /^image\//.test(mime) ? 'image' : /^audio\//.test(mime) || mime === 'video/webm' ? 'audio' : 'file';
    const saved = await saveMedia(channel.workspaceId, req.file.buffer, mime, { name: req.file.originalname, optimizeImage: kind === 'image' });
    attachments.push({
      kind,
      url: saved.url,
      mime: kind === 'audio' && mime === 'video/webm' ? 'audio/webm' : saved.mime,
      size: saved.size,
      name: req.file.originalname,
      // Voice notes still need transcribing; the reply job does that first.
      status: kind === 'audio' ? 'pending' : 'ready',
    });
  }
  const text = body.text?.trim();
  if (!text && attachments.length === 0) throw badRequest('Empty message');
  const result = await handleInbound({
    channel,
    externalUserId: body.visitorId,
    text: text || null,
    attachments,
    profile: body.name ? { name: body.name } : undefined,
  });
  if (!result) throw badRequest('Message was not accepted');
  const [msg] = await db.select().from(messages).where(eq(messages.id, result.messageId)).limit(1);
  res.status(201).json({ message: publicMessage(msg) });
});

/** The hosted chat page (/chat/<key>): a full-screen chat customers open from a link or QR code. No login, nothing to install. */
export async function chatPage(req: Request, res: Response): Promise<void> {
  const key = String(req.params.key ?? '');
  const [row] = /^wc_[A-Za-z0-9_-]{8,40}$/.test(key)
    ? await db
        .select({ title: channels.config, name: workspaces.name, status: workspaces.status })
        .from(channels)
        .innerJoin(workspaces, eq(workspaces.id, channels.workspaceId))
        .where(and(eq(channels.type, 'webchat'), eq(channels.externalId, key), eq(channels.status, 'active')))
        .limit(1)
    : [];
  res.setHeader('Cache-Control', 'no-cache');
  if (!row || row.status !== 'active') {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat not found</title><body style="font-family:system-ui;text-align:center;padding:4rem 1rem;color:#52525b"><h1 style="font-size:1.25rem">This chat link is not available</h1><p>Please ask the business for a new link.</p></body>');
    return;
  }
  const title = escapeHtml(row.title.widgetTitle || row.name);
  res
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>html,body{margin:0;height:100%;background:#f4f4f5;font-family:system-ui,sans-serif}</style></head><body><noscript>Please enable JavaScript to chat.</noscript><script src="/widget.js" data-key="${escapeHtml(key)}" data-mode="page"></script></body></html>`,
    );
}
