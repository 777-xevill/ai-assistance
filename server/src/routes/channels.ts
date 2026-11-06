import crypto from 'node:crypto';
import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  exchangeCode,
  getWhatsAppNumber,
  listPages,
  longLivedUserToken,
  registerWhatsAppNumber,
  subscribePage,
  subscribeWaba,
  unsubscribePage,
  type MetaPage,
} from '../channels/graph.ts';
import { manychatApi } from '../channels/manychat.ts';
import { setTelegramWebhook, telegramApi } from '../channels/telegram.ts';
import { ChannelError } from '../channels/types.ts';
import { config, metaConfigured } from '../config.ts';
import { db } from '../db/index.ts';
import { channels, oauthSessions, type Channel, type Workspace } from '../db/schema.ts';
import { decryptJson, encryptJson, randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, HttpError, notFound, parse } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import { getPlan } from '../lib/plans.ts';
import { ensureChatLink } from '../services/workspace.ts';
import type { ChannelConfig, ChannelCredentials, ChannelType } from '../types.ts';
import { me, requireRole, ws } from './middleware.ts';

export const channelsRouter = Router({ mergeParams: true });

export function publicChannel(c: Channel) {
  const { credentials, ...rest } = c;
  const { webhookSecret, ...cfg } = c.config;
  return {
    ...rest,
    config: cfg,
    connected: Boolean(credentials) || c.type === 'webchat',
    // The address the business pastes into ManyChat's External Request action.
    ...(c.type === 'manychat' && webhookSecret ? { inboundUrl: `${config.appUrl}/webhooks/manychat/${c.id}/${webhookSecret}` } : {}),
  };
}

async function activeChannelCount(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), ne(channels.type, 'playground'), ne(channels.status, 'disconnected')));
  return rows.length;
}

/** Creates or refreshes a channel. One platform account can only belong to one workspace. */
async function upsertChannel(
  w: Workspace,
  input: { type: ChannelType; externalId: string; name: string; credentials?: ChannelCredentials; config?: ChannelConfig },
): Promise<Channel> {
  const [existing] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, input.type), eq(channels.externalId, input.externalId)))
    .limit(1);
  const values = {
    name: input.name.slice(0, 120),
    status: 'active' as const,
    statusDetail: null,
    credentials: input.credentials ? encryptJson(input.credentials) : null,
    config: { ...(existing?.config ?? {}), ...(input.config ?? {}) },
  };
  if (existing) {
    if (existing.workspaceId !== w.id) {
      throw conflict(`${input.name} is already connected to another business on ${config.appName}. Disconnect it there first.`);
    }
    const [row] = await db.update(channels).set(values).where(eq(channels.id, existing.id)).returning();
    return row;
  }
  const plan = getPlan(w.plan);
  if ((await activeChannelCount(w.id)) >= plan.channels) {
    throw new HttpError(402, `Your ${plan.name} plan includes ${plan.channels} channels. Upgrade to connect more.`);
  }
  const [row] = await db
    .insert(channels)
    .values({ workspaceId: w.id, type: input.type, externalId: input.externalId, ...values })
    .returning();
  return row;
}

function friendly(err: unknown): string {
  if (err instanceof ChannelError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

channelsRouter.get('/', async (req, res) => {
  const w = ws(req);
  await ensureChatLink(w);
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, w.id), ne(channels.type, 'playground'), ne(channels.status, 'disconnected')))
    .orderBy(channels.createdAt);
  res.json({
    channels: rows.map(publicChannel),
    setup: {
      meta: {
        configured: metaConfigured(),
        appId: config.meta.appId || null,
        graphVersion: config.meta.graphVersion,
        loginConfigId: config.meta.loginConfigId || null,
        whatsappConfigId: config.meta.whatsappConfigId || null,
      },
      appUrl: config.appUrl,
      publicServer: /^https:\/\//.test(config.appUrl),
      widgetScript: `${config.appUrl}/widget.js`,
      chatUrlBase: `${config.appUrl}/chat/`,
    },
    limit: getPlan(w.plan).channels,
  });
});

// ---------------------------------------------------------------------------
// Facebook Pages → Messenger + Instagram (Facebook Login, no passwords shared)
// ---------------------------------------------------------------------------

interface PagesSession {
  pages: MetaPage[];
}

channelsRouter.post('/meta/pages', requireRole('admin'), async (req, res) => {
  if (!metaConfigured()) throw badRequest('Meta is not configured on this server (META_APP_ID / META_APP_SECRET).');
  const w = ws(req);
  const body = parse(z.object({ code: z.string().optional(), accessToken: z.string().optional() }), req.body);
  if (!body.code && !body.accessToken) throw badRequest('Missing login result');
  let pages: MetaPage[];
  try {
    const shortToken = body.code ? await exchangeCode(body.code) : body.accessToken!;
    const userToken = await longLivedUserToken(shortToken).catch(() => shortToken);
    pages = await listPages(userToken);
  } catch (err) {
    throw badRequest(`Facebook login failed: ${friendly(err)}`);
  }
  if (pages.length === 0) {
    throw badRequest('No Facebook Pages were shared. Run the login again and select at least one Page (and its Instagram account).');
  }
  const ids = pages.flatMap((p) => [p.id, p.instagram_business_account?.id].filter(Boolean) as string[]);
  const taken = await db
    .select({ type: channels.type, externalId: channels.externalId, workspaceId: channels.workspaceId })
    .from(channels)
    .where(and(inArray(channels.externalId, ids), inArray(channels.type, ['messenger', 'instagram'])));
  const state = (type: ChannelType, id?: string) => {
    const t = id ? taken.find((x) => x.type === type && x.externalId === id) : undefined;
    return !t ? 'available' : t.workspaceId === w.id ? 'connected' : 'elsewhere';
  };
  const [session] = await db
    .insert(oauthSessions)
    .values({
      workspaceId: w.id,
      userId: me(req).id,
      kind: 'meta_pages',
      data: encryptJson({ pages } satisfies PagesSession),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    })
    .returning({ id: oauthSessions.id });
  res.json({
    sessionId: session.id,
    pages: pages.map((p) => ({
      id: p.id,
      name: p.name,
      pictureUrl: p.picture?.data?.url ?? null,
      messenger: state('messenger', p.id),
      instagram: p.instagram_business_account
        ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null, status: state('instagram', p.instagram_business_account.id) }
        : null,
    })),
  });
});

channelsRouter.post('/meta/connect', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(
    z.object({
      sessionId: z.string().uuid(),
      selections: z.array(z.object({ pageId: z.string(), messenger: z.boolean(), instagram: z.boolean() })).min(1),
    }),
    req.body,
  );
  const [session] = await db
    .select()
    .from(oauthSessions)
    .where(and(eq(oauthSessions.id, body.sessionId), eq(oauthSessions.workspaceId, w.id), gt(oauthSessions.expiresAt, new Date())))
    .limit(1);
  const data = decryptJson<PagesSession>(session?.data);
  if (!data) throw badRequest('This connection session expired. Please log in with Facebook again.');

  const connected: ReturnType<typeof publicChannel>[] = [];
  const errors: { pageId: string; error: string }[] = [];
  for (const sel of body.selections) {
    const page = data.pages.find((p) => p.id === sel.pageId);
    if (!page || (!sel.messenger && !sel.instagram)) continue;
    try {
      await subscribePage(page.id, page.access_token);
      const pictureUrl = page.picture?.data?.url;
      if (sel.messenger) {
        const ch = await upsertChannel(w, {
          type: 'messenger',
          externalId: page.id,
          name: page.name,
          credentials: { accessToken: page.access_token },
          config: { pageId: page.id, pageName: page.name, pictureUrl },
        });
        connected.push(publicChannel(ch));
      }
      const ig = page.instagram_business_account;
      if (sel.instagram && ig) {
        const ch = await upsertChannel(w, {
          type: 'instagram',
          externalId: ig.id,
          name: ig.username ? `@${ig.username}` : `${page.name} (Instagram)`,
          credentials: { accessToken: page.access_token },
          config: { pageId: page.id, pageName: page.name, igUsername: ig.username, pictureUrl: ig.profile_picture_url ?? pictureUrl },
        });
        connected.push(publicChannel(ch));
      }
    } catch (err) {
      logger.warn('Could not connect Page', { pageId: page.id, err });
      errors.push({ pageId: page.id, error: friendly(err) });
    }
  }
  await db.delete(oauthSessions).where(eq(oauthSessions.id, body.sessionId));
  res.json({ connected, errors });
});

// ---------------------------------------------------------------------------
// WhatsApp (Embedded Signup)
// ---------------------------------------------------------------------------

async function connectWhatsApp(w: Workspace, token: string, wabaId: string, phoneNumberId: string) {
  const info = await getWhatsAppNumber(phoneNumberId, token);
  await subscribeWaba(wabaId, token);
  let statusDetail: string | null = null;
  const pin = String(crypto.randomInt(100000, 1000000));
  try {
    await registerWhatsAppNumber(phoneNumberId, token, pin);
  } catch (err) {
    // Numbers already registered (or using the WhatsApp Business app) can't be registered again.
    statusDetail = `Phone registration: ${friendly(err)}`;
    logger.warn('WhatsApp number registration failed', { phoneNumberId, err });
  }
  const ch = await upsertChannel(w, {
    type: 'whatsapp',
    externalId: phoneNumberId,
    name: info.verified_name || info.display_phone_number || 'WhatsApp',
    credentials: { accessToken: token },
    config: { wabaId, displayPhone: info.display_phone_number, verifiedName: info.verified_name },
  });
  if (statusDetail) await db.update(channels).set({ statusDetail }).where(eq(channels.id, ch.id));
  return { ...ch, statusDetail };
}

channelsRouter.post('/whatsapp/connect', requireRole('admin'), async (req, res) => {
  if (!metaConfigured()) throw badRequest('Meta is not configured on this server.');
  const body = parse(z.object({ code: z.string().min(5), wabaId: z.string().min(3), phoneNumberId: z.string().min(3) }), req.body);
  try {
    const token = await exchangeCode(body.code);
    const ch = await connectWhatsApp(ws(req), token, body.wabaId, body.phoneNumberId);
    res.json({ channel: publicChannel(ch) });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`WhatsApp connection failed: ${friendly(err)}`);
  }
});

/** Advanced/testing: connect with a system-user token from Meta Business settings. */
channelsRouter.post('/whatsapp/manual', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ accessToken: z.string().min(20), wabaId: z.string().min(3), phoneNumberId: z.string().min(3) }), req.body);
  try {
    const ch = await connectWhatsApp(ws(req), body.accessToken, body.wabaId, body.phoneNumberId);
    res.json({ channel: publicChannel(ch) });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`WhatsApp connection failed: ${friendly(err)}`);
  }
});

// ---------------------------------------------------------------------------
// Telegram (bot token from @BotFather) and website chat
// ---------------------------------------------------------------------------

channelsRouter.post('/telegram', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const { botToken } = parse(z.object({ botToken: z.string().trim().regex(/^\d+:[\w-]{20,}$/, 'That does not look like a bot token') }), req.body);
  let bot: { id: number; username?: string; first_name?: string };
  try {
    bot = await telegramApi(botToken, 'getMe');
  } catch (err) {
    throw badRequest(`Telegram rejected the token: ${friendly(err)}`);
  }
  const secret = randomToken(24);
  const ch = await upsertChannel(w, {
    type: 'telegram',
    externalId: String(bot.id),
    name: bot.first_name || `@${bot.username}`,
    credentials: { botToken },
    config: { botUsername: bot.username, webhookSecret: secret },
  });
  try {
    await setTelegramWebhook(botToken, ch.id, secret);
  } catch (err) {
    await db.update(channels).set({ status: 'error', statusDetail: `Webhook: ${friendly(err)}` }).where(eq(channels.id, ch.id));
    throw badRequest(`Bot saved, but Telegram could not reach this server (${friendly(err)}). APP_URL must be a public HTTPS address.`);
  }
  res.json({ channel: publicChannel(ch) });
});

// ManyChat: the business connects Facebook, Instagram and WhatsApp inside ManyChat (a Meta-approved
// platform), then gives us its API key. No Meta app or App Review is needed on our side.
channelsRouter.post('/manychat', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(10, 'Paste the API key from ManyChat → Settings → API').max(300) }), req.body);
  let page: { id: number | string; name?: string };
  try {
    page = await manychatApi(apiKey, '/fb/page/getInfo');
  } catch (err) {
    throw badRequest(`ManyChat rejected the API key: ${friendly(err)}`);
  }
  const [existing] = await db
    .select({ config: channels.config })
    .from(channels)
    .where(and(eq(channels.type, 'manychat'), eq(channels.externalId, String(page.id))))
    .limit(1);
  const ch = await upsertChannel(w, {
    type: 'manychat',
    externalId: String(page.id),
    name: page.name || 'ManyChat',
    credentials: { apiKey },
    // Keep the old secret on reconnect so the URL already pasted into ManyChat keeps working.
    config: { pageName: page.name, webhookSecret: existing?.config.webhookSecret ?? randomToken(24) },
  });
  res.json({ channel: publicChannel(ch) });
});

channelsRouter.post('/webchat', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const body = parse(z.object({ name: z.string().trim().max(80).optional() }), req.body);
  const ch = await upsertChannel(w, {
    type: 'webchat',
    externalId: `wc_${randomToken(12)}`,
    name: body.name || 'Website chat',
    config: { widgetTitle: w.name, widgetColor: '#0f766e', welcomeMessage: 'Hi! 👋 How can we help you today?' },
  });
  res.status(201).json({ channel: publicChannel(ch) });
});

// ---------------------------------------------------------------------------

async function findChannel(workspaceId: string, id: string): Promise<Channel> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Channel not found');
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))
    .limit(1);
  if (!ch) throw notFound('Channel not found');
  return ch;
}

channelsRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const ch = await findChannel(w.id, String(req.params.id));
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      aiEnabled: z.boolean().optional(),
      config: z
        .object({
          widgetTitle: z.string().trim().max(80).optional(),
          widgetColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
          welcomeMessage: z.string().trim().max(300).optional(),
          allowedOrigins: z.array(z.string().trim().url()).max(20).optional(),
        })
        .optional(),
    }),
    req.body,
  );
  const [updated] = await db
    .update(channels)
    .set({
      ...(body.name ? { name: body.name } : {}),
      ...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
      ...(body.config ? { config: { ...ch.config, ...body.config } } : {}),
    })
    .where(eq(channels.id, ch.id))
    .returning();
  res.json({ channel: publicChannel(updated) });
});

channelsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const w = ws(req);
  const ch = await findChannel(w.id, String(req.params.id));
  const creds = decryptJson<ChannelCredentials>(ch.credentials);
  try {
    if ((ch.type === 'messenger' || ch.type === 'instagram') && creds?.accessToken) {
      const pageId = ch.config.pageId ?? ch.externalId;
      // Keep the Page subscribed if the other channel on the same Page is still connected.
      const siblings = await db
        .select({ id: channels.id, config: channels.config })
        .from(channels)
        .where(and(eq(channels.workspaceId, w.id), inArray(channels.type, ['messenger', 'instagram']), eq(channels.status, 'active'), ne(channels.id, ch.id)));
      if (!siblings.some((s) => s.config.pageId === pageId)) await unsubscribePage(pageId, creds.accessToken);
    } else if (ch.type === 'telegram' && creds?.botToken) {
      await telegramApi(creds.botToken, 'deleteWebhook');
    }
  } catch (err) {
    logger.warn('Cleanup while disconnecting a channel failed', { err, channelId: ch.id });
  }
  await db
    .update(channels)
    .set({
      status: 'disconnected',
      credentials: null,
      // Frees the platform id so it can be connected again later (here or elsewhere).
      externalId: `${ch.externalId}#off-${Date.now()}`,
    })
    .where(eq(channels.id, ch.id));
  res.json({ ok: true });
});
