// Canned reply notices and the analysis result formatter. Pure string helpers:
// no imports, no I/O.

export const CONFIRM_PROMPT = '收到。请任意群成员在 10 分钟内回复「确认」开始查询，回复「取消」放弃。';
export const TIMEOUT_NOTICE = '查询请求已超时，如需分析请重新发起。';
export const CANCELLED_NOTICE = '查询已取消。';
export const BUSY_NOTICE = '已有查询待确认，请先确认或取消。';

// Single source of the provenance footer, so formatResult and clipForReply
// cannot drift apart on its wording. `provenance` is what was analysed, e.g.
// `feature/Medal-Challenge@b7540c6+22` (22 uncommitted files) or `master@a1b2c3d`
// for a clean clone; it comes from the repo layer, so the footer never guesses.
function footer(provenance, confirmer) {
  return `—— 蔡龙自动分析 · ${provenance} · 由 ${confirmer} 确认`;
}

export function formatResult({ analysis, provenance, confirmer }) {
  return `${String(analysis ?? '').trim()}\n\n${footer(provenance, confirmer)}`;
}

export function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// Clips the analysis body only, so provenance survives even when the reply is
// too long; if maxChars is smaller than the footer, the reply is just the
// footer and may exceed maxChars rather than lose attribution. The blank line
// before the footer is part of the budget, so a clipped reply never runs the
// last sentence straight into the em dashes.
export function clipForReply({ analysis, provenance, confirmer, maxChars }) {
  const full = formatResult({ analysis, provenance, confirmer });
  if (full.length <= maxChars) return { text: full, truncated: false, full };
  const foot = footer(provenance, confirmer);
  const budget = maxChars - foot.length - 2;
  const body = budget > 0 ? String(analysis ?? '').trim().slice(0, budget) : '';
  return { text: body ? `${body}\n\n${foot}` : foot, truncated: true, full };
}
