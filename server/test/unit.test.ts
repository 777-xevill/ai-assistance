import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assistance-unit-'));

const time = await import('../src/lib/time.ts');
const text = await import('../src/lib/text.ts');
const { tokenize } = await import('../src/services/catalog.ts');
const { toBubbles } = await import('../src/ai/agent.ts');
const { buildSystemPrompt } = await import('../src/ai/prompt.ts');
const { defaultSettings } = await import('../src/lib/defaults.ts');

test('zonedToUtc converts local wall-clock times', () => {
  assert.equal(time.zonedToUtc('2026-10-28', '10:00', 'Asia/Dhaka').toISOString(), '2026-10-28T04:00:00.000Z');
  assert.equal(time.zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(time.zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(time.zonedToUtc('2026-10-28', '00:00', 'UTC').toISOString(), '2026-10-28T00:00:00.000Z');
});

test('local date helpers', () => {
  const d = new Date('2026-10-27T20:30:00Z'); // 02:30 on the 28th in Dhaka
  assert.equal(time.localDateStr(d, 'Asia/Dhaka'), '2026-10-28');
  assert.equal(time.localTimeStr(d, 'Asia/Dhaka'), '02:30');
  assert.equal(time.addDaysStr('2026-12-31', 1), '2027-01-01');
  assert.equal(time.weekdayOfDateStr('2026-10-28'), 'wed');
  const hours = { mon: [], tue: [{ open: '09:00', close: '18:00' }], wed: [], thu: [], fri: [], sat: [], sun: [] };
  assert.equal(time.isOpenAt(hours, 'UTC', new Date('2026-10-27T10:00:00Z')), true);
  assert.equal(time.isOpenAt(hours, 'UTC', new Date('2026-10-27T18:00:00Z')), false);
});

test('CSV parsing handles quotes, commas and newlines', () => {
  const rows = text.parseCsv('name,price,description\r\n"Dress, red",1200,"Line one\nLine ""two"""\nShirt,500,\n');
  assert.deepEqual(rows, [
    ['name', 'price', 'description'],
    ['Dress, red', '1200', 'Line one\nLine "two"'],
    ['Shirt', '500', ''],
  ]);
  assert.equal(text.toCsv([['a,b', 'c"d', null]]), '"a,b","c""d",');
});

test('long replies are split at natural boundaries', () => {
  const long = 'First sentence here. '.repeat(30).trim();
  const parts = text.splitForChannel(long, 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(' '), long);
});

test('chat bubbles: blank lines split, overflow merges into the last bubble', () => {
  assert.deepEqual(toBubbles('Hi!\n\nHow can I help?'), ['Hi!', 'How can I help?']);
  assert.deepEqual(toBubbles('a\n\nb\n\nc\n\nd'), ['a', 'b', 'c\n\nd']);
});

test('formatting per channel', () => {
  assert.equal(text.formatForChannel('**Total:** 500', 'whatsapp'), '*Total:* 500');
  assert.equal(text.formatForChannel('**Total:** 500', 'messenger'), 'Total: 500');
  assert.equal(text.formatForChannel('See [our site](https://x.com)', 'instagram'), 'See our site: https://x.com');
});

test('tokenizer keeps Bangla words intact and stems English plurals', () => {
  assert.deepEqual(tokenize('লাল শাড়ি'), ['লাল', 'শাড়ি']);
  assert.deepEqual(tokenize('Red Dresses for the party'), ['red', 'dress', 'party']);
});

test('system prompt is deterministic and reflects the business setup', () => {
  const settings = defaultSettings('ecommerce');
  const ws = {
    id: 'w1',
    name: 'Nova Fashion',
    businessType: 'ecommerce',
    timezone: 'Asia/Dhaka',
    currency: 'BDT',
    knowledgeVersion: 3,
    ...settings,
    commerce: { ...settings.commerce, deliveryZones: [{ id: 'dhaka', name: 'Inside Dhaka', fee: 60 }] },
  } as any;
  const items = [
    { id: 'i1', type: 'product', name: 'Red Dress', price: 2400, salePrice: null, category: 'Dresses', durationMinutes: null },
  ] as any;
  const faqs = [{ question: 'Is COD available?', answer: 'Yes.' }] as any;
  const a = buildSystemPrompt(ws, items, faqs);
  const b = buildSystemPrompt(ws, items, faqs);
  assert.equal(a.system, b.system, 'identical input must give byte-identical prompts (prompt caching)');
  assert.match(a.system, /You are Maya, the customer chat assistant for Nova Fashion/);
  assert.match(a.system, /## Taking orders/);
  assert.doesNotMatch(a.system, /## Booking appointments/);
  assert.match(a.system, /Inside Dhaka \(id dhaka\): ৳60/);
  assert.match(a.system, /\[i1\] Red Dress — ৳2,400 — Dresses/);
  assert.match(a.system, /Q: Is COD available\?\nA: Yes\./);
  assert.doesNotMatch(a.system, /\d{4}-\d{2}-\d{2}T/, 'no timestamps in the cached prompt');
});
