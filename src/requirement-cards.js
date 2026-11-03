// Requirement review cards: pure rendering of a decomposition draft into the
// three views a reviewer works through — the paged story list, one story's
// paged detail, and the confirmation page that names every story that will be
// written.
//
// The rules this file exists to enforce:
//   - 30 KiB is a structural property of paging, not a hope: the list shows a
//     fixed number of stories and clips only what the detail page repeats, and
//     the detail/confirm bodies are packed into segments of PAGE_BODY_BYTES.
//     A single business rule that is longer than one segment is split into
//     numbered pieces so nothing disappears between pages.
//   - Draft text is model and planner content, i.e. untrusted. It is rendered
//     as plain_text only, never interpolated into a markdown element, never
//     turned into an anchor, and URLs are shown as raw text.
//   - Navigation carries no approval meaning. Paging, opening a detail and
//     asking for a target/owner/iteration picker are all separate actions, and
//     批准/延期/排除 stay explicit button presses.
//   - Sensitive targets (workspace, parent story id, iteration, owner) come from
//     server config. They may be displayed, but they are never carried inside a
//     callback value: every callback is exactly
//     { workflow, requestId, draftVersion, action, key, page }.
//   - Reviewer state is read here and written by the coordinator (Task 10). A
//     recorded seen-range whose draftVersion differs from the current draft is
//     void: the card then behaves as if nothing had been read.
//   - The submit and eligibility policy is exported for that coordinator: Task 10
//     imports reviewState / splitEligible / submitGate / missingDetails /
//     confirmSeenOk and runs the same checks server-side before freezeBatch,
//     instead of re-deriving them and risking a gate that disagrees with the card.
//   - An unknown submission outcome is never treated as "safe to resend": the
//     submit button goes cold and 核对/继续 take over.
//
// No filesystem, no network, no lark-cli, no TAPD or Feishu call, no console.

import { MAX_BATCH_STORIES, MAX_KEY, submissionEligibility } from './requirement-draft.js';

// Card transport limit, the same one src/cards.js guards.
export const CARD_MAX_BYTES = 30 * 1024;
// The plan's bounds: five stories per list page, at most 6,000 UTF-8 bytes of
// text per rendered segment.
export const LIST_PAGE_SIZE = 5;
export const PAGE_BODY_BYTES = 6000;
// One rendered line before it has to be split across segments. Well under
// MAX_RULE_TEXT (2000 characters), so a legal rule is often split; the split is
// announced instead of the text being dropped. A line stays inside this bound
// unless the label alone eats the allowance — every label is clipped at its call
// site, so that only happens for a draft that skipped validation, and the
// packing below still measures the real bytes.
export const ATOM_BYTES = 1500;
// List-view clips. The detail card always carries the full text, so a clip here
// is a summary marker, never the only copy. These four are private to this file:
// only the bounds a caller has to respect are exported.
const LIST_TITLE_BYTES = 260;
const LIST_FIELD_BYTES = 240;
const LIST_REASON_LINES = 4;
const DOC_TITLE_BYTES = 200;
// Identifiers (workspace, story ids, types, templates, iterations, owners) are
// short server-config values; they are shown for reading and clipped at this
// bound so no single line can push the card over the transport limit.
const ID_BYTES = 64;

const MODES = new Set(['list', 'detail', 'confirm']);
const MODE_LABELS = { list: '子单清单', detail: '子单详情', confirm: '确认页' };
const DISPOSITION_LABELS = {
  proposed: '待批准', approved: '已批准', deferred: '暂缓', excluded: '已排除',
};
const ITEM_STATUS_LABELS = {
  pending: '未创建', sending: '创建中', created: '已创建',
  unknown: '结果未知', rejected: '被拒绝', blocked: '被依赖阻塞',
};
const REQUEST_STATUS_LABELS = {
  reading: '读取中', analyzing: '分析中', draft: '待审核', review: '待审核',
  awaiting_review: '待审核', submitting: '提交中', running: '提交中',
  completed: '已完成', partial: '部分完成', partially_completed: '部分完成',
  needs_review: '待核对', cancelled: '已取消', failed: '已失败', interrupted: '已中断',
};
// Why the request was last blocked, as a fixed phrase the card can repeat after
// the one-shot notice is gone. The codes are the ones this flow writes; a code
// outside this list is shown verbatim only if it is shape-safe, never as prose.
const BLOCKED_REASON_LABELS = {
  CANCELLED: '拆分已取消',
  SLOT_BUSY: '槽位忙，分析没有开始',
  BATCH_NOT_STARTED: '上一批次没有开始写入，可重新提交',
  SOURCE_CHANGED: '来源文档已变更，需要重新确认',
  READ_INTERRUPTED: '文档读取被中断，可重试',
  ANALYZE_INTERRUPTED: '分析被中断，可重试',
  PROJECT_UNRESOLVED: '目标项目未确定',
};
const BLOCKED_CODE = /^[A-Z][A-Z0-9_]{1,48}$/;
// Anything outside this set fails closed: no button that can change the draft,
// the target or TAPD is enabled.
const WRITABLE_STATUSES = new Set(['draft', 'review', 'awaiting_review', 'needs_review', 'partially_completed']);
const RESOURCE_KINDS = {
  image: '图片', whiteboard: '画板', spreadsheet: '内嵌表', workbook: 'Excel',
  video: '视频', reference: '外链',
};

function coded(code) {
  const error = new Error(`requirement-cards: ${code}`);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

const strBytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8');
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const plain = (content) => ({ tag: 'plain_text', content: String(content ?? '') });
const text = (content) => ({ tag: 'div', text: plain(content) });
const column = (elements, weight = 1) => ({ tag: 'column', width: 'weighted', weight, elements });
const row = (columns) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns });

function makeButton(name, label, value, disabled, type = 'default') {
  return {
    tag: 'button', name, text: plain(label), type, width: 'fill', disabled,
    behaviors: [{ type: 'callback', value }],
  };
}

function buttonRows(entries) {
  const rows = [];
  for (let index = 0; index < entries.length; index += 3) {
    rows.push(row(entries.slice(index, index + 3).map((entry) => column([entry]))));
  }
  return rows;
}

function countChars(value) {
  return Array.from(String(value ?? '')).length;
}

// Byte-safe cut on code-point boundaries, so a split never produces half a
// Chinese character (which would render as a replacement glyph).
function cutBytes(value, max) {
  const limit = Math.max(8, Math.floor(max));
  const pieces = [];
  let current = '';
  let size = 0;
  for (const point of Array.from(String(value ?? ''))) {
    const pointBytes = strBytes(point);
    if (size + pointBytes > limit && current !== '') {
      pieces.push(current);
      current = '';
      size = 0;
    }
    current += point;
    size += pointBytes;
  }
  if (current !== '' || pieces.length === 0) pieces.push(current);
  return pieces;
}

// One labelled line of body text. An over-long value becomes numbered pieces:
// `规则 1/1（分片 2/9）：…`, which is how the test suite can prove nothing was
// dropped between segments. The marker sits between the label and the text, so
// joining the pieces after the marker reproduces the original value exactly.
// The piece counter is printed on every line, so the cut has to pay for the
// width it will really produce: reserving a fixed `999/999` marker lets a value
// that needs 1.000 or more pieces print two bytes wider than it cut, so a line
// would exceed ATOM_BYTES. The allowance therefore grows until the reserved
// marker is at least as wide as the widest marker it prints — three digits pays
// for up to 999 pieces, four for up to 9.999, and so on.
function atomize(label, value) {
  const body = String(value ?? '');
  const whole = `${label}：${body}`;
  if (strBytes(whole) <= ATOM_BYTES) return [whole];
  const overhead = strBytes(label);
  let markerBytes = strBytes('（分片 9/9）：');
  let pieces = cutBytes(body, ATOM_BYTES - overhead - markerBytes);
  for (let round = 0; round < 6; round++) {
    const needed = strBytes(`（分片 ${pieces.length}/${pieces.length}）：`);
    if (needed <= markerBytes) break;
    markerBytes = needed;
    pieces = cutBytes(body, ATOM_BYTES - overhead - markerBytes);
  }
  const total = pieces.length;
  return pieces.map((piece, index) => `${label}（分片 ${index + 1}/${total}）：${piece}`);
}

// Summary clipping. Always says how long the real value is and where the rest of
// it lives, so a short line on a paged card is never mistaken for the whole
// thing.
function clipTo(value, max, hint = '完整见子单详情') {
  const body = String(value ?? '');
  if (strBytes(body) <= max) return body;
  const total = countChars(body);
  const marker = `……（已截断，共 ${total} 字，${hint}）`;
  const [head] = cutBytes(body, Math.max(16, max - strBytes(marker)));
  return `${head}${marker}`;
}

// Keys come from the draft, i.e. from model output. The draft module validates
// them at MAX_KEY bytes, but this file owns the transport limit, so an oversized
// key is clipped with a marker instead of pushing the card over 30 KiB.
const keyText = (key) => clipTo(key, MAX_KEY, '以草稿子单编号为准');

function packSegments(atoms, budget) {
  const segments = [[]];
  let size = 0;
  for (const atom of atoms) {
    const cost = jsonBytes(text(atom)) + 8;
    if (size > 0 && size + cost > budget) {
      segments.push([]);
      size = 0;
    }
    segments.at(-1).push(atom);
    size += cost;
  }
  if (segments.at(-1).length === 0 && segments.length > 1) segments.pop();
  if (segments.length === 0) segments.push([]);
  return segments;
}

function clampInt(value, count) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.floor(number), Math.max(0, count - 1));
}

// A draft without an integer version *is* version 0, and it has to be 0 in both
// places that say so: the stamp inside every callback value and the staleness
// test on a recorded seen range. Stamp 0 but compare against `undefined` and a
// ledger written from the callback reads as stale forever, so 提交 stays cold and
// the reviewer has no way to fix it from the card.
const draftVersionOf = (draft) => (Number.isInteger(draft?.version) ? draft.version : 0);

function toSet(value) {
  return new Set((Array.isArray(value) ? value : []).map((item) => String(item)));
}

function listOf(value) {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function allowedActor(request, actorId) {
  if (!nonEmptyString(actorId)) return false;
  if (request.initiatorId === actorId) return true;
  return Array.isArray(request.reviewerIds) && request.reviewerIds.includes(actorId);
}

function readLedger(request) {
  const submissions = listOf(request.submissions);
  const items = new Map();
  for (const submission of submissions) {
    for (const item of listOf(submission.items)) {
      if (nonEmptyString(item.key)) items.set(item.key, item);
    }
  }
  const created = new Set();
  const ids = new Map();
  for (const [key, item] of items) {
    if (item.status === 'created') {
      created.add(key);
      if (nonEmptyString(item.storyId)) ids.set(key, item.storyId);
    }
  }
  const latest = submissions.at(-1) ?? null;
  const status = nonEmptyString(latest?.status) ? latest.status : (latest ? 'pending' : null);
  const unknownItems = [...items.entries()].filter(([, item]) => item.status === 'unknown').map(([key]) => key);
  const sendingItems = [...items.entries()].filter(([, item]) => item.status === 'sending').map(([key]) => key);
  const notes = [...new Set(listOf(latest?.notes).map((note) => (nonEmptyString(note?.code) ? note.code : '')).filter(Boolean))];
  return {
    submissions,
    latest,
    items,
    created,
    ids,
    status,
    unknownItems,
    sendingItems,
    needsAttention: unknownItems.length > 0 || status === 'needs_review' || status === 'paused',
    running: status === 'running' || sendingItems.length > 0,
    notes,
  };
}

// ---------------------------------------------------------------- shared policy
// Exported because Task 10 owns the server side of the same rules: before it
// freezes a batch it has to re-check 「审核人可选择无阻塞且依赖完整的子集」 and
// 「最后提交前检查该审核人已查看选中子单的完整详情与确认页」. It imports these instead
// of re-deriving them, so the gate a reviewer reads on the confirm card and the
// gate that blocks the write are one implementation.
//   reviewState(request, viewerId) → the state all four read
//   splitEligible(request, candidateKeys, createdKeys) → { selected, blocked, batchLimit }
//   submitGate(state, pageCount) → reason strings, empty means "may submit"
//   missingDetails(state) → selected stories whose full detail was never read
//   confirmSeenOk(state, pageCount) → whether every confirm page is in the ledger
// The confirm card calls exactly these, and
// `submitGate(...).length === 0` iff that card renders an enabled 提交 button.

// The confirm page writes the largest unblocked, dependency-complete subset of
// the approved stories; whatever falls out is named as 暂缓 with its code, so a
// held-back story is visible instead of quietly missing.
export function splitEligible(request, candidateKeys, createdKeys) {
  let selected = [...candidateKeys];
  const blocked = new Map();
  let batchLimit = false;
  for (let round = 0; round <= candidateKeys.length; round++) {
    const { blockers } = submissionEligibility({
      draft: request.draft,
      snapshot: request.snapshot,
      selectedKeys: selected,
      createdKeys,
    });
    const keyed = new Map();
    batchLimit = false;
    for (const blocker of Array.isArray(blockers) ? blockers : []) {
      if (blocker?.code === 'BATCH_LIMIT') {
        batchLimit = true;
        continue;
      }
      if (!nonEmptyString(blocker?.key)) continue;
      if (!keyed.has(blocker.key)) keyed.set(blocker.key, []);
      keyed.get(blocker.key).push(blocker.code);
    }
    if (keyed.size === 0) break;
    for (const [key, codes] of keyed) {
      blocked.set(key, [...(blocked.get(key) ?? []), ...codes]);
    }
    selected = selected.filter((key) => !keyed.has(key));
    if (selected.length === 0) {
      batchLimit = false;
      break;
    }
  }
  return { selected, blocked, batchLimit };
}

function openIssuesFor(request, storyKey) {
  const issues = listOf(request.draft?.issues);
  const story = listOf(request.draft?.stories).find((candidate) => candidate.key === storyKey);
  const declared = new Set((Array.isArray(story?.issueIds) ? story.issueIds : []).map(String));
  return issues.filter((issue) => (Array.isArray(issue.storyKeys)
    && issue.storyKeys.map(String).includes(String(storyKey))) || declared.has(String(issue.id)));
}

function pendingResources(request) {
  const decided = new Set(listOf(request.draft?.resourceDecisions)
    .filter((decision) => decision?.action === 'explain' || decision?.action === 'exclude')
    .map((decision) => String(decision?.resourceId)));
  return listOf(request.snapshot?.resources)
    .filter((resource) => resource?.status === 'pending' && !decided.has(String(resource?.id)));
}

function unreadResourcesFor(request, storyKey) {
  const story = listOf(request.draft?.stories).find((candidate) => candidate.key === storyKey);
  const sourceIds = new Set((Array.isArray(story?.sourceIds) ? story.sourceIds : []).map(String));
  return pendingResources(request).filter((resource) => sourceIds.has(String(resource?.id)));
}

function resourceBody(resource) {
  const kind = RESOURCE_KINDS[resource?.kind] ?? (nonEmptyString(resource?.kind) ? resource.kind : '素材');
  const reason = nonEmptyString(resource?.reason) ? resource.reason : '未读取';
  return `${resource?.id ?? '未知素材'}（${kind}）${reason}`;
}

function storyLabel(story) {
  return `${keyText(story.key)} ${clipTo(story.title, LIST_TITLE_BYTES)}`;
}

// Everything the exported policy below reads, in one place: the renderer and the
// coordinator build the same state, so they cannot disagree about a gate.
export function reviewState(request, viewerId) {
  const draft = isPlainObject(request.draft) ? request.draft : {};
  const version = draftVersionOf(draft);
  const stories = listOf(draft.stories);
  const ledger = readLedger(request);
  const candidates = stories
    .filter((story) => story.disposition === 'approved' && !ledger.created.has(story.key))
    .map((story) => story.key);
  const { selected, blocked, batchLimit } = splitEligible(request, candidates, ledger.created);
  const record = isPlainObject(request.viewByActor) ? request.viewByActor[viewerId] : null;
  // Compared against the same normalisation the callback stamps, so a ledger
  // written from a callback can never be read back as stale.
  const fresh = isPlainObject(record) && record.draftVersion === version;
  const detailSeen = fresh ? toSet(record.detailSeen) : new Set();
  return {
    draft,
    version,
    snapshot: isPlainObject(request.snapshot) ? request.snapshot : {},
    stories,
    byKey: new Map(stories.map((story) => [story.key, story])),
    ledger,
    candidates,
    selected,
    blocked,
    batchLimit,
    allowed: allowedActor(request, viewerId),
    statusLabel: REQUEST_STATUS_LABELS[request.status] ?? clipTo(request.status ?? '未知状态', 32),
    writable: WRITABLE_STATUSES.has(request.status),
    pagesSeen: fresh ? toSet(record.pagesSeen) : new Set(),
    detailSeen,
    confirmSeenValue: fresh ? record.confirmSeen : undefined,
    voided: isPlainObject(record) && !fresh,
  };
}

export function missingDetails(state) {
  return state.selected.filter((key) => !state.detailSeen.has(key));
}

export function confirmSeenOk(state, pageCount) {
  if (state.confirmSeenValue === true) return true;
  if (Array.isArray(state.confirmSeenValue) || state.confirmSeenValue instanceof Set) {
    // toSet() normalises to strings, so the page index has to be compared as one.
    const seen = toSet([...(state.confirmSeenValue ?? [])]);
    return Array.from({ length: Math.max(0, pageCount) }, (_, index) => String(index))
      .every((index) => seen.has(index));
  }
  return false;
}

// How much of the confirm page this actor has read. Only the confirm card knows
// the real page count; elsewhere a page-by-page ledger is reported as a count so
// the reviewer is never told "已查看" on the wrong authority.
function confirmSeenLabel(state, pageCount) {
  const value = state.confirmSeenValue;
  if (value === true) return '已查看';
  if (Array.isArray(value) || value instanceof Set) {
    const seen = toSet([...value]).size;
    if (!Number.isInteger(pageCount)) return `已查看 ${seen} 页`;
    return confirmSeenOk(state, pageCount) ? '已查看' : `已查看 ${seen} / ${pageCount} 页`;
  }
  return '未查看';
}

// Reasons a write button is cold. Everything that can change the draft, the
// target or TAPD uses this; the confirm page additionally reports the submit
// gates so the reviewer knows what is still missing.
function writeGate(state) {
  const reasons = [];
  if (!state.allowed) reasons.push('无审核权限');
  if (!state.writable) reasons.push(`当前状态（${state.statusLabel}）不可写入`);
  return reasons;
}

// Every control that can change the draft, the target or TAPD answers this one
// question, so a status the reviewer may not act on is cold everywhere instead
// of cold in four slightly different ways.
const gated = (state) => writeGate(state).length > 0;

// The list pagination is shared by the list card and by 返回清单 on the detail
// card, so a stale page is clamped against the same count in both.
const listPageCount = (state) => Math.max(1, Math.ceil(state.stories.length / LIST_PAGE_SIZE));

export function submitGate(state, pageCount) {
  const reasons = [...writeGate(state)];
  if (state.ledger.running) reasons.push('已有批次正在写入，等结果落盘后再操作');
  else if (state.ledger.needsAttention) {
    reasons.push(state.ledger.unknownItems.length > 0
      ? '存在结果未知项：查不到不等于可以自动重试，请先核对'
      : '上一批次未完成：先核对或继续，不要重复提交');
  }
  if (state.batchLimit) reasons.push(`单批最多 ${MAX_BATCH_STORIES} 张子单，需分批提交（仍关联同一父单）`);
  if (state.selected.length === 0 && !state.batchLimit) reasons.push('没有可提交子单');
  const missing = missingDetails(state);
  if (missing.length > 0) reasons.push(`尚未查看完整详情：${missing.join('、')}`);
  if (!confirmSeenOk(state, pageCount)) reasons.push('确认页尚未查看');
  return reasons;
}

// The 确认页 part is only exact on the confirm card, which owns the real segment
// count; the other two cards pass null and get a conservative label.
function seenSummary(state, storyCount, confirmLabel) {
  const seenDetails = state.selected.filter((key) => state.detailSeen.has(key)).length;
  return `你的查看范围：清单 ${state.pagesSeen.size} 页，详情 ${seenDetails} / ${storyCount} 张，确认页 ${confirmLabel}`;
}

// Both places a blocked reason is written — the request itself and the selected
// target — are read here. The line is either a fixed phrase or the code alone, so
// a value that slipped past safeCode() still cannot carry document text or a path.
function blockedReasonLine(request) {
  const reason = nonEmptyString(request.blockedReason)
    ? request.blockedReason
    : targetOf(request).blockedReason;
  if (!nonEmptyString(reason)) return null;
  if (Object.hasOwn(BLOCKED_REASON_LABELS, reason)) return `上次被挡住：${BLOCKED_REASON_LABELS[reason]}`;
  if (BLOCKED_CODE.test(reason)) return `上次被挡住：未登记原因（${reason}）`;
  return '上次被挡住：原因未登记';
}

function commonLines(request, state, mode) {
  const out = [];
  out.push(clipTo(`文档：${state.snapshot.title ?? '未命名文档'}`, DOC_TITLE_BYTES));
  if (nonEmptyString(state.snapshot.url)) out.push(`链接：${clipTo(state.snapshot.url, DOC_TITLE_BYTES)}`);
  out.push(`草稿 v${state.version} · ${MODE_LABELS[mode]} · ${state.statusLabel}`);
  const blocked = blockedReasonLine(request);
  if (blocked) out.push(blocked);
  if (!state.allowed) out.push('无审核权限：可查看全部内容，所有写入按钮不会生效。');
  if (state.voided) out.push(`草稿版本已更新到 v${state.version}，此前的查看范围作废，需要重新查看。`);
  return out;
}

// The target block is server config and may be absent or half-filled, so every
// read goes through these two guards rather than trusting the shape.
function targetOf(request) {
  return isPlainObject(request.target) ? request.target : {};
}

function parentOf(request) {
  const parent = targetOf(request).parent;
  return isPlainObject(parent) ? parent : {};
}

function parentLine(request, state) {
  const parent = parentOf(request);
  const boundId = nonEmptyString(request.parentStoryId)
    ? request.parentStoryId
    : (parent.mode === 'bind' && nonEmptyString(parent.storyId) ? parent.storyId : null);
  if (boundId) return `父单：关联已有父单 ${clipTo(boundId, ID_BYTES, '以服务端配置为准')}`;
  const title = nonEmptyString(parent.title) ? parent.title : (state.snapshot.title ?? '');
  return `父单：新建父单 ${clipTo(title, DOC_TITLE_BYTES)}`;
}

function targetLines(request, state) {
  const target = targetOf(request);
  const defaults = isPlainObject(target.childDefaults) ? target.childDefaults : {};
  const parent = parentOf(request);
  const byConfig = '以服务端配置为准';
  // An explicit allow-list: a token path or any other config field that happens
  // to ride along on the request must not reach the card.
  //
  // Spec 3.2 enumerates 父子类型、父单与子单迭代、负责人, and every one of those
  // really is written: buildParentFields sends target.parent.owner and
  // target.parent.iterationId alongside the child defaults, so the parent half
  // belongs on this page too. A reviewer must not be able to authorise a parent
  // creation whose two configured fields were never shown.
  return [
    `目标项目：${clipTo(request.projectId ?? '未选择', ID_BYTES, byConfig)}（workspace ${clipTo(target.workspaceId ?? '未配置', ID_BYTES, byConfig)}）`,
    `父单类型：${clipTo(target.parentTypeId ?? '未配置', ID_BYTES, byConfig)}｜子单类型：${clipTo(target.childTypeId ?? '未配置', ID_BYTES, byConfig)}｜模板：${clipTo(target.templateId ?? '未配置', ID_BYTES, byConfig)}`,
    parentLine(request, state),
    `父单迭代：${clipTo(parent.iterationId ?? '未设置', ID_BYTES, byConfig)}`,
    `父单负责人：${clipTo(parent.owner ?? '未指定', ID_BYTES, byConfig)}`,
    `子单迭代：${clipTo(defaults.iterationId ?? '未设置', ID_BYTES, byConfig)}`,
    `子单负责人：${clipTo(defaults.owner ?? '未指定', ID_BYTES, byConfig)}`,
    `来源文档：${clipTo(state.snapshot.title ?? '未命名文档', DOC_TITLE_BYTES)} · ${clipTo(state.snapshot.revision ?? '未知版本', ID_BYTES, byConfig)}（指纹 ${clipTo(state.snapshot.fingerprint ?? '未记录', 80, byConfig)}）`,
  ];
}

function callbackFor(request, action, key, page) {
  return {
    workflow: 'requirements',
    requestId: String(request.id ?? ''),
    // The same normalisation reviewState compares a recorded ledger against: what
    // the callback stamps is what the card will accept back.
    draftVersion: draftVersionOf(request.draft),
    action,
    key: nonEmptyString(key) ? String(key) : '',
    page: Number.isInteger(page) && page > 0 ? page : 0,
  };
}

function storyDecisionButtons(request, state, story, page) {
  const disabled = gated(state);
  const alreadyCreated = state.ledger.created.has(story.key);
  return [
    makeButton('approve', '批准', callbackFor(request, 'approve', story.key, page), disabled || alreadyCreated, 'primary_filled'),
    makeButton('defer', '延期', callbackFor(request, 'defer', story.key, page), disabled || alreadyCreated),
    makeButton('exclude', '排除', callbackFor(request, 'exclude', story.key, page), disabled || alreadyCreated),
    makeButton('detail', '进入详情', callbackFor(request, 'detail', story.key, page), false),
  ];
}

function listButtons(request, state, page, pageCount) {
  const disabled = gated(state);
  const rows = [];
  if (page > 0) rows.push(makeButton('list_prev', '上一页', callbackFor(request, 'list_prev', '', page - 1), false));
  if (page < pageCount - 1) rows.push(makeButton('list_next', '下一页', callbackFor(request, 'list_next', '', page + 1), false));
  rows.push(makeButton('confirm', '去确认页', callbackFor(request, 'confirm', '', 0), false));
  rows.push(makeButton('select_target', '选择目标项目', callbackFor(request, 'select_target', '', page), disabled));
  rows.push(makeButton('select_iteration', '设置子单迭代', callbackFor(request, 'select_iteration', '', page), disabled));
  rows.push(makeButton('bind_parent', '关联已有父单', callbackFor(request, 'bind_parent', '', page), disabled));
  rows.push(makeButton('cancel', '取消拆分', callbackFor(request, 'cancel', '', 0), disabled, 'danger'));
  return rows;
}

// `banner` is a line for the reader that arrives here from a view that no longer
// exists (see the stale-storyKey path in buildRequirementCard); it goes first so
// it is the thing the reviewer reads before the list itself.
function renderList(request, state, view, banner = null) {
  const pageCount = listPageCount(state);
  const page = clampInt(view.page, pageCount);
  const stories = state.stories.slice(page * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE + LIST_PAGE_SIZE);
  const lines = [...commonLines(request, state, 'list')];
  if (nonEmptyString(banner)) lines.push(banner);
  lines.push(`子单清单 第 ${page + 1} / ${pageCount} 页（共 ${state.stories.length} 张）`);
  // Required by the brief and true whatever this draft's page count is: paging is
  // a property of the view, not of how much material happened to fit, so the
  // statement is never conditioned on there being several pages.
  lines.push('翻页只改变视图，不代表你已批准，也不代表其他人完成审核。');
  lines.push(seenSummary(state, state.selected.length, confirmSeenLabel(state, null)));
  if (state.candidates.length > MAX_BATCH_STORIES) {
    lines.push(`本批已批准 ${state.candidates.length} 张，超过单批上限 ${MAX_BATCH_STORIES} 张，需分批提交。`);
  }

  const elements = lines.map((line) => text(line));
  for (const story of stories) {
    const disposition = DISPOSITION_LABELS[story.disposition] ?? '未知状态';
    const createdId = state.ledger.ids.get(story.key);
    const facts = Array.isArray(story.factIds) ? story.factIds.length : 0;
    const rules = Array.isArray(story.rules) ? story.rules.length : 0;
    const dependencies = Array.isArray(story.dependencies) ? story.dependencies.join('、') : '';
    elements.push(text(`【${storyLabel(story)}】`));
    elements.push(text(`${disposition}｜规则 ${rules} 条｜事实 ${facts} 项｜负责人 ${clipTo(story.owner ?? '未指定', 40)}｜依赖 ${clipTo(dependencies || '无', 60)}`));
    if (createdId) elements.push(text(`台账：${keyText(story.key)} 已创建 ${clipTo(createdId, ID_BYTES, '以 TAPD 台账为准')}`));

    const reasons = [];
    for (const code of state.blocked.get(story.key) ?? []) {
      reasons.push(`不能提交：${clipTo(code, 40)}${code === 'UNSATISFIED_DEPENDENCY' ? '（依赖尚未批准或尚未建单）' : ''}`);
    }
    for (const issue of openIssuesFor(request, story.key)) {
      const flag = issue.blocking === true ? '阻塞' : '待确认';
      const answered = isPlainObject(issue.resolvedBy) ? `已回答：${clipTo(issue.resolvedBy.text, 40)}` : '未回答';
      reasons.push(`问题 ${clipTo(issue.id, 40)}〔${flag}·${answered}〕${clipTo(issue.question, LIST_FIELD_BYTES)}`);
    }
    for (const resource of unreadResourcesFor(request, story.key)) {
      // Same budget as any other reason line; the detail card repeats the whole
      // material description, so a clip here is a pointer, not a loss.
      reasons.push(clipTo(`未读素材：${resourceBody(resource)}`, LIST_FIELD_BYTES));
    }
    const shown = reasons.slice(0, LIST_REASON_LINES);
    for (const reason of shown) elements.push(text(`　${reason}`));
    if (reasons.length > shown.length) {
      elements.push(text(`　另有 ${reasons.length - shown.length} 条原因，完整见子单详情`));
    }
    if (reasons.length === 0) elements.push(text('　无阻塞问题、无未读素材'));
    elements.push(...buttonRows(storyDecisionButtons(request, state, story, page)));
  }

  if (stories.length === 0) elements.push(text('（本次草稿没有子单）'));
  elements.push(...buttonRows(listButtons(request, state, page, pageCount)));
  return { elements };
}

function detailAtoms(request, state, story) {
  const atoms = [];
  atoms.push(...atomize('标题', story.title));
  atoms.push(...atomize('状态', DISPOSITION_LABELS[story.disposition] ?? '未知状态'));
  atoms.push(...atomize('负责人', story.owner ?? '未指定（提交时取项目默认负责人）'));
  atoms.push(...atomize('依赖', (Array.isArray(story.dependencies) ? story.dependencies : []).join('、') || '无'));
  const rules = Array.isArray(story.rules) ? story.rules : [];
  atoms.push('以下功能规则为全文，跨段只分段、不删减：');
  rules.forEach((rule, index) => {
    atoms.push(...atomize(`规则 ${index + 1}/${rules.length}`, rule?.text));
  });
  const acceptance = Array.isArray(story.acceptance) ? story.acceptance : [];
  atoms.push('验收条件：');
  acceptance.forEach((item, index) => {
    atoms.push(...atomize(`验收 ${index + 1}/${acceptance.length}`, item?.text));
  });
  atoms.push(...atomize('需求来源', (Array.isArray(story.sourceIds) ? story.sourceIds : []).join('、') || '无'));
  atoms.push(...atomize('事实', (Array.isArray(story.factIds) ? story.factIds : []).join('、') || '无'));
  const issues = openIssuesFor(request, story.key);
  if (issues.length > 0) {
    atoms.push('待确认问题（回答请在卡片消息线程内回复）：');
    for (const issue of issues) {
      const flag = issue.blocking === true ? '阻塞' : '待确认';
      const answered = isPlainObject(issue.resolvedBy)
        ? `已由 ${clipTo(issue.resolvedBy.actorId ?? '审核人', 40)} 回答`
        : '未回答';
      atoms.push(...atomize(`问题 ${clipTo(issue.id, 40)}〔${flag}·${answered}〕`, issue.question));
    }
  }
  for (const resource of unreadResourcesFor(request, story.key)) {
    atoms.push(...atomize('未读素材', resourceBody(resource)));
  }
  const codes = state.blocked.get(story.key) ?? [];
  if (codes.length > 0) atoms.push(...atomize('提交门槛', codes.join('、')));
  const createdId = state.ledger.ids.get(story.key);
  if (createdId) atoms.push(`台账：${keyText(story.key)} 已创建 ${clipTo(createdId, ID_BYTES, '以 TAPD 台账为准')}`);
  for (const line of targetLines(request, state)) atoms.push(line);
  return atoms;
}

// Returns null when the view names a story this draft no longer has. That is a
// stale view rather than bad input: throwing here would leave Task 10 with no way
// to update the shared card, so the group would keep staring at a dead story. The
// caller falls back to the list. A view that names no story at all is unrenderable
// input and still fails with a code.
function renderDetail(request, state, view) {
  const key = nonEmptyString(view.storyKey) ? view.storyKey : null;
  if (key === null) throw coded('UNKNOWN_STORY');
  const story = state.byKey.get(key);
  if (!story) return null;
  const segments = packSegments(detailAtoms(request, state, story), PAGE_BODY_BYTES);
  const index = clampInt(view.detailPage, segments.length);
  const listPage = clampInt(view.page, listPageCount(state));

  const lines = [...commonLines(request, state, 'detail')];
  lines.push(`子单 ${keyText(story.key)} · 第 ${index + 1} / ${segments.length} 段`);
  lines.push(seenSummary(state, state.selected.length, confirmSeenLabel(state, null)));
  // Unconditional, like the list card's: 下一段 is a view change on every detail
  // card, whether or not this story happened to need more than one segment.
  lines.push(`共 ${segments.length} 段，翻页只改变视图，不代表你已批准，也不代表其他人完成审核。`);
  lines.push(`回答方式：在本卡片消息线程内回复“请求 ${clipTo(request.id ?? '', 40, '以服务端记录为准')} · 问题编号 · 你的答案”。`);

  const disabled = gated(state);
  const buttons = [];
  if (index > 0) {
    buttons.push(makeButton('detail_prev', '上一段', callbackFor(request, 'detail_prev', story.key, index - 1), false));
  }
  if (index < segments.length - 1) {
    buttons.push(makeButton('detail_next', '下一段', callbackFor(request, 'detail_next', story.key, index + 1), false));
  }
  buttons.push(makeButton('back', '返回清单', callbackFor(request, 'back', story.key, listPage), false));
  const alreadyCreated = state.ledger.created.has(story.key);
  buttons.push(makeButton('approve', '批准本子单', callbackFor(request, 'approve', story.key, index), disabled || alreadyCreated, 'primary_filled'));
  buttons.push(makeButton('defer', '延期本子单', callbackFor(request, 'defer', story.key, index), disabled || alreadyCreated));
  buttons.push(makeButton('exclude', '排除本子单', callbackFor(request, 'exclude', story.key, index), disabled || alreadyCreated));
  buttons.push(makeButton('select_owner', '选择负责人', callbackFor(request, 'select_owner', story.key, index), disabled));
  // The answer itself always arrives as a message in the card thread; this
  // callback only asks the runtime to post the prompt, so it carries the story
  // whose questions are being answered and no free text.
  buttons.push(makeButton('answer', '回答问题', callbackFor(request, 'answer', story.key, index), disabled));
  buttons.push(makeButton('confirm', '去确认页', callbackFor(request, 'confirm', '', 0), false));

  const elements = [
    ...lines.map((line) => text(line)),
    ...segments[index].map((atom) => text(atom)),
    ...buttonRows(buttons),
  ];
  return { elements };
}

function confirmSections(state) {
  const toCreate = state.selected.map((key) => state.byKey.get(key)).filter(Boolean);
  const heldBack = [
    ...state.stories
      .filter((story) => story.disposition === 'deferred' && !state.ledger.created.has(story.key))
      .map((story) => ({ story, codes: ['审核人延期'] })),
    ...[...state.blocked.entries()]
      .filter(([key]) => !state.selected.includes(key))
      .map(([key, codes]) => ({ story: state.byKey.get(key), codes }))
      .filter((entry) => entry.story && !state.ledger.created.has(entry.story.key)),
  ];
  const excluded = state.stories.filter((story) => story.disposition === 'excluded');
  const proposed = state.stories.filter((story) => story.disposition === 'proposed');
  const created = state.stories
    .filter((story) => state.ledger.created.has(story.key))
    .map((story) => ({ key: story.key, storyId: state.ledger.ids.get(story.key) ?? '未记录单号' }));
  return { toCreate, heldBack, excluded, proposed, created };
}

function confirmAtoms(request, state, sections, reasons) {
  const atoms = [];
  // Lists that can grow (unknown items, gate reasons, in-flight items) go through
  // the segmented atom stream, never through a header line: a header line is on
  // every page and would put the card back over the transport limit.
  if (state.ledger.unknownItems.length > 0) {
    atoms.push(...atomize('结果未知项（先核对，不要重试）', state.ledger.unknownItems.join('、')));
  }
  if (state.ledger.sendingItems.length > 0) {
    atoms.push(...atomize('结果未落盘项', state.ledger.sendingItems.join('、')));
  }
  for (const reason of reasons) atoms.push(...atomize('提交前还需', reason));
  atoms.push(...targetLines(request, state));
  const parentAlreadyWritten = state.ledger.created.has('parent');
  const writeCount = sections.toCreate.length + (parentAlreadyWritten ? 0 : (sections.toCreate.length > 0 ? 1 : 0));
  if (state.batchLimit) {
    // The card never invents a batching decision: it names the over-limit count
    // and says a batch is 50 stories plus one parent, still the same parent.
    atoms.push(`总写入数量：候选子单 ${sections.toCreate.length} 张，超过单批上限 ${MAX_BATCH_STORIES} 张。一批最多 ${MAX_BATCH_STORIES} 张子单 + 1 张父单，且各批关联同一父单；具体哪几张进第一批由确认页之外的选择决定，本页不替你选。`);
  } else {
    atoms.push(`总写入数量：${writeCount} 次（子单 ${sections.toCreate.length} 张 + ${
      parentAlreadyWritten ? '父单已存在，不再写入' : `父单 ${sections.toCreate.length > 0 ? 1 : 0} 张`}）`);
  }

  atoms.push(`待创建子单（${sections.toCreate.length} 张）`);
  if (state.batchLimit) atoms.push(`超过单批上限：一批最多 ${MAX_BATCH_STORIES} 张，其余进入下一批，仍关联同一父单。`);
  if (sections.toCreate.length === 0) atoms.push('（无）');
  for (const story of sections.toCreate) atoms.push(...atomize(keyText(story.key), story.title));

  atoms.push(`暂缓（${sections.heldBack.length} 张）`);
  if (sections.heldBack.length === 0) atoms.push('（无）');
  for (const entry of sections.heldBack) {
    atoms.push(...atomize(keyText(entry.story.key), `${entry.story.title}〔${clipTo((entry.codes ?? []).join('、'), 80)}〕`));
  }

  atoms.push(`排除（${sections.excluded.length} 张）`);
  if (sections.excluded.length === 0) atoms.push('（无）');
  for (const story of sections.excluded) atoms.push(...atomize(keyText(story.key), story.title));

  atoms.push(`待批准（${sections.proposed.length} 张）`);
  if (sections.proposed.length === 0) atoms.push('（无）');
  for (const story of sections.proposed) atoms.push(...atomize(keyText(story.key), story.title));

  atoms.push(`已创建（${sections.created.length} 张）`);
  if (sections.created.length === 0) atoms.push('（无）');
  for (const entry of sections.created) atoms.push(`${keyText(entry.key)} 已创建 ${clipTo(entry.storyId, ID_BYTES, '以 TAPD 台账为准')}`);

  const exclusions = listOf(state.draft.exclusions);
  atoms.push(`事实排除（${exclusions.length} 项）`);
  if (exclusions.length === 0) atoms.push('（无）');
  for (const exclusion of exclusions) {
    // The reason is a business decision and the confirm page is its only home,
    // so it is never summary-clipped here — atomize segments the whole text.
    atoms.push(...atomize('排除原因', `原因：${exclusion.reason ?? '未记录原因'}｜批准人 ${clipTo(exclusion.approvedBy ?? '未知', 40)}｜事实 ${(Array.isArray(exclusion.factIds) ? exclusion.factIds : []).join('、') || '无'}`));
  }

  const unread = pendingResources(request);
  atoms.push(`未读素材（${unread.length} 项）`);
  if (unread.length === 0) atoms.push('（无）');
  for (const resource of unread) atoms.push(...atomize('未读素材', resourceBody(resource)));

  const openIssues = listOf(state.draft.issues).filter((issue) => issue.blocking === true && !isPlainObject(issue.resolvedBy));
  atoms.push(`阻塞问题（${openIssues.length} 项）`);
  if (openIssues.length === 0) atoms.push('（无）');
  for (const issue of openIssues) atoms.push(...atomize(`问题 ${clipTo(issue.id, 40)}`, issue.question));

  if (state.ledger.latest) {
    const batch = isPlainObject(state.ledger.latest.batch) ? state.ledger.latest.batch : {};
    atoms.push(`最近批次：${clipTo(batch.id ?? '未知批次', ID_BYTES, '以 TAPD 台账为准')}（${clipTo(state.ledger.status ?? '未知', 32)}）`);
    for (const [key, item] of state.ledger.items) {
      const label = ITEM_STATUS_LABELS[item.status] ?? '未知结果';
      atoms.push(`${keyText(key)} ${label}${nonEmptyString(item.storyId) ? ` ${clipTo(item.storyId, ID_BYTES, '以 TAPD 台账为准')}` : ''}`);
    }
    for (const note of state.ledger.notes) atoms.push(`批次记录：${clipTo(note, 40)}`);
  } else {
    atoms.push('最近批次：尚未提交');
  }
  return atoms;
}

function confirmButtons(request, state, page, pageCount, reasons) {
  const disabled = gated(state);
  const submitDisabled = reasons.length > 0;
  const hasUnknown = state.ledger.unknownItems.length > 0;
  const buttons = [];
  if (page > 0) buttons.push(makeButton('confirm_prev', '上一页', callbackFor(request, 'confirm_prev', '', page - 1), false));
  if (page < pageCount - 1) buttons.push(makeButton('confirm_next', '下一页', callbackFor(request, 'confirm_next', '', page + 1), false));
  buttons.push(makeButton('back', '返回清单', callbackFor(request, 'back', '', 0), false));
  buttons.push(makeButton(
    'submit',
    state.ledger.submissions.length > 0 ? '再提交剩余子单' : '确认提交',
    callbackFor(request, 'submit', '', 0),
    submitDisabled,
    'primary_filled',
  ));
  buttons.push(makeButton('cancel', '取消拆分', callbackFor(request, 'cancel', '', 0), disabled, 'danger'));
  // Reconcile is read-only against TAPD, so it stays usable for any reader;
  // resume does post stories and is gated like every other write.
  buttons.push(makeButton('reconcile', '核对 TAPD', callbackFor(request, 'reconcile', '', 0), false));
  buttons.push(makeButton(
    'resume',
    '继续未建单项',
    callbackFor(request, 'resume', '', 0),
    disabled || hasUnknown || state.ledger.running || !state.ledger.needsAttention,
  ));
  buttons.push(makeButton('select_target', '选择目标项目', callbackFor(request, 'select_target', '', page), disabled));
  buttons.push(makeButton('select_iteration', '设置子单迭代', callbackFor(request, 'select_iteration', '', page), disabled));
  buttons.push(makeButton('bind_parent', '关联已有父单', callbackFor(request, 'bind_parent', '', page), disabled));
  return buttons;
}

function renderConfirm(request, state, view) {
  const sections = confirmSections(state);
  // The gate reasons live in the segmented body (they are the only unbounded
  // prose on this card), while 确认页尚未查看 needs the number of segments, so
  // the two are resolved together instead of pretending the card has a fixed
  // size. The loop settles as soon as the segment count stops moving, and keeps
  // the listed reasons and the button state in the same iteration: a header that
  // counts N reasons has to list exactly those N.
  let segments = null;
  let reasons = [];
  for (let round = 0; round < 4; round++) {
    const nextReasons = submitGate(state, segments ? segments.length : 1);
    const next = packSegments(confirmAtoms(request, state, sections, nextReasons), PAGE_BODY_BYTES);
    const settled = segments !== null && next.length === segments.length;
    segments = next;
    reasons = nextReasons;
    if (settled) break;
  }
  const pageCount = segments.length;
  const page = clampInt(view.page, pageCount);

  const lines = [...commonLines(request, state, 'confirm')];
  lines.push(`确认页 第 ${page + 1} / ${pageCount} 页`);
  lines.push(seenSummary(state, state.selected.length, confirmSeenLabel(state, pageCount)));
  lines.push('确认页逐张列出要写入的标题，不用摘要代替审核。');
  if (state.ledger.unknownItems.length > 0) {
    lines.push(`结果未知 ${state.ledger.unknownItems.length} 项：查不到不等于可以自动重试，请先核对 TAPD（逐项列在下方）。`);
  } else if (state.ledger.needsAttention) {
    lines.push('上一批次未完成：先核对或继续，重复提交可能建出第二张单。');
  }
  if (state.ledger.running) {
    lines.push(`提交中：${state.ledger.sendingItems.length} 项结果尚未落盘，请勿重复提交。`);
  }
  if (reasons.length > 0) {
    lines.push(`提交前还需 ${reasons.length} 项，逐条写在“提交前还需”条目里，从本页开始分段列出。`);
  }

  const elements = [
    ...lines.map((line) => text(line)),
    ...segments[page].map((atom) => text(atom)),
    ...buttonRows(confirmButtons(request, state, page, pageCount, reasons)),
  ];
  return { elements };
}

export function buildRequirementCard({ request, view, viewerId } = {}) {
  if (!isPlainObject(request) || !isPlainObject(request.draft)) throw coded('INVALID_REQUEST');
  const mode = isPlainObject(view) ? view.mode : undefined;
  if (!MODES.has(mode)) throw coded('UNKNOWN_MODE');
  const state = reviewState(request, viewerId);

  // `shownMode` is the mode the card really is: a stale detail view is rendered as
  // the list, and the header says so instead of labelling a list 子单详情.
  let shownMode = mode;
  let built;
  if (mode === 'list') {
    built = renderList(request, state, view);
  } else if (mode === 'detail') {
    const detail = renderDetail(request, state, view);
    if (detail === null) {
      shownMode = 'list';
      built = renderList(request, state, view,
        `该子单 ${keyText(view.storyKey)} 已在 v${state.version} 中不存在，请从清单重新选择。`);
    } else {
      built = detail;
    }
  } else {
    built = renderConfirm(request, state, view);
  }

  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'default',
      summary: { content: `需求拆分审核 v${state.version} · ${MODE_LABELS[shownMode]}` },
    },
    header: {
      title: plain('需求拆分审核'),
      template: 'blue',
      subtitle: plain(`${MODE_LABELS[shownMode]} · v${state.version} · ${state.statusLabel}`),
      icon: { tag: 'standard_icon', token: 'file-form_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: built.elements,
    },
  };

  // Paging is what keeps the card inside the transport limit. Reaching this
  // throw means a page was built without a bound, so it fails loudly instead of
  // sending a truncated card that a reviewer would read as complete.
  if (jsonBytes(card) > CARD_MAX_BYTES) throw coded('CARD_TOO_LARGE');
  return card;
}
