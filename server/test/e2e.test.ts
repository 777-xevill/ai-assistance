// End-to-end test of the whole pipeline against a scripted fake Claude API, Graph API and Telegram API.
// Run with: npm test (from the repo root)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// ---------------------------------------------------------------------------
// Fake upstream APIs
// ---------------------------------------------------------------------------

type Body = Record<string, any>;
type Scripted = (body: Body) => Body;
const claudeRequests: { headers: http.IncomingHttpHeaders; body: Body }[] = [];
const graphRequests: { method: string; url: string; body: Body | null }[] = [];
const telegramRequests: { method: string; body: Body | null }[] = [];
const manychatRequests: { method: string; url: string; raw: string; auth?: string }[] = [];
let script: Scripted[] = [];
let seq = 0;

const message = (content: Body[], stop_reason: string): Body => ({
  id: `msg_${++seq}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
});
const toolUse = (name: string, input: Body | ((body: Body) => Body)): Scripted => (body) =>
  message(
    [
      { type: 'thinking', thinking: '', signature: `sig_${seq}` },
      { type: 'tool_use', id: `toolu_${++seq}`, name, input: typeof input === 'function' ? input(body) : input },
    ],
    'tool_use',
  );
const reply = (text: string): Scripted => () => message([{ type: 'text', text }], 'end_turn');

/** Last tool_result content in a request, parsed as JSON when possible. */
function lastToolResult(body: Body): any {
  const last = body.messages[body.messages.length - 1];
  const result = (Array.isArray(last.content) ? last.content : []).find((b: Body) => b.type === 'tool_result');
  const content = typeof result?.content === 'string' ? result.content : result?.content?.[0]?.text;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = req.url ?? '';
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let body: Body | null = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (url.startsWith('/v1/messages')) {
      claudeRequests.push({ headers: req.headers, body: body! });
      const next = script.shift();
      json(200, next ? next(body!) : message([{ type: 'text', text: 'Default reply' }], 'end_turn'));
      return;
    }
    if (url.startsWith('/manychat/')) {
      manychatRequests.push({ method: req.method ?? 'GET', url, raw, auth: req.headers.authorization });
      if (req.headers.authorization !== 'Bearer mc-key-123456') json(401, { status: 'error', message: 'Wrong token' });
      else if (url.endsWith('/fb/page/getInfo')) json(200, { status: 'success', data: { id: 5550001, name: 'Nova Page' } });
      else json(200, { status: 'success', data: {} });
      return;
    }
    if (url.startsWith('/bot')) {
      telegramRequests.push({ method: url.split('/')[2]?.split('?')[0] ?? '', body });
      json(200, { ok: true, result: { message_id: 77 } });
      return;
    }
    // Graph API
    graphRequests.push({ method: req.method ?? 'GET', url, body });
    if (req.method === 'GET') json(200, { first_name: 'Messenger', last_name: 'Customer' });
    else if (url.includes('/PHONE1/messages')) json(200, { messages: [{ id: `wamid.${++seq}` }] });
    else json(200, { message_id: `mid.${++seq}`, recipient_id: 'x' });
  });
});

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assistance-test-'));
let base = '';
let app: http.Server;
let mod: {
  db: typeof import('../src/db/index.ts');
  queue: typeof import('../src/queue/index.ts');
  crypto: typeof import('../src/lib/crypto.ts');
  schema: typeof import('../src/db/schema.ts');
};

class Client {
  cookie = '';
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, data };
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    // Pinned so a developer's own .env (provider, keys, models) never changes what the tests exercise.
    AI_PROVIDER: 'anthropic',
    AI_MODEL: 'claude-opus-5-5',
    AI_BACKGROUND_MODEL: 'claude-opus-5-5',
    GROQ_API_KEY: '',
    STT_API_KEY: '',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: fakeUrl,
    META_GRAPH_BASE: fakeUrl,
    TELEGRAM_API_BASE: fakeUrl,
    MANYCHAT_API_BASE: `${fakeUrl}/manychat`,
    META_APP_ID: '1234',
    META_APP_SECRET: 'meta-secret',
    META_VERIFY_TOKEN: 'verify-me',
    TYPING_DELAY: 'false',
    REPLY_DEBOUNCE_MS: '50',
    REPLY_MAX_WAIT_MS: '300',
    SUPERADMIN_EMAILS: 'admin@test.dev',
    LOG_LEVEL: 'warn',
  });
  const db = await import('../src/db/index.ts');
  const queue = await import('../src/queue/index.ts');
  const { registerJobs } = await import('../src/jobs/index.ts');
  const { createApp } = await import('../src/app.ts');
  mod = { db, queue, crypto: await import('../src/lib/crypto.ts'), schema: await import('../src/db/schema.ts') };
  await db.initDb();
  registerJobs();
  app = createApp().listen(0);
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  queue.startWorker();
});

after(async () => {
  await mod.queue.stopWorker(2000);
  await new Promise((r) => app.close(r));
  await mod.db.closeDb();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Shared state across the ordered tests below.
const owner = new Client();
let wid = '';
let itemId = '';
let widgetKey = '';
let visitorId = '';

async function widgetSay(text: string) {
  const r = await owner.req('POST', `/api/widget/${widgetKey}/messages`, { visitorId, text });
  assert.equal(r.status, 201, JSON.stringify(r.data));
}

async function businessMessages(): Promise<{ from: string; text: string }[]> {
  const r = await owner.req('GET', `/api/widget/${widgetKey}/messages?visitorId=${visitorId}`);
  return r.data.messages.filter((m: any) => m.from === 'business');
}

test('signup creates a business workspace with a trial', async () => {
  const r = await owner.req('POST', '/api/auth/signup', {
    name: 'Rifa Owner',
    email: 'owner@test.dev',
    password: 'password123',
    businessName: 'Nova Fashion',
    businessType: 'ecommerce',
    timezone: 'Asia/Dhaka',
    currency: 'BDT',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  wid = r.data.workspaces[0].id;
  const ws = await owner.req('GET', `/api/w/${wid}`);
  assert.equal(ws.data.plan.id, 'trial');
  assert.equal(ws.data.workspace.commerce.ordersEnabled, true);
  assert.equal(ws.data.workspace.booking.enabled, false);
});

test('every business gets a ready chat link and customers can open it without logging in', async () => {
  const list = await owner.req('GET', `/api/w/${wid}/channels`);
  const link = list.data.channels.find((c: any) => c.type === 'webchat');
  assert.ok(link, 'a chat link exists from day one, with nothing to connect');
  assert.match(list.data.setup.chatUrlBase, /\/chat\/$/);

  const page = await fetch(`${base}/chat/${link.externalId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-mode="page"/);
  assert.ok(html.includes(`data-key="${link.externalId}"`));
  assert.ok(html.includes('<title>Nova Fashion</title>'));

  assert.equal((await fetch(`${base}/chat/wc_doesnotexist123`)).status, 404);

  // The page talks to the public widget API with no login.
  const session = await fetch(`${base}/api/widget/${link.externalId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
    body: '{}',
  });
  assert.ok(session.ok, `session failed: ${session.status}`);
  assert.match(((await session.json()) as { visitorId: string }).visitorId, /^v_/);

  // The checklist only counts the link as shared once a real customer or a messaging app is involved.
  const ws = await owner.req('GET', `/api/w/${wid}`);
  assert.equal(ws.data.checklist.channel, false);
});

test('owner configures delivery, payments, catalog and website chat', async () => {
  const ws = (await owner.req('GET', `/api/w/${wid}`)).data.workspace;
  const r = await owner.req('PATCH', `/api/w/${wid}/settings`, {
    commerce: {
      ...ws.commerce,
      deliveryZones: [
        { id: 'dhaka', name: 'Inside Dhaka', fee: 60, eta: '1-2 days' },
        { id: 'outside', name: 'Outside Dhaka', fee: 120, eta: '3-5 days' },
      ],
      paymentMethods: [
        { id: 'cod', name: 'Cash on delivery' },
        { id: 'bkash', name: 'bKash', instructions: 'Send to 01700000000' },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const item = await owner.req('POST', `/api/w/${wid}/catalog`, {
    name: 'Red Floral Dress',
    price: 2400,
    stock: 5,
    category: 'Dresses',
    description: 'Cotton summer dress with a red floral print.',
    variants: [{ name: 'Size', options: ['S', 'M', 'L'] }],
  });
  assert.equal(item.status, 201);
  itemId = item.data.item.id;
  await owner.req('POST', `/api/w/${wid}/knowledge/faqs`, { question: 'Do you deliver outside Dhaka?', answer: 'Yes, everywhere in Bangladesh in 3-5 days.' });
  const ch = await owner.req('POST', `/api/w/${wid}/channels/webchat`, {});
  assert.equal(ch.status, 201);
  widgetKey = ch.data.channel.externalId;
  const s = await owner.req('POST', `/api/widget/${widgetKey}/session`, {});
  visitorId = s.data.visitorId;
});

test('customer asks about a product: agent searches the catalog and replies in bubbles', async () => {
  script = [
    toolUse('search_catalog', { query: 'red dress' }),
    toolUse('get_item_details', { item_id: itemId }),
    reply('Yes! Our Red Floral Dress is ৳2,400.\n\nWhich size would you like: S, M or L?'),
  ];
  const before = claudeRequests.length;
  await widgetSay('Do you have red dresses?');
  const msgs = await waitFor(async () => {
    const m = await businessMessages();
    return m.length >= 2 ? m : null;
  });
  assert.equal(msgs[0].text, 'Yes! Our Red Floral Dress is ৳2,400.');
  assert.equal(msgs[1].text, 'Which size would you like: S, M or L?');

  const first = claudeRequests[before];
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.deepEqual(first.body.thinking, { type: 'adaptive' });
  assert.equal(first.body.output_config.effort, 'medium');
  assert.equal(first.body.fallbacks, 'default');
  assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.deepEqual(first.body.system[0].cache_control, { type: 'ephemeral' });
  assert.match(first.body.system[0].text, /Nova Fashion/);
  assert.match(first.body.system[0].text, /Inside Dhaka \(id dhaka\)/);
  assert.match(first.body.system[0].text, /Do you deliver outside Dhaka\?/);
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  const toolNames = first.body.tools.map((t: Body) => t.name);
  for (const t of ['search_catalog', 'quote_order', 'create_order', 'request_human']) assert.ok(toolNames.includes(t), t);
  assert.ok(!toolNames.includes('check_availability'), 'booking tools are off for this store');
  const lastMsg = first.body.messages[first.body.messages.length - 1];
  assert.equal(lastMsg.role, 'system');
  assert.match(lastMsg.content, /<turn_context>/);
  const userTurn = first.body.messages[first.body.messages.length - 2];
  assert.equal(userTurn.role, 'user');
  assert.deepEqual(userTurn.content.at(-1).cache_control, { type: 'ephemeral' });

  // The tool loop passes the assistant turn (including its thinking block) back unchanged.
  const second = claudeRequests[before + 1];
  const assistantTurn = second.body.messages.at(-2);
  assert.equal(assistantTurn.role, 'assistant');
  assert.equal(assistantTurn.content[0].type, 'thinking');
  const search = lastToolResult(second.body);
  assert.equal(search.matches[0].name, 'Red Floral Dress');
  assert.equal(search.matches[0].price, '৳2,400');
  // System prompt and tools are byte-identical across the loop (prompt cache stays valid).
  assert.equal(JSON.stringify(second.body.system), JSON.stringify(first.body.system));
  assert.equal(JSON.stringify(second.body.tools), JSON.stringify(first.body.tools));
});

test('agent quotes the exact total including delivery', async () => {
  let quote: any;
  script = [
    toolUse('save_customer_details', { name: 'Rina', phone: '01711111111', address: 'House 1, Road 2, Dhanmondi, Dhaka' }),
    toolUse('quote_order', { items: [{ item_id: itemId, quantity: 1, variant: 'Size M' }], delivery_zone_id: 'dhaka' }),
    (body) => {
      quote = lastToolResult(body);
      return reply('Here is your order summary. Shall I confirm it?')(body);
    },
  ];
  await widgetSay('M please. Rina, 01711111111, House 1 Road 2 Dhanmondi Dhaka');
  await waitFor(async () => (await businessMessages()).length >= 3);
  assert.equal(quote.total, '৳2,460');
  assert.equal(quote.issues_to_resolve_first, undefined);
});

test('after confirmation the agent places the order, reserves stock and alerts the owner', async () => {
  script = [
    toolUse('create_order', {
      items: [{ item_id: itemId, quantity: 1, variant: 'Size M' }],
      delivery_zone_id: 'dhaka',
      customer_name: 'Rina',
      phone: '01711111111',
      address: 'House 1, Road 2, Dhanmondi, Dhaka',
      payment_method_id: 'cod',
    }),
    (body) => reply(`Done! Your order #${lastToolResult(body).order_number} is confirmed.`)(body),
  ];
  await widgetSay('Yes, confirm. Cash on delivery.');
  const msgs = await waitFor(async () => {
    const m = await businessMessages();
    return m.length >= 4 ? m : null;
  });
  assert.equal(msgs[3].text, 'Done! Your order #1001 is confirmed.');
  const orders = await owner.req('GET', `/api/w/${wid}/orders`);
  assert.equal(orders.data.orders.length, 1);
  const order = orders.data.orders[0];
  assert.equal(order.total, 2460);
  assert.equal(order.deliveryZone, 'Inside Dhaka');
  assert.equal(order.paymentMethod, 'Cash on delivery');
  const item = await owner.req('GET', `/api/w/${wid}/catalog/${itemId}`);
  assert.equal(item.data.item.stock, 4);
  const contacts = await owner.req('GET', `/api/w/${wid}/contacts`);
  assert.equal(contacts.data.contacts[0].stage, 'won');
  assert.equal(contacts.data.contacts[0].phone, '01711111111');
  const notes = await owner.req('GET', `/api/w/${wid}/notifications`);
  assert.ok(notes.data.notifications.some((n: any) => n.title.startsWith('New order #1001')));
});

test('a complaint is handed to a human and the AI stays quiet', async () => {
  script = [
    toolUse('request_human', { reason: 'refund request', summary: 'Rina wants a refund for order #1001.' }),
    reply('I have passed this to our team. Someone will reply shortly.'),
  ];
  await widgetSay('The dress tore after one wash, I want a refund!');
  await waitFor(async () => (await businessMessages()).length >= 5);
  const list = await owner.req('GET', `/api/w/${wid}/conversations?filter=needs_human`);
  assert.equal(list.data.conversations.length, 1);
  const conv = list.data.conversations[0];
  assert.equal(conv.aiPaused, true);

  const calls = claudeRequests.length;
  await widgetSay('Hello?? Anyone there?');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(claudeRequests.length, calls, 'paused conversation must not call the AI');

  // A team member answers from the inbox.
  const sent = await owner.req('POST', `/api/w/${wid}/conversations/${conv.id}/messages`, { text: 'Hi Rina, so sorry! We will replace it today.' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const detail = await owner.req('GET', `/api/w/${wid}/conversations/${conv.id}`);
  assert.equal(detail.data.conversation.needsHuman, false);
  assert.equal(detail.data.messages.at(-1).sender, 'human');
});

test('Messenger: signed webhook in, AI reply out through the Send API', async () => {
  const { db, schema, crypto: c } = mod;
  await db.db.insert(schema.channels).values({
    workspaceId: wid,
    type: 'messenger',
    externalId: 'PAGE1',
    name: 'Nova Fashion Page',
    credentials: c.encryptJson({ accessToken: 'page-token' }),
    config: { pageId: 'PAGE1' },
  });
  const payload = JSON.stringify({
    object: 'page',
    entry: [{ id: 'PAGE1', time: Date.now(), messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid: 'm_1', text: 'price of the red dress?' } }] }],
  });
  const bad = await fetch(`${base}/webhooks/meta`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
  assert.equal(bad.status, 401);

  script = [reply('It is ৳2,400 😊')];
  const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(payload).digest('hex');
  const ok = await fetch(`${base}/webhooks/meta`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' } });
  assert.equal(ok.status, 200);
  // Meta retries webhooks: the duplicate must be ignored.
  await fetch(`${base}/webhooks/meta`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' } });

  const send = await waitFor(async () => graphRequests.find((r) => r.method === 'POST' && r.body?.message?.text === 'It is ৳2,400 😊'));
  assert.equal(send.body!.recipient.id, 'PSID1');
  assert.match(send.url, /\/v26\.0\/PAGE1\/messages/);
  assert.match(send.url, /appsecret_proof=/);
  const convs = await owner.req('GET', `/api/w/${wid}/conversations?channel=messenger`);
  assert.equal(convs.data.conversations.length, 1);
  assert.equal(convs.data.conversations[0].contact.name, 'Messenger Customer');
  const detail = await owner.req('GET', `/api/w/${wid}/conversations/${convs.data.conversations[0].id}`);
  assert.equal(detail.data.messages.filter((m: any) => m.direction === 'in').length, 1);
  assert.equal(detail.data.messages.at(-1).status, 'sent');

  // Verification handshake.
  const v = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await v.text(), '42');
});

test('Messenger: a reply sent from the Business Suite inbox pauses the AI', async () => {
  const payload = JSON.stringify({
    object: 'page',
    entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, timestamp: Date.now(), message: { mid: 'm_echo', text: 'Owner here!', is_echo: true } }] }],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(payload).digest('hex');
  await fetch(`${base}/webhooks/meta`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig } });
  const conv = await waitFor(async () => {
    const r = await owner.req('GET', `/api/w/${wid}/conversations?channel=messenger`);
    return r.data.conversations[0]?.aiPaused ? r.data.conversations[0] : null;
  });
  assert.equal(conv.lastMessagePreview, 'Owner here!');
});

test('WhatsApp: inbound message, read receipt + typing, AI reply', async () => {
  const { db, schema, crypto: c } = mod;
  await db.db.insert(schema.channels).values({
    workspaceId: wid,
    type: 'whatsapp',
    externalId: 'PHONE1',
    name: 'Nova WhatsApp',
    credentials: c.encryptJson({ accessToken: 'wa-token' }),
    config: { wabaId: 'WABA1' },
  });
  script = [reply('Hello from Nova Fashion! How can I help?')];
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PHONE1', display_phone_number: '8801700000000' },
              contacts: [{ wa_id: '8801811111111', profile: { name: 'Karim' } }],
              messages: [{ from: '8801811111111', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi' } }],
            },
          },
        ],
      },
    ],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(payload).digest('hex');
  assert.equal((await fetch(`${base}/webhooks/meta`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig } })).status, 200);
  const send = await waitFor(async () => graphRequests.find((r) => r.url.includes('/PHONE1/messages') && r.body?.type === 'text'));
  assert.equal(send.body!.to, '8801811111111');
  assert.equal(send.body!.text.body, 'Hello from Nova Fashion! How can I help?');
  assert.ok(graphRequests.some((r) => r.url.includes('/PHONE1/messages') && r.body?.status === 'read' && r.body?.typing_indicator?.type === 'text'));
  const contacts = await owner.req('GET', `/api/w/${wid}/contacts?q=Karim`);
  assert.equal(contacts.data.contacts[0].phone, '+8801811111111');
});

test('Telegram: webhook needs the secret, AI replies through the Bot API', async () => {
  const { db, schema, crypto: c } = mod;
  const [ch] = await db.db
    .insert(schema.channels)
    .values({
      workspaceId: wid,
      type: 'telegram',
      externalId: '999',
      name: 'Nova Bot',
      credentials: c.encryptJson({ botToken: '999:AAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      config: { webhookSecret: 'tg-secret' },
    })
    .returning();
  const update = { update_id: 1, message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: 'private' }, from: { first_name: 'Tania' }, text: '/start' } };
  const denied = await fetch(`${base}/webhooks/telegram/${ch.id}`, { method: 'POST', body: JSON.stringify(update), headers: { 'content-type': 'application/json' } });
  assert.equal(denied.status, 401);
  script = [reply('Welcome to Nova Fashion!')];
  const ok = await fetch(`${base}/webhooks/telegram/${ch.id}`, {
    method: 'POST',
    body: JSON.stringify(update),
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });
  assert.equal(ok.status, 200);
  const sent = await waitFor(async () => telegramRequests.find((r) => r.method === 'sendMessage'));
  assert.equal(sent.body!.chat_id, '4242');
  assert.equal(sent.body!.text, 'Welcome to Nova Fashion!');
});

test('ManyChat bridge: Facebook/Instagram/WhatsApp without our own Meta app', async () => {
  const created = await owner.req('POST', '/api/auth/workspaces', { name: 'Bridge Shop', businessType: 'ecommerce', timezone: 'Asia/Dhaka', currency: 'BDT' });
  const shop = created.data.id;
  assert.equal((await owner.req('POST', `/api/w/${shop}/channels/manychat`, { apiKey: 'not-the-right-key' })).status, 400);
  const connected = await owner.req('POST', `/api/w/${shop}/channels/manychat`, { apiKey: 'mc-key-123456' });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  const ch = connected.data.channel;
  assert.equal(ch.type, 'manychat');
  assert.equal(ch.name, 'Nova Page');
  assert.equal(ch.config.webhookSecret, undefined);
  const inbound = new URL(ch.inboundUrl).pathname;
  assert.ok(inbound.startsWith(`/webhooks/manychat/${ch.id}/`) && inbound.split('/').pop()!.length >= 20, inbound);

  // Reconnecting keeps the URL already pasted into ManyChat.
  const again = await owner.req('POST', `/api/w/${shop}/channels/manychat`, { apiKey: 'mc-key-123456' });
  assert.equal(again.data.channel.inboundUrl, ch.inboundUrl);

  const payload = { subscriber_id: '17000000000000123', platform: 'instagram', name: 'Rina', text: 'Do you have red dresses?', email: '{{Email}}' };
  const post = (url: string) => fetch(base + url, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  assert.equal((await post(`/webhooks/manychat/${ch.id}/wrong-secret`)).status, 401);
  script = [reply('Yes! We have three red dresses.')];
  const ok = await post(inbound);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const sent = await waitFor(async () => manychatRequests.find((r) => r.url.endsWith('/fb/sending/sendContent')));
  // The id goes out as an exact JSON number, not rounded by JavaScript.
  assert.ok(sent.raw.includes('"subscriber_id":17000000000000123'), sent.raw);
  const body = JSON.parse(sent.raw.replace(/"subscriber_id":\d+/, '"subscriber_id":0'));
  assert.equal(body.data.version, 'v2');
  assert.equal(body.data.content.type, 'instagram');
  assert.deepEqual(body.data.content.messages, [{ type: 'text', text: 'Yes! We have three red dresses.' }]);

  const contacts = await owner.req('GET', `/api/w/${shop}/contacts?q=Rina`);
  assert.equal(contacts.data.contacts.length, 1);
  assert.equal(contacts.data.contacts[0].email, null, 'unfilled ManyChat placeholders are ignored');
});

test('a salon books a real free slot through the playground', async () => {
  const created = await owner.req('POST', '/api/auth/workspaces', { name: 'Glow Salon', businessType: 'services', timezone: 'Asia/Dhaka', currency: 'BDT' });
  assert.equal(created.status, 201);
  const salon = created.data.id;
  const ws = (await owner.req('GET', `/api/w/${salon}`)).data.workspace;
  assert.equal(ws.booking.enabled, true);
  await owner.req('PATCH', `/api/w/${salon}/settings`, { booking: { ...ws.booking, minNoticeMinutes: 0 } });
  const svc = await owner.req('POST', `/api/w/${salon}/catalog`, { type: 'service', name: 'Haircut', price: 800, durationMinutes: 45 });
  const serviceId = svc.data.item.id;
  const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
  let slot = '';
  script = [
    toolUse('check_availability', { date: tomorrow, days: 3, service_id: serviceId }),
    toolUse('book_appointment', (body) => {
      const days = lastToolResult(body) as { date: string; free_times: string[] | string }[];
      const day = days.find((d) => Array.isArray(d.free_times) && d.free_times.length)!;
      slot = (day.free_times as string[])[0];
      return { service_id: serviceId, date: day.date, time: slot, customer_name: 'Mitu', phone: '01900000000' };
    }),
    (body) => reply(`Booked! Your booking number is #${lastToolResult(body).booking_number}.`)(body),
  ];
  const r = await owner.req('POST', `/api/w/${salon}/playground/message`, { text: 'Can I get a haircut in the next few days?' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.messages.at(-1).text, 'Booked! Your booking number is #101.');
  assert.deepEqual(
    r.data.debug.toolCalls.map((t: any) => t.name),
    ['check_availability', 'book_appointment'],
  );
  // The booked slot is no longer offered.
  const booking = (await mod.db.db.select().from(mod.schema.bookings))[0];
  assert.equal(booking.isTest, true);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(booking.startAt);
  const avail = await owner.req('GET', `/api/w/${salon}/bookings/availability?date=${date}&days=1&serviceId=${serviceId}`);
  assert.ok(!avail.data.days[0].slots.includes(slot));
  // Test data stays out of the analytics.
  const overview = await owner.req('GET', `/api/w/${salon}/analytics/overview?days=7`);
  assert.equal(overview.data.stats.bookings, 0);
});

test('analytics and reports reflect real activity', async () => {
  const overview = await owner.req('GET', `/api/w/${wid}/analytics/overview?days=7`);
  assert.equal(overview.status, 200);
  const s = overview.data.stats;
  assert.equal(s.orders, 1);
  assert.equal(s.revenue, 2460);
  assert.equal(s.handoffs, 1);
  assert.ok(s.newConversations >= 4);
  assert.equal(overview.data.series.length, 7);
  assert.ok(overview.data.items.mostAskedAbout.some((i: any) => i.name === 'Red Floral Dress'));
  script = [reply('## Highlights\n- 1 order worth ৳2,460')];
  const rep = await owner.req('POST', `/api/w/${wid}/reports/generate`, { period: 'daily' });
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  assert.match(rep.data.report.summary, /Highlights/);
});

test('tenants are isolated and the admin console is protected', async () => {
  const other = new Client();
  await other.req('POST', '/api/auth/signup', { name: 'Other', email: 'other@test.dev', password: 'password123', businessName: 'Other Shop' });
  assert.equal((await other.req('GET', `/api/w/${wid}/orders`)).status, 404);
  assert.equal((await other.req('GET', '/api/admin/workspaces')).status, 403);
  const admin = new Client();
  await admin.req('POST', '/api/auth/signup', { name: 'Admin', email: 'admin@test.dev', password: 'password123', businessName: 'HQ' });
  const list = await admin.req('GET', '/api/admin/workspaces');
  assert.equal(list.status, 200);
  assert.ok(list.data.workspaces.length >= 3);
  const changed = await admin.req('PATCH', `/api/admin/workspaces/${wid}`, { plan: 'growth' });
  assert.equal(changed.data.workspace.plan, 'growth');
});

test('the admin sets clients up by hand: no client info, optional login, invite-only mode', async () => {
  const admin = new Client();
  assert.equal((await admin.req('POST', '/api/auth/login', { email: 'admin@test.dev', password: 'password123' })).status, 200);

  // Only super admins can add clients.
  const other = new Client();
  await other.req('POST', '/api/auth/login', { email: 'other@test.dev', password: 'password123' });
  assert.equal((await other.req('POST', '/api/admin/clients', { businessName: 'Sneaky' })).status, 403);

  // Business name + type is all it takes. The admin owns it; there is no client account at all.
  const made = await admin.req('POST', '/api/admin/clients', { businessName: 'Rina Boutique', businessType: 'ecommerce', currency: 'bdt' });
  assert.equal(made.status, 201);
  assert.equal(made.data.login, null);
  assert.match(made.data.chatUrl, /\/chat\/wc_/);
  const clientWid: string = made.data.workspace.id;
  assert.equal((await fetch(made.data.chatUrl.replace(/^https?:\/\/[^/]+/, base))).status, 200);
  const opened = await admin.req('GET', `/api/w/${clientWid}`);
  assert.equal(opened.data.workspace.name, 'Rina Boutique');
  assert.equal(opened.data.workspace.currency, 'BDT');

  // Give the client a login afterwards: a password is generated, and it works.
  const given = await admin.req('POST', `/api/admin/workspaces/${clientWid}/login`, { email: 'Rina@Example.com' });
  assert.equal(given.status, 200);
  assert.equal(given.data.login.email, 'rina@example.com');
  assert.ok(given.data.login.password.length >= 10);
  const rina = new Client();
  const signedIn = await rina.req('POST', '/api/auth/login', { email: 'rina@example.com', password: given.data.login.password });
  assert.equal(signedIn.status, 200);
  assert.equal((await rina.req('GET', `/api/w/${clientWid}`)).status, 200);
  assert.equal((await rina.req('GET', `/api/w/${wid}`)).status, 404, 'a client sees only their own business');

  // Resetting the password locks out the old one.
  const reset = await admin.req('POST', `/api/admin/workspaces/${clientWid}/login`, { email: 'rina@example.com', resetPassword: true });
  assert.notEqual(reset.data.login.password, given.data.login.password);
  assert.equal((await new Client().req('POST', '/api/auth/login', { email: 'rina@example.com', password: given.data.login.password })).status, 401);
  assert.equal((await new Client().req('POST', '/api/auth/login', { email: 'rina@example.com', password: reset.data.login.password })).status, 200);

  // Creating a client with a login in one step, and seeing it in the list as the client's, not the admin's.
  const both = await admin.req('POST', '/api/admin/clients', { businessName: 'Glow Clinic', businessType: 'services', login: { email: 'glow@example.com' } });
  assert.equal(both.status, 201);
  assert.ok(both.data.login.password);
  const list = await admin.req('GET', '/api/admin/workspaces?q=Glow');
  assert.equal(list.data.workspaces[0].owner_email, 'glow@example.com');
  assert.equal(list.data.workspaces[0].owner_is_admin, false);
  assert.ok(list.data.workspaces[0].chat_key);

  // Invite-only mode: strangers can't sign up, but your own admin email still can.
  const { config } = await import('../src/config.ts');
  (config as { signupsEnabled: boolean }).signupsEnabled = false;
  try {
    assert.equal((await new Client().req('GET', '/api/auth/app')).data.signupsEnabled, false);
    const blocked = await new Client().req('POST', '/api/auth/signup', { name: 'Eve', email: 'eve@test.dev', password: 'password123', businessName: 'Eve Shop' });
    assert.equal(blocked.status, 403);
  } finally {
    (config as { signupsEnabled: boolean }).signupsEnabled = true;
  }
});
