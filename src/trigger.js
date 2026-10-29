// Pure decision helpers for the poll loop: message text extraction, trigger
// and confirmation classification, and cursor comparison. No I/O, no imports.

const CONFIRM_WORDS = new Set(['确认', '确认查询', '同意', '开始查询', '开始', '1']);
const CANCEL_WORDS = new Set(['取消', '取消查询', '忽略', '不用']);

// Real lark-cli items carry the JSON payload at `body.content`; older fixtures
// used a top-level `content`. Accept both, and never throw on bad JSON.
function parseBody(msg) {
  const raw = msg?.body?.content ?? msg?.content ?? '';
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractPlainText(msg) {
  const data = parseBody(msg);
  if (!data || typeof data !== 'object') return '';
  if (msg.msg_type === 'text') return typeof data.text === 'string' ? data.text : '';
  if (msg.msg_type === 'post') {
    // The message API returns `{title, content}`; webhook-era fixtures wrap the
    // same payload per locale (`{zh_cn: {title, content}}`).
    const blocks = Array.isArray(data.content)
      ? data.content
      : Object.values(data).flatMap((locale) => locale?.content ?? []);
    return blocks
      .flat()
      .filter((node) => node?.tag === 'text' || node?.tag === 'md')
      .map((node) => node.text ?? '')
      .join('');
  }
  return '';
}

// Real resource keys look like `img_v3_02abc...`; anything else is not a key we
// are willing to hand to lark-cli (and to the shell, on Windows).
const IMAGE_KEY = /^img_[A-Za-z0-9_-]{1,200}$/;

function collectImageKeys(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.tag === 'img' && typeof node.image_key === 'string' && IMAGE_KEY.test(node.image_key)) {
    out.push(node.image_key);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) collectImageKeys(item, out);
    } else if (value && typeof value === 'object') {
      collectImageKeys(value, out);
    }
  }
}

// Screenshots are the only attachment the analysis can read. An image message
// carries one key; a rich-text post can carry several, nested in its paragraphs.
export function extractImageKeys(msg) {
  if (msg?.msg_type === 'image') {
    const key = parseBody(msg)?.image_key;
    return typeof key === 'string' && IMAGE_KEY.test(key) ? [key] : [];
  }
  if (msg?.msg_type === 'post') {
    const data = parseBody(msg);
    if (!data || typeof data !== 'object') return [];
    const keys = [];
    collectImageKeys(data, keys);
    return [...new Set(keys)];
  }
  return [];
}

export function isTrigger(text, keyword) {
  if (!text) return false;
  return Boolean(keyword && text.includes(keyword))
    || /\buid\s*[:：]\s*\d+(?![\w.])/i.test(text)
    || text.includes('玩家反馈')
    || text.includes('麻烦有时间看看');
}

// Where the user @-mentions someone, the text body holds a placeholder such as
// `@_user_1` and the real name lives in `mentions[]`. Either source triggers.
export function hasTrigger(msg, keyword) {
  if (isTrigger(extractPlainText(msg), keyword)) return true;
  if (!keyword) return false;
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
  return mentions.some(
    (mention) => typeof mention?.name === 'string' && mention.name.includes(keyword),
  );
}

export function classifyConfirmation(text) {
  const normalized = String(text ?? '').replace(/\s+/g, '');
  if (CONFIRM_WORDS.has(normalized)) return 'confirm';
  if (CANCEL_WORDS.has(normalized)) return 'cancel';
  return null;
}

export function timeOf(msg) {
  const n = Number(msg?.create_time);
  return Number.isFinite(n) ? n : 0;
}

export function isUnseen(lastSeen, msg) {
  const t = timeOf(msg);
  if (t !== lastSeen.createTimeMs) return t > lastSeen.createTimeMs;
  return String(msg.message_id) > String(lastSeen.messageId);
}
