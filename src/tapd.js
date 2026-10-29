// TAPD OpenAPI: the only place that turns a finished 蔡龙 analysis into a bug ticket.
//
// The ticket is a one-way write, so the module needs no state of its own. Free-form
// group text goes out as an x-www-form-urlencoded body over fetch: unlike the npm
// `.cmd` shims in src/runner.js it never meets cmd.exe, so no quoting rules apply —
// length is the only thing that has to be bounded.

const SECTIONS = { 结论: 'conclusion', 定位: 'location', 依据: 'evidence', 建议: 'advice', 复现: 'repro' };
const EMPTY = Object.freeze({ conclusion: '', repro: '', location: '', evidence: '', advice: '' });
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 6000;
// The group question is pasted into two sections (【问题描述】 and 【实际结果】), so an
// unbounded one costs 2x its length and — because the 6000 clip can only cut the tail —
// a long pasted log would evict 【蔡龙自动分析】 and the provenance footer from a payload
// that still looks valid to the caller. 1200 per section is already twice what a human
// ever sees in the group card (src/cards.js shows the first 600), so real questions are
// never touched; it leaves the remaining ~3600 for the five section labels, the 2 repro
// steps, the analysis block (the prompt contract caps the whole analysis at 300 字) and
// the footer, so a well-behaved report fits without the clip firing at all.
const QUESTION_SECTION_LIMIT = 1200;
const CLIPPED_MARK = '（内容过长，已截断）';

function appendLine(target, value) {
  if (value === '') return target;
  return target === '' ? value : `${target}\n${value}`;
}

export function parseAnalysis(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ...EMPTY };
  const parts = { conclusion: '', repro: '', location: '', evidence: '', advice: '' };
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const label = /^【(结论|复现|定位|依据|建议)】/.exec(line)?.[1];
    if (label) {
      current = SECTIONS[label];
      // A repeated label continues its section instead of replacing it: the
      // prompt asks for one step per line under 【复现】, and weaker models
      // answer that by repeating the label.
      parts[current] = appendLine(parts[current], line.slice(label.length + 2).trim());
      continue;
    }
    // Continuation lines only matter inside a section; anything before the first
    // label is model noise and is dropped.
    if (current) parts[current] = appendLine(parts[current], line);
  }
  return parts;
}

export function bugUrl(workspaceId, bugId) {
  return `https://www.tapd.cn/tapd_fe/${workspaceId}/bug/detail/${bugId}`;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

function firstClause(text) {
  return String(text ?? '').split(/[。\n；;]/).map((part) => part.trim()).find((part) => part !== '') ?? '';
}

function steps(repro) {
  const lines = String(repro ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^\d+[.、)]\s*/, '').replace(/^[-*·]\s*/, ''))
    .filter((line) => line !== '')
    .slice(0, 2);
  const usable = lines.length ? lines : ['按【问题描述】里的操作复现'];
  return usable.map((line, index) => `${index + 1}. ${line}`);
}

// Free-form group text, bounded per section so it cannot crowd out the rest of the
// ticket. The marker is its own line: a reader of the ticket then knows the question
// was long rather than garbled by the cut.
function questionSection(question) {
  const text = String(question ?? '').trim();
  if (text === '') return '（无）';
  return text.length > QUESTION_SECTION_LIMIT ? `${text.slice(0, QUESTION_SECTION_LIMIT)}\n${CLIPPED_MARK}` : text;
}

// The analysis block and the provenance footer are what makes the ticket trustworthy,
// so they are appended last and the budget is spent on the scratch text first (same
// shape as clipForReply in src/reply.js). src/reply.js lets the reply overflow the
// budget to keep the attribution; here the 6000 limit is hard, so if the tail alone is
// too long the analysis text shrinks and the footer keeps the last line — cutting an
// over-long model answer is recoverable, an anonymous ticket is not.
function assembleDescription({ body, analysisBlock, foot }) {
  const tail = `${analysisBlock}\n${foot}`;
  const room = DESCRIPTION_LIMIT - tail.length - 2;
  if (room >= 0) {
    const head = clip(body, room);
    return head === '' ? tail : `${head}\n\n${tail}`;
  }
  return `${clip(analysisBlock, Math.max(0, DESCRIPTION_LIMIT - foot.length - 1))}\n${foot}`;
}

export function buildBugPayload({ report, entry, projects = [] }) {
  const parts = parseAnalysis(report.analysis);
  const name = projects.find((project) => project.id === report.projectId)?.name ?? report.projectId;
  const question = questionSection(report.question);
  const images = Array.isArray(report.images) ? report.images : [];
  const body = [
    '【问题描述】', question, '',
    '【操作步骤】', ...steps(parts.repro), '',
    '【预期结果】', '正常', '',
    '【实际结果】', question,
    ...(images.length
      ? [`（另有 ${images.length} 张截图，见飞书群消息 ${report.triggerMessageId}，本单不附带图片）`]
      : []),
  ].join('\n');
  const analysisBlock = [
    '【蔡龙自动分析】',
    `结论：${parts.conclusion || '（无）'}`,
    `定位：${parts.location || '（无）'}`,
    `依据：${parts.evidence || '（无）'}`,
    `建议：${parts.advice || '（无）'}`,
  ].join('\n');
  const foot = `—— 蔡龙自动分析 · ${report.provenance ?? ''} · 由 ${report.confirmer ?? ''} 确认`;

  return {
    workspace_id: String(entry.workspaceId),
    // Truncation runs after the clause is taken, so a long conclusion can never
    // push the project prefix out of the title.
    title: clip(`[${name}] ${firstClause(parts.conclusion)}`, TITLE_LIMIT),
    // Last-resort guard only: assembleDescription already hands back something that
    // fits, so this clip is a no-op unless a future edit breaks the budget maths.
    description: clip(assembleDescription({ body, analysisBlock, foot }), DESCRIPTION_LIMIT),
    ...entry.fields,
  };
}
