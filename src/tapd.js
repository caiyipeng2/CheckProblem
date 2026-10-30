// TAPD OpenAPI: the only place that turns a finished 蔡龙 analysis into a bug ticket.
//
// The ticket is a one-way write, so the module needs no state of its own. Free-form
// group text goes out as an x-www-form-urlencoded body over fetch: unlike the npm
// `.cmd` shims in src/runner.js it never meets cmd.exe, so no quoting rules apply —
// length is the only thing that has to be bounded.
//
// createTapdClient below is this service's single HTTP exit to TAPD. It authenticates
// with a personal token read from a file the operator keeps outside the repository,
// sends only to https://api.tapd.cn, and never lets the token reach a log line or an
// error message: a failure carries only the HTTP status and TAPD's own `info` text.

import { readFileSync } from 'node:fs';
import { resolveApiKey } from './chat.js';

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
const DEFAULT_BASE_URL = 'https://api.tapd.cn';
const DEFAULT_TIMEOUT_MS = 15_000;
const INFO_LIMIT = 160;

// A failure raised before the HTTP request exists is provably not on TAPD's
// side, so the card may tell the operator a retry is safe. Everything that
// fails at or after the request (timeout, 5xx, reset) stays unclassified: with
// no idempotency key and no delete API, the write may already have landed.
function unsentError(message) {
  const err = new Error(message);
  err.unsent = true;
  return err;
}

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

// TAPD renders `description` as HTML, so a bare newline collapses the whole
// ticket body into one run-on paragraph. Every template line leaves as a break,
// and free-form text (group chatter, model output, a display name) is escaped
// first so it cannot inject markup into another team's tracker.
const BR = '<br />';
const BLANK = '<br /><br />';

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function line(value) {
  return esc(value).replace(/\r?\n/g, BR);
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
  const tail = `${analysisBlock}${BR}${foot}`;
  const room = DESCRIPTION_LIMIT - tail.length - BLANK.length;
  if (room >= 0) {
    const head = clip(body, room);
    return head === '' ? tail : `${head}${BLANK}${tail}`;
  }
  return `${clip(analysisBlock, Math.max(0, DESCRIPTION_LIMIT - foot.length - BR.length))}${BR}${foot}`;
}

export function buildBugPayload({ report, entry, projects = [] }) {
  const parts = parseAnalysis(report.analysis);
  // The analysis is the reason this ticket exists. A report whose model ignored
  // the five-section contract parses to all-empty strings, which would file a
  // `[项目] ` ticket whose analysis block is （无） — and the operator, who never
  // saw that text on the card, would not notice. Refuse before a request exists
  // instead of writing junk into another team's tracker.
  if (!parts.conclusion && !parts.repro && !parts.location && !parts.evidence && !parts.advice) {
    throw unsentError('tapd: 分析内容无法解析（缺少五段结构）');
  }
  const name = projects.find((project) => project.id === report.projectId)?.name ?? report.projectId;
  const question = questionSection(report.question);
  const images = Array.isArray(report.images) ? report.images : [];
  const body = [
    ...(entry.device ? [`使用机型：${line(entry.device)}`, ''] : []),
    '【问题描述】', line(question), '',
    '【操作步骤】', ...steps(parts.repro).map(line), '',
    '【预期结果】', '正常', '',
    '【实际结果】', line(question),
    ...(images.length
      ? [line(`（另有 ${images.length} 张截图，见飞书群消息 ${report.triggerMessageId}，本单不附带图片）`)]
      : []),
  ].join(BR);
  const analysisBlock = [
    '【蔡龙自动分析】',
    line(`结论：${parts.conclusion || '（无）'}`),
    line(`定位：${parts.location || '（无）'}`),
    line(`依据：${parts.evidence || '（无）'}`),
    line(`建议：${parts.advice || '（无）'}`),
  ].join(BR);
  const foot = `—— 蔡龙自动分析 · ${esc(report.provenance ?? '')} · 由 ${esc(report.confirmer ?? '')} 确认`;

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

// One secret-file reader for the whole service: src/chat.js already strips the
// "key：" prefix an operator tends to type, and returns undefined instead of
// throwing so the caller decides what a missing credential means.
export function createTapdClient({
  tokenFile,
  baseUrl = DEFAULT_BASE_URL,
  request = globalThis.fetch,
  readFile = (file) => readFileSync(file, 'utf8'),
  log = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!tokenFile) throw new Error('tapd: tokenFile is required');
  if (!/^https:\/\/api\.tapd\.cn(\/.*)?$/.test(baseUrl)) {
    throw new Error(`tapd: baseUrl must be https://api.tapd.cn, got ${String(baseUrl).slice(0, 60)}`);
  }
  if (typeof request !== 'function') throw new Error('tapd: request is required');

  return {
    async createBug(payload, { tokenFile: override } = {}) {
      const token = resolveApiKey({ apiKeyEnv: '', apiKeyFile: override ?? tokenFile, readFile });
      if (!token) throw unsentError('tapd: 令牌文件不可读或为空');

      const res = await request(`${baseUrl}/bugs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body is a failure, handled below. TAPD answers its unknown
        // routes with an HTML login page, which lands here.
      }
      const bugId = parsed?.data?.Bug?.id;
      if (parsed?.status !== 1 || !bugId) {
        const info = typeof parsed?.info === 'string' ? clip(parsed.info, INFO_LIMIT) : '';
        // The tail keys on the id, not on the info: TAPD answers a write that
        // succeeded but returned no bug with the bland info "success", and a
        // message that only repeats that would leave the operator guessing.
        throw new Error(`tapd: 建单失败（HTTP ${res.status}${info ? ` ${info}` : ''}）${bugId ? '' : ' 未返回缺陷 ID'}`);
      }
      // Only the identifiers: the payload carries the whole description, which is
      // group text and has no business in a log file.
      log?.info?.(`tapd: bug ${bugId} created in workspace ${payload.workspace_id}`);
      return { bugId: String(bugId), url: bugUrl(String(payload.workspace_id), String(bugId)) };
    },
  };
}
