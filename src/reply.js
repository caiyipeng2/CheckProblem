// Canned reply notices and the analysis result formatter. Pure string helpers:
// no imports, no I/O.

export const CONFIRM_PROMPT = '收到。请任意群成员在 10 分钟内回复「确认」开始查询，回复「取消」放弃。';
export const TIMEOUT_NOTICE = '查询请求已超时，如需分析请重新发起。';
export const CANCELLED_NOTICE = '查询已取消。';

// Single source of the provenance footer, so formatResult and clipForReply
// cannot drift apart on its wording.
function footer(commit, confirmer) {
  return `—— 蔡龙自动分析 · master@${commit} · 由 ${confirmer} 确认`;
}

export function formatResult({ analysis, commit, confirmer }) {
  return `${String(analysis ?? '').trim()}\n\n${footer(commit, confirmer)}`;
}

export function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// Clips the analysis body only, so provenance survives even when the reply is
// too long; if maxChars is smaller than the footer, the reply is just the
// footer and may exceed maxChars rather than lose attribution.
export function clipForReply({ analysis, commit, confirmer, maxChars }) {
  const full = formatResult({ analysis, commit, confirmer });
  if (full.length <= maxChars) return { text: full, truncated: false, full };
  const foot = footer(commit, confirmer);
  const body = String(analysis ?? '').trim().slice(0, Math.max(0, maxChars - foot.length));
  return { text: body + foot, truncated: true, full };
}
