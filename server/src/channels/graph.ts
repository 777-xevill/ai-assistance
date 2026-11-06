import { config } from '../config.ts';
import { hmacSha256Hex } from '../lib/crypto.ts';
import { ChannelError } from './types.ts';

// Thin client for the Meta Graph API (Messenger, Instagram, WhatsApp Cloud API).

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string };
}

export async function graph<T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { token?: string; params?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(`${config.meta.graphBase}/${config.meta.graphVersion}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
    // Proves the call comes from our server ("Require App Secret" setting).
    if (config.meta.appSecret) url.searchParams.set('appsecret_proof', hmacSha256Hex(config.meta.appSecret, opts.token));
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!res.ok || (typeof data === 'object' && data && 'error' in data)) {
    const err = (data as GraphErrorBody)?.error;
    const code = err?.code;
    // 190 = invalid/expired token; 10/200-299 = permission problems.
    const reconnect = code === 190 || code === 102 || (code !== undefined && code >= 200 && code < 300 && /permission/i.test(err?.message ?? ''));
    throw new ChannelError(err?.error_user_msg || err?.message || `Meta API error (HTTP ${res.status})`, {
      status: res.status,
      code,
      reconnect,
    });
  }
  return data as T;
}

/** Verifies the X-Hub-Signature-256 header Meta sends with every webhook. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.meta.appSecret || !header?.startsWith('sha256=')) return false;
  const expected = hmacSha256Hex(config.meta.appSecret, rawBody);
  const given = header.slice('sha256='.length);
  return expected.length === given.length && timingEqual(expected, given);
}

function timingEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// OAuth helpers used when a business connects its accounts
// ---------------------------------------------------------------------------

export async function exchangeCode(code: string, redirectUri?: string): Promise<string> {
  const params: Record<string, string> = {
    client_id: config.meta.appId,
    client_secret: config.meta.appSecret,
    code,
  };
  if (redirectUri !== undefined) params.redirect_uri = redirectUri;
  const data = await graph<{ access_token: string }>('GET', 'oauth/access_token', { params });
  return data.access_token;
}

export async function longLivedUserToken(shortToken: string): Promise<string> {
  const data = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortToken,
    },
  });
  return data.access_token;
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
}

/** Pages the user granted, with non-expiring Page tokens (when the user token is long-lived). */
export async function listPages(userToken: string): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let next: string | null = 'me/accounts';
  let params: Record<string, string> = {
    fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
    limit: '100',
  };
  while (next && pages.length < 500) {
    const data: { data: MetaPage[]; paging?: { next?: string; cursors?: { after?: string } } } = await graph('GET', next, {
      token: userToken,
      params,
    });
    pages.push(...data.data);
    const after = data.paging?.next ? data.paging.cursors?.after : undefined;
    next = after ? 'me/accounts' : null;
    params = { ...params, after: after ?? '' };
  }
  return pages;
}

const PAGE_FIELDS = 'messages,messaging_postbacks,message_echoes,message_reactions';

export async function subscribePage(pageId: string, pageToken: string): Promise<void> {
  await graph('POST', `${pageId}/subscribed_apps`, { token: pageToken, params: { subscribed_fields: PAGE_FIELDS } });
}

export async function unsubscribePage(pageId: string, pageToken: string): Promise<void> {
  await graph('DELETE', `${pageId}/subscribed_apps`, { token: pageToken });
}

export async function getWhatsAppNumber(phoneNumberId: string, token: string) {
  return graph<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
    'GET',
    phoneNumberId,
    { token, params: { fields: 'id,display_phone_number,verified_name,quality_rating' } },
  );
}

export async function subscribeWaba(wabaId: string, token: string): Promise<void> {
  await graph('POST', `${wabaId}/subscribed_apps`, { token });
}

export async function registerWhatsAppNumber(phoneNumberId: string, token: string, pin: string): Promise<void> {
  await graph('POST', `${phoneNumberId}/register`, { token, body: { messaging_product: 'whatsapp', pin } });
}
