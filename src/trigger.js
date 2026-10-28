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
    const blocks = Object.values(data).flatMap((locale) => locale?.content ?? []);
    return blocks
      .flat()
      .filter((node) => node?.tag === 'text' || node?.tag === 'md')
      .map((node) => node.text ?? '')
      .join('');
  }
  return '';
}

export function isTrigger(text, keyword) {
  if (!text || !keyword) return false;
  return text.includes(keyword);
}

// Where the user @-mentions someone, the text body holds a placeholder such as
// `@_user_1` and the real name lives in `mentions[]`. Either source triggers.
export function hasTrigger(msg, keyword) {
  if (!keyword) return false;
  if (isTrigger(extractPlainText(msg), keyword)) return true;
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
