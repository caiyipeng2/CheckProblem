// One-shot chat completion. The agent CLIs explore the repository themselves,
// which on a multi-gigabyte Unity project costs tens of minutes; a plain request
// over the pre-search digest answers in seconds. Read-only by construction:
// nothing here can touch the repo.

import { readFileSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY';

// The key comes from an environment variable or, if that is not set, from a
// file the operator writes themselves — so a secret never has to be pasted
// into a chat transcript or committed to config.
export function resolveApiKey({
  apiKeyEnv = DEFAULT_KEY_ENV,
  apiKeyFile,
  env = process.env,
  readFile = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const fromEnv = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  if (!apiKeyFile) return undefined;
  try {
    const fromFile = readFile(apiKeyFile).trim();
    return fromFile === '' ? undefined : fromFile;
  } catch {
    return undefined;
  }
}

export async function askChat({
  prompt,
  baseUrl,
  model,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!baseUrl) throw new Error('chat 引擎缺少 baseUrl');
  if (!model) throw new Error('chat 引擎缺少 model');
  if (!apiKey) throw new Error(`chat 引擎缺少 API Key（模型 ${model}）`);
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有可用的 fetch');

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`${model} 返回 HTTP ${res.status}: ${raw.trim().slice(-300)}`);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${model} 返回了非 JSON 响应`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error(`${model} 返回空内容`);
    }
    return { text: content.trim() };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${model} 超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}