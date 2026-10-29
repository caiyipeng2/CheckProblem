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

export function buildBugPayload({ report, entry, projects = [] }) {
  const parts = parseAnalysis(report.analysis);
  const name = projects.find((project) => project.id === report.projectId)?.name ?? report.projectId;
  const question = String(report.question ?? '').trim();
  const images = Array.isArray(report.images) ? report.images : [];
  const description = [
    '【问题描述】', question || '（无）', '',
    '【操作步骤】', ...steps(parts.repro), '',
    '【预期结果】', '正常', '',
    '【实际结果】', question || '（无）',
    ...(images.length
      ? [`（另有 ${images.length} 张截图，见飞书群消息 ${report.triggerMessageId}，本单不附带图片）`]
      : []),
    '',
    '【蔡龙自动分析】',
    `结论：${parts.conclusion || '（无）'}`,
    `定位：${parts.location || '（无）'}`,
    `依据：${parts.evidence || '（无）'}`,
    `建议：${parts.advice || '（无）'}`,
    `—— 蔡龙自动分析 · ${report.provenance ?? ''} · 由 ${report.confirmer ?? ''} 确认`,
  ].join('\n');

  return {
    workspace_id: String(entry.workspaceId),
    // Truncation runs after the clause is taken, so a long conclusion can never
    // push the project prefix out of the title.
    title: clip(`[${name}] ${firstClause(parts.conclusion)}`, TITLE_LIMIT),
    description: clip(description, DESCRIPTION_LIMIT),
    ...entry.fields,
  };
}
