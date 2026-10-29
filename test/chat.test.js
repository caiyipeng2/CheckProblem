import test from 'node:test';
import assert from 'node:assert/strict';
import { askChat } from '../src/chat.js';

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const reply = (content) => ok({ choices: [{ message: { content } }] });

test('askChat posts one message and returns the answer', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return reply('  【结论】配置缺失  ');
  };

  const res = await askChat({
    prompt: '问题：奖励没到账',
    baseUrl: 'https://api.deepseek.com/',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    fetchImpl,
  });

  assert.equal(res.text, '【结论】配置缺失');
  assert.equal(seen.url, 'https://api.deepseek.com/chat/completions', 'trailing slash must not double');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: '问题：奖励没到账' }]);
});

test('askChat refuses to call without a key or endpoint', async () => {
  await assert.rejects(() => askChat({ prompt: 'p', baseUrl: 'https://x', model: 'm' }), /API Key/);
  await assert.rejects(() => askChat({ prompt: 'p', model: 'm', apiKey: 'k' }), /baseUrl/);
  await assert.rejects(() => askChat({ prompt: 'p', baseUrl: 'https://x', apiKey: 'k' }), /model/);
});

test('askChat surfaces an HTTP error with the tail of the body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid api key"}}',
  });
  await assert.rejects(
    () => askChat({ prompt: 'p', baseUrl: 'https://x', model: 'deepseek-chat', apiKey: 'k', fetchImpl }),
    /HTTP 401.*invalid api key/s,
  );
});

test('askChat rejects an empty or malformed answer', async () => {
  await assert.rejects(
    () => askChat({ prompt: 'p', baseUrl: 'https://x', model: 'm', apiKey: 'k', fetchImpl: async () => reply('   ') }),
    /空内容/,
  );
  await assert.rejects(
    () =>
      askChat({
        prompt: 'p',
        baseUrl: 'https://x',
        model: 'm',
        apiKey: 'k',
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
      }),
    /非 JSON/,
  );
});

test('askChat reports a timeout instead of hanging', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  await assert.rejects(
    () => askChat({ prompt: 'p', baseUrl: 'https://x', model: 'm', apiKey: 'k', timeoutMs: 20, fetchImpl }),
    /超时（0 秒）/,
  );
});
test('resolveApiKey prefers the environment and falls back to a file', async () => {
  const { resolveApiKey } = await import('../src/chat.js');
  assert.equal(resolveApiKey({ apiKeyEnv: 'K', env: { K: ' from-env ' } }), 'from-env');
  assert.equal(
    resolveApiKey({ apiKeyEnv: 'K', apiKeyFile: 'f', env: {}, readFile: () => 'from-file\n' }),
    'from-file',
  );
  assert.equal(resolveApiKey({ apiKeyEnv: 'K', env: {}, readFile: () => '  \n' }), undefined);
  assert.equal(
    resolveApiKey({
      apiKeyEnv: 'K',
      apiKeyFile: 'f',
      env: {},
      readFile: () => {
        throw new Error('ENOENT');
      },
    }),
    undefined,
  );
});

test('askChat sends screenshots as image parts after the prompt', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'chat-img-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const path = join(dir, 'image-1.png');
  writeFileSync(path, bytes);

  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return reply('【结论】配置缺失');
  };

  await askChat({
    prompt: '看截图',
    images: [{ path, mime: 'image/png' }],
    baseUrl: 'https://x',
    model: 'deepseek-flash',
    apiKey: 'sk-test',
    fetchImpl,
  });

  const content = JSON.parse(seen.init.body).messages[0].content;
  assert.deepEqual(content, [
    { type: 'text', text: '看截图' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } },
  ]);
});

test('askChat reports an unreadable screenshot instead of sending a broken request', async () => {
  let called = 0;
  await assert.rejects(
    () =>
      askChat({
        prompt: 'p',
        images: [{ path: 'C:/definitely/missing.png', mime: 'image/png' }],
        baseUrl: 'https://x',
        model: 'm',
        apiKey: 'k',
        fetchImpl: async () => {
          called += 1;
          return reply('x');
        },
      }),
    /截图/,
  );
  assert.equal(called, 0);
});
