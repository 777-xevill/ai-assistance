import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

// A fake Groq server records requests and replays scripted responses.
const requests: any[] = [];
let script: (req: any, n: number) => { status?: number; headers?: Record<string, string>; body: unknown } = () => ({ body: {} });
let server: http.Server;

type Create = typeof import('../src/ai/groq.ts').groqCreate;
let groqCreate: Create;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      requests.push(parsed);
      const r = script(parsed, requests.length);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.DATA_DIR = `${process.env.TMPDIR ?? process.env.TEMP ?? '.'}/groq-test-${process.pid}`;
  ({ groqCreate } = await import('../src/ai/groq.ts'));
});

after(() => server.close());

const ok = (message: object, finish = 'stop') => ({
  body: { id: 'x', model: 'openai/gpt-oss-120b', choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
});

test('translates a tool round-trip to OpenAI format and back', async () => {
  requests.length = 0;
  script = () => ok({ content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_catalog', arguments: '{"query":"kurti"}' } }] }, 'tool_calls');
  const res = await groqCreate({
    model: 'openai/gpt-oss-120b',
    max_tokens: 16000,
    system: [{ type: 'text', text: 'You are Maya.' }],
    tools: [{ name: 'search_catalog', description: 'Search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Do you have kurti?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'prev', name: 'search_catalog', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prev', content: '[]', is_error: true }] },
    ],
  } as any);

  const sent = requests[0];
  assert.equal(sent.model, 'openai/gpt-oss-120b');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[1].content, 'Do you have kurti?');
  assert.equal(sent.messages[2].tool_calls[0].function.arguments, '{"query":"x"}');
  assert.deepEqual(sent.messages[3], { role: 'tool', tool_call_id: 'prev', content: 'Error: []' });
  assert.equal(sent.tools[0].function.name, 'search_catalog');
  assert.equal(sent.tool_choice, 'auto');
  assert.ok(sent.max_completion_tokens <= 6000);

  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content[0], { type: 'tool_use', id: 'call_1', name: 'search_catalog', input: { query: 'kurti' } });
  // Cached prompt tokens are reported separately.
  assert.equal(res.usage.input_tokens, 40);
  assert.equal(res.usage.cache_read_input_tokens, 60);
});

test('photos switch to the vision model and are capped at 3', async () => {
  requests.length = 0;
  script = () => ok({ content: 'Nice photo!' });
  const img = (n: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: `AAAA${n}` } });
  const res = await groqCreate({
    model: 'openai/gpt-oss-120b',
    max_tokens: 1000,
    system: 'sys',
    messages: [{ role: 'user', content: [img(1), img(2), img(3), img(4), { type: 'text', text: 'which one?' }] }],
  } as any);
  const sent = requests[0];
  assert.equal(sent.model, 'qwen/qwen3.8-27b');
  const parts = sent.messages[1].content;
  assert.equal(parts.filter((p: any) => p.type === 'image_url').length, 3);
  assert.match(parts[0].text, /earlier photo/);
  assert.equal(res.stop_reason, 'end_turn');
  assert.deepEqual(res.content, [{ type: 'text', text: 'Nice photo!' }]);
});

test('final round forbids tools and <think> text is stripped', async () => {
  requests.length = 0;
  script = () => ok({ content: '<think>hmm</think>Sure, here you go.' });
  const res = await groqCreate({
    model: 'openai/gpt-oss-120b',
    max_tokens: 1000,
    system: 'sys',
    tools: [{ name: 't', input_schema: { type: 'object' } }],
    tool_choice: { type: 'none' },
    messages: [{ role: 'user', content: 'hi' }],
  } as any);
  assert.equal(requests[0].tool_choice, 'none');
  assert.equal((res.content[0] as any).text, 'Sure, here you go.');
});

test('retries on rate limit and on malformed tool calls', async () => {
  requests.length = 0;
  script = (_req, n) =>
    n === 1
      ? { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached. Please try again in 0s' } } }
      : n === 2
        ? { status: 400, body: { error: { code: 'tool_use_failed', message: 'Failed to call a function' } } }
        : ok({ content: 'Recovered' });
  const res = await groqCreate({ model: 'openai/gpt-oss-120b', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'hi' }] } as any);
  assert.equal(requests.length, 3);
  assert.equal((res.content[0] as any).text, 'Recovered');
});

test('other errors surface with the API message', async () => {
  script = () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  await assert.rejects(
    groqCreate({ model: 'openai/gpt-oss-120b', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'hi' }] } as any),
    /HTTP 401.*Invalid API Key/,
  );
});

test('JSON schema requests use JSON mode with the schema in the prompt', async () => {
  requests.length = 0;
  script = () => ok({ content: '{"items":[]}' });
  await groqCreate({
    model: 'openai/gpt-oss-120b',
    max_tokens: 32000,
    system: 'Extract.',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { items: { type: 'array' } } } } },
    messages: [{ role: 'user', content: 'page text' }],
  } as any);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.match(requests[0].messages[0].content, /JSON Schema/);
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.ok(requests[0].max_completion_tokens <= 16000);
});
