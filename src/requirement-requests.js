// Requirement coordinator (Task 10): the only place that connects the ledger,
// the review cards, the document reader, the decomposer and the submitter to the
// chat. It owns workflow policy — who may press what, when a draft version is
// stale, what counts as "read to the end", when the work slot is taken and what
// happens after a restart.
//
// Rules this file exists to enforce:
//   - 自动分析不等于自动建单. A card press never creates a story unless the
//     reviewer passed the full gate: identity, chat, card, draft version, status,
//     source re-check, detail + confirm coverage, dependency-complete subset.
//   - Cards only *disable* buttons. A forged, stale or cross-group callback still
//     arrives here, so every check is re-run server-side, in the order the plan
//     fixes: workflow → action allow-list → chat → card → identity → version →
//     status. Identity is compared against the request's initiator/reviewers,
//     never against the shape of the open_id, and it is checked before the version
//     so a stranger cannot learn which version is current.
//   - The chat a write is judged in always comes from the event itself: `chat_id`
//     for a card callback, `message.chat_id` for a 修改拆分 or a thread reply. It
//     is never copied off the request, because the cards and the request id are
//     shared in a group and quoting them from another group is not membership.
//     Answers still go to the request's own chat.
//   - The gate functions imported from requirement-cards are the single
//     implementation of the review rules; this module calls them instead of
//     restating them, so the button state and the write decision cannot drift.
//   - Heavy work (document reading, model analysis, natural-language revision and
//     every TAPD write) occupies the work slot and is never queued silently. A
//     taken slot answers with an explicit notice. Review reading/paging is light.
//   - Only fixed coded strings are written to the ledger and the notices. Model,
//     reader and transport error text may contain credentials or remote content,
//     so only an UPPER_CASE code is kept.
//   - The LLM has no authority over people, targets or approval. Owner,
//     iteration, parent story and workspace come from the configured allow-lists
//     and from a real reviewer's action.
//   - A lost card update never means a story has to be created again: card
//     refresh retries are independent of remote creation and are re-driven by
//     flush(); a `sending` item is handed to the submitter's read-only reconcile.
//     A batch frozen on `submitting` that carries no items and no start stamp is
//     proof the submitter never ran, so recovery releases the request instead of
//     parking it — parking would leave every button refused forever.

import { randomUUID } from 'node:crypto';

import { classifyRequirementMessage, normalizeDocumentLink, resolveRequestReference } from './requirement-input.js';
import { extractPlainText } from './trigger.js';
import {
  LIST_PAGE_SIZE,
  buildRequirementCard,
  cancelGate,
  confirmSeenOk,
  missingDetails,
  reviewState,
  submitGate,
} from './requirement-cards.js';
import { MAX_DECISION_TEXT, MAX_KEY, applyReviewDecision, validateDraft, freezeBatch } from './requirement-draft.js';

const WORKFLOW = 'requirements';
const VALUE_KEYS = ['action', 'draftVersion', 'key', 'page', 'requestId', 'workflow'];
const NAV_ACTIONS = [
  'list_prev', 'list_next', 'detail', 'detail_prev', 'detail_next',
  'confirm', 'confirm_prev', 'confirm_next', 'back', 'reconcile',
];
const WRITE_ACTIONS = [
  'approve', 'defer', 'exclude', 'submit', 'cancel', 'resume', 'answer',
  'select_target', 'select_owner', 'select_iteration', 'bind_parent',
];
const ALLOWED_ACTIONS = new Set([...NAV_ACTIONS, ...WRITE_ACTIONS]);
const NAV = new Set(NAV_ACTIONS);
// Presses that reach out to TAPD. `reconcile` is read-only but still a remote
// call, so it occupies the slot exactly like a write does.
const HEAVY_ACTIONS = new Set(['submit', 'resume', 'reconcile']);
// Actions that rewrite content: refused while a batch is being written.
const EDIT_ACTIONS = new Set(['approve', 'defer', 'exclude', 'cancel', 'answer', 'select_target', 'select_owner', 'select_iteration', 'bind_parent']);

const STATUS = {
  READING: 'reading',
  ANALYZING: 'analyzing',
  AWAITING: 'awaiting_review',
  SUBMITTING: 'submitting',
  NEEDS_REVIEW: 'needs_review',
  PARTIAL: 'partially_completed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
};
const CLOSED_STATUSES = new Set([STATUS.CANCELLED]);

const MAX_ACTION_VALUE_CHARS = 4000;
const MAX_REPLY_CHARS = 4000;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_PAGE = 100000;
const MAX_CARD_IDS = 8;
const MAX_PENDING_STARTS = 24;
const MAX_SERIES_WALK = 400;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const OPEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,48}$/;
const RESOURCE_ACTION_WORDS = { 说明: 'explain', 排除: 'exclude', explain: 'explain', exclude: 'exclude' };

const NOTICE = {
  busy: '正在处理其他重操作，本条已收到但未排队，请稍后重试。',
  ack: '已收到，正在读取需求文档，完成后在本群发出审核卡。',
  multipleDocuments: '本条消息包含多个文档链接，请在本线程回复编号选择其一。',
  pickProject: '请回复目标项目标识（见下方清单）选择本项目的需求归属。',
  pickIteration: '请回复迭代标识（仅可用配置内的迭代）。',
  pickOwner: '请回复「子单编号 · 负责人」，负责人只能取配置名单内的人员。',
  pickParent: '请回复要关联的父单编号；只能使用系统已核实的单号。',
  pickParentEmpty: '本需求暂无已核实的父单号可选：请在配置中补充或先由系统建单，不能手填未核实编号。',
  needExcludeReason: '排除需要写明原因，请在本卡片线程回复「子单编号 · 原因」。',
  needAnswer: '请在本卡片线程回复「请求 <编号> · 问题编号 · 你的答案」。',
  ambiguous: '本条消息可能对应多个需求，请写明 请求 <编号> 后重试。',
  notSender: '无权限发起需求拆分：该发送者不在允许名单。',
  notReviewer: '你不是本需求的审核人，操作无效。',
  duplicate: '同一文档已有进行中的需求，继续使用原草稿与建单映射，不重复建单。',
  recovered: '上次读取或分析已中断，请重新发送「拆分需求 + 文档链接」重试。',
  parentNotFound: '未找到父单，需要人工确认后才能继续（PARENT_NOT_FOUND）。',
  parentMismatch: '已有父单与本需求来源不一致，仅提示不更新（PARENT_MISMATCH）。',
  unverifiableParent: '该父单号无法核实：只能关联系统已记录的单号。',
  emptyInstruction: '改稿指令为空或过长（上限 2000 字），操作无效。',
  noBatch: '本需求还没有批次可核对。',
  submitted: '已提交本批子单，结果以台账为准。',
  freezeReleased: '上次提交在写入前中断，本批未发出任何请求；请重新确认后再次提交。',
};

const REFUSALS = {
  UNKNOWN_REQUEST: '未找到本需求（可能已结束），操作无效。',
  CROSS_CHAT: '该需求不属于当前群，操作无效。',
  UNKNOWN_CARD: '该卡片不属于本需求，操作无效。',
  STALE_VERSION: '草稿已更新，这次点击针对的是旧版本，操作无效。',
  NOT_REVIEWER: NOTICE.notReviewer,
  NOT_WRITABLE: '当前状态不可写入，操作无效。',
  BATCH_IN_FLIGHT: '已有批次正在提交中，本需求暂不可编辑。',
  CANCEL_AFTER_WRITE: '已有内容写入 TAPD，不能取消；请继续完成剩余项或核对台账。',
  SOURCE_CHANGED: `来源文档已变化，本次提交无效（SOURCE_CHANGED）。`,
  SOURCE_RECHECK_FAILED: '来源文档复核失败，本次提交无效（SOURCE_RECHECK_FAILED）。',
  NOTHING_TO_SUBMIT: '没有可提交的子单：请先批准子单并查看完整详情与确认页。',
  INVALID_TARGET: '目标项目未确定，操作无效。',
  UNKNOWN_STORY: '子单不存在或已被改稿删除，操作无效。',
  UNKNOWN_ISSUE: '问题编号不存在，操作无效。',
  UNKNOWN_RESOURCE: '素材编号不存在，操作无效。',
  INVALID_DECISION: '回复内容不符合要求，操作无效。',
  UNKNOWN_DECISION: '无法识别这条回复，操作无效。',
  NOT_APPROVED: '子单尚未批准，操作无效。',
  GATE_CLOSED: '提交前条件尚未满足，操作无效。',
  VERIFY_FAILED: '草稿校验失败，本次改动未生效。',
  STEP_FAILED: '本次操作未完成，请稍后重试。',
};

const SUBMIT_NOTE_HINTS = {
  PARENT_NOT_FOUND: NOTICE.parentNotFound,
  PARENT_MISMATCH: NOTICE.parentMismatch,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function firstString(...values) {
  for (const value of values) {
    if (nonEmptyString(value)) return value;
  }
  return '';
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function stringsOf(value) {
  return listOf(value).filter((item) => nonEmptyString(item)).map((item) => String(item));
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Only a shape-safe code is ever stored or shown: a thrown Error message may hold
// document text, a path or a token. The pure policy modules (requirement-draft)
// carry the code in `message` instead of `code`, so an exact ALL-CAPS message is
// accepted as a code too; anything that is not exactly a code collapses to the
// fallback and the original text is dropped.
function safeCode(error, fallback = 'STEP_FAILED') {
  for (const candidate of [error?.code, error?.message]) {
    if (typeof candidate === 'string' && CODE_PATTERN.test(candidate)) return candidate;
  }
  return fallback;
}

function owns(container, key) {
  return isPlainObject(container) && Object.hasOwn(container, key);
}

function put(container, key, value) {
  if (!isPlainObject(container)) return;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  container[key] = value;
}

function clampIndex(value, count) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return Math.min(Math.floor(number), Math.max(0, count - 1));
}

function unique(list) {
  return [...new Set(list.filter((item) => nonEmptyString(item)))];
}

export function createRequirementRequests({
  config, store, lark, documents, decomposer, submitter, slot, clock = null, log = null,
} = {}) {
  const requirements = isPlainObject(config?.requirements) ? config.requirements : config;
  const enabled = isPlainObject(requirements)
    && isPlainObject(requirements.projects)
    && Object.keys(requirements.projects).length > 0
    && Array.isArray(requirements.allowedSenders)
    && isPlainObject(store) && typeof store.transaction === 'function' && typeof store.get === 'function'
    && isPlainObject(lark)
    && isPlainObject(slot) && typeof slot.tryStart === 'function';
  const selfOpenId = firstString(config?.selfOpenId, requirements?.selfOpenId);
  const hosts = stringsOf(requirements?.documentHosts);
  const projects = isPlainObject(requirements?.projects) ? requirements.projects : {};
  const workspaces = isPlainObject(config?.tapd?.workspaces) ? config.tapd.workspaces : {};

  const tasks = new Set();
  const pendingCards = new Map();
  const pendingStarts = new Map();
  const inFlight = new Set();
  let recoveryRun = false;

  // ------------------------------------------------------------- infrastructure

  function logLine(level, message) {
    const write = log?.[level] ?? log?.warn ?? log?.info;
    if (typeof write !== 'function') return;
    try {
      write.call(log, message);
    } catch {
      // A broken logger must not cost a workflow step.
    }
  }

  function nowDate() {
    if (typeof clock === 'function') return new Date(clock());
    if (typeof clock?.now === 'function') return new Date(clock.now());
    return new Date();
  }

  const nowIso = () => nowDate().toISOString();

  function track(work) {
    const settled = Promise.resolve()
      .then(work)
      .then(() => true, (error) => {
        logLine('error', `requirement step failed: ${safeCode(error)}`);
        return false;
      });
    tasks.add(settled);
    settled.then(() => {
      tasks.delete(settled);
    });
    return settled;
  }

  // Every heavy chain starts with this: handleMessage must resolve while the
  // work has only been reserved, never half-done.
  const toEventLoop = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  const actorIdOf = (message) => firstString(message?.sender?.id, message?.sender?.open_id);

  function isServiceMessage(message) {
    if (message?.sender?.sender_type === 'app') return true;
    const actor = actorIdOf(message);
    return actor !== '' && actor === selfOpenId;
  }

  function hasAction(card, action) {
    let found = false;
    const walk = (node) => {
      if (found || !node || typeof node !== 'object') return;
      if (node.tag === 'button' && node.behaviors?.[0]?.value?.action === action) found = true;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    };
    walk(card);
    return found;
  }

  // ------------------------------------------------------------- ledger helpers

  function actorsOf(request) {
    return unique([request.initiatorId, ...stringsOf(request.reviewerIds)]);
  }

  function cardMessageIdOf(request) {
    const ids = stringsOf(request.cardMessageIds);
    return ids.length > 0 ? ids.at(-1) : '';
  }

  function projectEntry(projectId) {
    return owns(projects, projectId) && isPlainObject(projects[projectId]) ? projects[projectId] : null;
  }

  // Only the identity fields a card and a batch may ever carry. A token path, a
  // device or any other config key stays out of the target on purpose.
  function targetFor(request) {
    const projectId = firstString(request.projectId);
    const entry = projectEntry(projectId);
    if (!entry) return null;
    const workspaceId = firstString(
      owns(workspaces, projectId) ? workspaces[projectId]?.workspaceId : null,
      entry.workspaceId,
    );
    const parentTypeId = firstString(entry.parentTypeId);
    const childTypeId = firstString(entry.childTypeId);
    const templateId = firstString(entry.templateId);
    if (workspaceId === '' || parentTypeId === '' || childTypeId === '' || templateId === '') return null;

    const owners = stringsOf(entry.owners);
    const iterations = stringsOf(entry.iterationIds);
    const selections = isPlainObject(request.selections) ? request.selections : {};
    const childDefaults = {};
    if (owners.includes(selections.owner)) childDefaults.owner = selections.owner;
    if (iterations.includes(selections.iterationId)) childDefaults.iterationId = selections.iterationId;

    const stored = isPlainObject(request.target) ? request.target : {};
    const storedParent = isPlainObject(stored.parent) ? stored.parent : {};
    const bound = firstString(request.parentStoryId, storedParent.storyId);
    const parent = {
      owner: firstString(storedParent.owner),
      iterationId: firstString(storedParent.iterationId),
    };
    if (bound !== '') {
      parent.mode = 'bind';
      parent.storyId = bound;
    } else {
      parent.mode = 'create';
      parent.title = firstString(storedParent.title, request.snapshot?.title);
    }
    if (parent.mode === 'create' && parent.title === '') return null;
    return { workspaceId, parentTypeId, childTypeId, templateId, owners, iterations, childDefaults, parent };
  }

  function verifiedParentIds(request) {
    const ids = new Set();
    if (nonEmptyString(request.parentStoryId)) ids.add(String(request.parentStoryId));
    if (nonEmptyString(request.target?.parent?.storyId)) ids.add(String(request.target.parent.storyId));
    for (const submission of listOf(request.submissions)) {
      if (!isPlainObject(submission)) continue;
      if (nonEmptyString(submission.parentStoryId)) ids.add(String(submission.parentStoryId));
      if (nonEmptyString(submission.batch?.parent?.storyId)) ids.add(String(submission.batch.parent.storyId));
      for (const item of listOf(submission.items)) {
        if (item?.key === 'parent' && nonEmptyString(item.storyId)) ids.add(String(item.storyId));
      }
    }
    return ids;
  }

  async function write(requestId, mutate) {
    await store.transaction((state) => {
      const request = owns(state.requests, requestId) ? state.requests[requestId] : null;
      if (!isPlainObject(request)) throw coded('UNKNOWN_REQUEST');
      mutate(request, state);
      return undefined;
    });
  }

  // --------------------------------------------------------------- card plumbing

  function viewOf(request) {
    const view = isPlainObject(request.view) ? request.view : {};
    return {
      mode: 'list',
      page: 0,
      storyKey: '',
      detailPage: 0,
      ...view,
    };
  }

  function render(request, viewerId, view) {
    if (!isPlainObject(request?.draft)) return null;
    try {
      return buildRequirementCard({ request, view: view ?? viewOf(request), viewerId });
    } catch (error) {
      logLine('warn', `requirement card render failed: ${safeCode(error)}`);
      return null;
    }
  }

  async function notice(request, text) {
    const messageId = cardMessageIdOf(request) || firstString(request.triggerMessageId);
    try {
      if (messageId !== '') await lark.reply(messageId, text);
      else await lark.send(request.chatId, text);
    } catch (error) {
      logLine('warn', `requirement notice lost: ${safeCode(error)}`);
    }
  }

  async function noticeMessage(message, text) {
    const messageId = firstString(message?.message_id);
    try {
      if (messageId !== '') await lark.reply(messageId, text);
      else await lark.send(firstString(message?.chat_id), text);
    } catch (error) {
      logLine('warn', `requirement reply lost: ${safeCode(error)}`);
    }
  }

  async function publish(requestId, viewerId) {
    const request = store.get(requestId);
    if (!isPlainObject(request)) return;
    const card = render(request, firstString(viewerId, request.renderViewer, request.initiatorId));
    if (!card) return;
    const trigger = firstString(request.triggerMessageId);
    try {
      const published = trigger === ''
        ? await lark.sendCard(request.chatId, card)
        : await lark.replyCard(trigger, card);
      const messageId = firstString(published?.messageId);
      if (messageId !== '') {
        await write(requestId, (target) => {
          target.cardMessageIds = [...stringsOf(target.cardMessageIds), messageId].slice(-MAX_CARD_IDS);
          target.renderViewer = firstString(viewerId, target.renderViewer, target.initiatorId);
        });
      }
    } catch (error) {
      // A lost publish is retried by flush; it never re-reads or re-creates.
      pendingCards.set(requestId, { publish: true, card, viewerId });
      logLine('warn', `requirement card publish lost: ${safeCode(error)}`);
    }
  }

  async function refresh(requestId, viewerId) {
    const request = store.get(requestId);
    if (!isPlainObject(request)) return;
    const usedViewer = firstString(viewerId, request.renderViewer, request.initiatorId);
    const card = render(request, usedViewer);
    if (!card) return;
    const messageId = cardMessageIdOf(request);
    if (messageId === '') {
      await publish(requestId, usedViewer);
      return;
    }
    try {
      await lark.updateCard(messageId, card);
      pendingCards.delete(requestId);
    } catch (error) {
      pendingCards.set(requestId, { messageId, card });
      logLine('warn', `requirement card update lost: ${safeCode(error)}`);
    }
  }

  async function drainPendingCards() {
    for (const [requestId, pending] of [...pendingCards.entries()]) {
      try {
        if (pending.publish) {
          const request = store.get(requestId);
          if (!isPlainObject(request)) {
            pendingCards.delete(requestId);
            continue;
          }
          const card = render(request, firstString(pending.viewerId, request.renderViewer, request.initiatorId));
          if (!card) {
            pendingCards.delete(requestId);
            continue;
          }
          await publish(requestId, pending.viewerId);
          if (cardMessageIdOf(store.get(requestId) ?? {}) === '') continue;
          pendingCards.delete(requestId);
        } else {
          await lark.updateCard(pending.messageId, pending.card);
          pendingCards.delete(requestId);
        }
      } catch (error) {
        logLine('warn', `requirement card retry lost: ${safeCode(error)}`);
      }
    }
  }

  // ------------------------------------------------------------------ the gate

  function parseAction(event) {
    if (!isPlainObject(event) || event.type !== 'card.action.trigger') return null;
    const chatId = firstString(event.chat_id);
    const messageId = firstString(event.message_id);
    const actorId = firstString(event.operator_id);
    if (chatId === '' || chatId.length > 120) return null;
    if (!OPEN_ID_PATTERN.test(messageId) || !OPEN_ID_PATTERN.test(actorId)) return null;
    let value = event.action_value;
    if (typeof value === 'string') {
      if (value.length > MAX_ACTION_VALUE_CHARS) return null;
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (!isPlainObject(value)) return null;
    if (Object.keys(value).some((key) => !VALUE_KEYS.includes(key))) return null;
    if (value.workflow !== WORKFLOW) return null;
    const requestId = firstString(value.requestId);
    const action = firstString(value.action);
    const key = firstString(value.key);
    if (!ID_PATTERN.test(requestId)) return null;
    if (!ALLOWED_ACTIONS.has(action)) return null;
    if (key.length > MAX_KEY) return null;
    if (!Number.isSafeInteger(value.draftVersion) || value.draftVersion < 0) return null;
    if (!Number.isSafeInteger(value.page) || value.page < 0 || value.page > MAX_PAGE) return null;
    return { requestId, action, key, draftVersion: value.draftVersion, page: value.page, chatId, messageId, actorId };
  }

  // The same checks are run at accept time and again inside the commit
  // transaction, so two presses on one card serialize against the ledger instead
  // of against a snapshot of it.
  function gateRequest(request, value, { nav = false } = {}) {
    if (!isPlainObject(request)) return { ok: false, code: 'UNKNOWN_REQUEST' };
    if (request.chatId !== value.chatId) return { ok: false, code: 'CROSS_CHAT' };
    if (!stringsOf(request.cardMessageIds).includes(value.messageId) && request.triggerMessageId !== value.messageId) {
      return { ok: false, code: 'UNKNOWN_CARD' };
    }
    const state = reviewState(request, value.actorId);
    // 身份 before 版本: the plan fixes the order as chat → card → identity →
    // version, so an actor who is not on the request never learns whether the
    // version they pressed at is current. Both refusals deny everything; only the
    // coded outcome differs, and it stays distinct for the reviewer who *is* on
    // the request.
    if (!state.allowed) return { ok: false, code: 'NOT_REVIEWER' };
    if (value.draftVersion !== state.version) return { ok: false, code: 'STALE_VERSION' };
    if (nav) return { ok: true, state };
    // A batch that is being written holds the request: saying "提交中" is truer
    // than the generic status refusal, because the reason is the in-flight batch.
    if (EDIT_ACTIONS.has(value.action) && (state.ledger.running || request.status === STATUS.SUBMITTING)) {
      return { ok: false, code: 'BATCH_IN_FLIGHT' };
    }
    if (!state.writable) return { ok: false, code: 'NOT_WRITABLE' };
    return { ok: true, state };
  }

  function refusal(code) {
    return REFUSALS[code] ?? REFUSALS.STEP_FAILED;
  }

  // ------------------------------------------------------------------ slot work

  async function reserve(requestId, work) {
    const heldRequest = () => {
      const current = store.get(requestId);
      return isPlainObject(current) ? current : null;
    };
    // Claimed synchronously, before anything is awaited, so recovery and a second
    // press see the reservation instead of racing it.
    if (inFlight.has(requestId)) {
      const current = heldRequest();
      if (current) await notice(current, NOTICE.busy);
      return false;
    }
    inFlight.add(requestId);
    let reservation = null;
    try {
      reservation = slot.tryStart(`requirement:${requestId}`, () => Promise.resolve()
        .then(work)
        .finally(() => {
          inFlight.delete(requestId);
        }));
    } catch (error) {
      inFlight.delete(requestId);
      logLine('error', `requirement slot refused to start: ${safeCode(error)}`);
      const current = heldRequest();
      if (current) await notice(current, NOTICE.busy);
      return false;
    }
    if (!isPlainObject(reservation) || reservation.accepted !== true) {
      inFlight.delete(requestId);
      const current = heldRequest();
      if (current) await notice(current, NOTICE.busy);
      return false;
    }
    // The slot contract says a rejection from `done` belongs to us.
    track(() => reservation.done);
    return true;
  }

  // ------------------------------------------------------------------ navigation

  function targetView(request, value) {
    const current = viewOf(request);
    switch (value.action) {
      case 'list_prev':
      case 'list_next':
        return { ...current, mode: 'list', page: value.page };
      case 'detail':
        return { ...current, mode: 'detail', storyKey: value.key, detailPage: 0 };
      case 'detail_prev':
      case 'detail_next':
        return { ...current, mode: 'detail', storyKey: value.key, detailPage: value.page };
      case 'back':
        return { mode: 'list', page: value.page, storyKey: current.storyKey, detailPage: 0 };
      case 'confirm':
        return { ...current, mode: 'confirm', page: 0 };
      case 'confirm_prev':
      case 'confirm_next':
        return { ...current, mode: 'confirm', page: value.page };
      default:
        return current;
    }
  }

  function listPageCount(request) {
    return Math.max(1, Math.ceil(listOf(request.draft?.stories).length / LIST_PAGE_SIZE));
  }

  // Page indices are stored as numbers, exactly as the seeded ledger writes them,
  // so the card policy and this module never disagree about what was seen.
  function pageIndices(value, limit) {
    const seen = [];
    for (const item of listOf(value)) {
      const index = Number(item);
      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_PAGE) continue;
      if (index >= limit) continue;
      if (!seen.includes(index)) seen.push(index);
    }
    return seen.sort((left, right) => left - right);
  }

  function detailPageMap(value) {
    if (!isPlainObject(value)) return {};
    const out = {};
    for (const [key, pages] of Object.entries(value)) {
      if (!ID_PATTERN.test(key)) continue;
      out[key] = pageIndices(pages, MAX_SERIES_WALK);
    }
    return out;
  }

  function progressFor(record) {
    return {
      draftVersion: Number.isSafeInteger(record.draftVersion) ? record.draftVersion : 0,
      pagesSeen: pageIndices(record.pagesSeen, MAX_PAGE + 1),
      detailSeen: unique(stringsOf(record.detailSeen)),
      detailPages: detailPageMap(record.detailPages),
      confirmSeen: record.confirmSeen === true ? true : pageIndices(record.confirmSeen, MAX_SERIES_WALK),
    };
  }

  function appendIndex(list, index) {
    if (!list.includes(index)) list.push(index);
    return list.sort((left, right) => left - right);
  }

  async function applyNavigation(value, request) {
    const viewerId = value.actorId;
    const version = reviewState(request, viewerId).version;
    const view = targetView(request, value);
    // A list page beyond the last one is clamped before it is remembered, so the
    // reviewer is never credited with a page that cannot exist.
    if (view.mode === 'list') view.page = clampIndex(view.page, listPageCount(request));
    const preview = structuredClone(request);
    preview.view = view;
    const card = render(preview, viewerId, view);
    if (!card) {
      // No draft yet (a request that is still being read, or is waiting for a
      // target): navigation cannot show anything, and it must not approve either.
      return;
    }
    const progress = isPlainObject(request.viewByActor) && owns(request.viewByActor, viewerId)
      ? progressFor(request.viewByActor[viewerId])
      : progressFor({});
    if (progress.draftVersion !== version) Object.assign(progress, progressFor({}));
    progress.draftVersion = version;

    if (view.mode === 'list') {
      appendIndex(progress.pagesSeen, view.page);
    } else if (view.mode === 'detail') {
      const key = firstString(view.storyKey);
      const known = listOf(request.draft?.stories).some((story) => story?.key === key);
      if (known) {
        const segment = clampIndex(view.detailPage, MAX_SERIES_WALK);
        const seen = appendIndex(pageIndices(progress.detailPages[key], MAX_SERIES_WALK), segment);
        put(progress.detailPages, key, seen);
        // Only the rendered card knows where the series ends, and the read counts
        // only when every segment from 0 up to that last one was walked in order.
        const finished = !hasAction(card, 'detail_next');
        const contiguous = seen.length > 0 && seen.at(-1) === segment && seen.every((index, position) => index === position);
        if (finished && contiguous) appendIndex(progress.detailSeen, key);
      }
    } else if (view.mode === 'confirm' && progress.confirmSeen !== true) {
      const page = clampIndex(view.page, MAX_SERIES_WALK);
      const seen = appendIndex(progress.confirmSeen, page);
      const finished = !hasAction(card, 'confirm_next');
      const contiguous = seen.length > 0 && seen.every((index, position) => index === position);
      progress.confirmSeen = finished && contiguous ? true : seen;
    }

    await write(value.requestId, (target) => {
      target.view = view;
      target.renderViewer = viewerId;
      put(target.viewByActor, viewerId, progress);
    });
    const fresh = store.get(value.requestId);
    const finalCard = render(fresh, viewerId);
    if (finalCard) {
      const messageId = cardMessageIdOf(fresh);
      try {
        await lark.updateCard(messageId, finalCard);
        pendingCards.delete(value.requestId);
      } catch (error) {
        pendingCards.set(value.requestId, { messageId, card: finalCard });
        logLine('warn', `requirement navigation patch lost: ${safeCode(error)}`);
      }
    }
  }

  // The confirm card owns the real segment count, so the server-side gate has to
  // derive it by rendering. `true` in the ledger already means the whole series
  // was walked and needs no count.
  function confirmPageCount(request, viewerId) {
    const progress = isPlainObject(request.viewByActor) && owns(request.viewByActor, viewerId)
      ? request.viewByActor[viewerId]
      : null;
    if (isPlainObject(progress) && progress.confirmSeen === true) return 1;
    for (let page = 0; page < MAX_SERIES_WALK; page += 1) {
      const preview = structuredClone(request);
      preview.view = { mode: 'confirm', page, storyKey: '', detailPage: 0 };
      const card = render(preview, viewerId, preview.view);
      if (!card) return Math.max(1, page + 1);
      if (!hasAction(card, 'confirm_next')) return page + 1;
    }
    throw coded('CARD_SERIES_UNBOUNDED');
  }

  function gatePageCount(request, viewerId, state) {
    if (state.confirmSeenValue === true) return 1;
    return confirmPageCount(request, viewerId);
  }

  // ----------------------------------------------------------------- submission

  function summaryStatus(request, result) {
    const created = new Set();
    for (const submission of listOf(request.submissions)) {
      for (const item of listOf(submission.items)) {
        if (item?.status === 'created' && nonEmptyString(item.key)) created.add(item.key);
      }
    }
    const remaining = listOf(request.draft?.stories)
      .filter((story) => story?.disposition !== 'excluded' && !created.has(story.key));
    if (result?.status === 'completed' && remaining.length === 0) return STATUS.COMPLETED;
    if (remaining.length > 0 && created.size > 0 && result?.status === 'completed') return STATUS.PARTIAL;
    if (result?.status === 'needs_review') return remaining.length > 0 && created.size > 0 ? STATUS.PARTIAL : STATUS.NEEDS_REVIEW;
    return STATUS.NEEDS_REVIEW;
  }

  async function recordResult(requestId, batchId, result) {
    const codes = listOf(result?.notes)
      .map((note) => (typeof note === 'string' ? note : firstString(note?.code)))
      .filter((code) => CODE_PATTERN.test(code));
    const parentStoryId = firstString(result?.parentStoryId);
    let blocked = '';
    if (result?.status === 'paused') {
      blocked = codes.find((code) => code.startsWith('PARENT_'))
        ?? codes.find((code) => code === 'SOURCE_CHANGED' || code === 'SOURCE_RECHECK_FAILED')
        ?? codes[0]
        ?? 'BATCH_PAUSED';
    } else if (result?.status === 'needs_review') {
      blocked = codes.find((code) => code.startsWith('PARENT_')) ?? '';
    }
    await write(requestId, (request) => {
      const submission = listOf(request.submissions).find((entry) => entry?.batch?.id === batchId);
      if (isPlainObject(submission)) request.lastBatchId = batchId;
      const known = firstString(request.parentStoryId);
      if (parentStoryId !== '' && known !== '' && known !== parentStoryId) {
        request.parentConflict = parentStoryId;
      } else if (parentStoryId !== '') {
        request.parentStoryId = parentStoryId;
      }
      request.status = submission ? summaryStatus(request, result) : STATUS.NEEDS_REVIEW;
      request.blockedReason = blocked;
      request.pendingInput = null;
    });
    const request = store.get(requestId);
    if (isPlainObject(request)) {
      const hint = SUBMIT_NOTE_HINTS[blocked];
      await notice(request, hint ?? (result?.status === 'completed' ? NOTICE.submitted : `本批结果：${firstString(result?.status, 'unknown')}，请核对卡片与台账。`));
    }
  }

  async function runSubmit(value) {
    await toEventLoop();
    const requestId = value.requestId;
    const current = store.get(requestId);
    if (!isPlainObject(current)) return;
    if (typeof documents?.revalidate !== 'function') {
      await notice(current, refusal('SOURCE_RECHECK_FAILED'));
      return;
    }
    // 来源重检 before freezing: a batch must never be built against a document
    // that has already moved.
    let recheck = null;
    let recheckError = null;
    try {
      recheck = await documents.revalidate(current.snapshot);
    } catch (error) {
      recheckError = error;
    }
    if (recheckError || !isPlainObject(recheck)) {
      await notice(current, refusal(recheckError ? safeCode(recheckError, 'SOURCE_RECHECK_FAILED') : 'SOURCE_RECHECK_FAILED'));
      return;
    }
    if (recheck.unchanged !== true) {
      await write(requestId, (target) => {
        target.blockedReason = 'SOURCE_CHANGED';
      });
      await notice(store.get(requestId) ?? current, refusal('SOURCE_CHANGED'));
      return;
    }

    // The confirm series length is only known by rendering the confirm card page
    // by page (up to MAX_SERIES_WALK renders), so it is derived here, *before* the
    // ledger transaction opens, instead of inside it: the transaction is the one
    // serialised write window every other reviewer waits behind. The count is
    // stamped with the draft version it was derived from and the transaction
    // refuses to trust it across a version change — the same stale-void discipline
    // the per-actor review ledger already uses.
    const counted = store.get(requestId);
    const preGate = gateRequest(counted, value);
    let countedPages = null;
    let countedVersion = -1;
    if (preGate.ok) {
      try {
        countedPages = gatePageCount(counted, value.actorId, preGate.state);
        countedVersion = preGate.state.version;
      } catch (error) {
        // No hint: the transaction re-derives the count and reports it there,
        // exactly as it did before, so an unbounded series still fails the same way.
        logLine('warn', `requirement confirm count deferred: ${safeCode(error)}`);
      }
    }

    let batchId = '';
    try {
      await store.transaction((state) => {
        const target = owns(state.requests, requestId) ? state.requests[requestId] : null;
        if (!isPlainObject(target)) throw coded('UNKNOWN_REQUEST');
        const gate = gateRequest(target, value);
        if (!gate.ok) throw coded(gate.code);
        const pageCount = gate.state.confirmSeenValue === true
          ? 1
          : (countedPages !== null && countedVersion === gate.state.version
            ? countedPages
            : gatePageCount(target, value.actorId, gate.state));
        const reasons = submitGate(gate.state, pageCount);
        if (reasons.length > 0) {
          if (missingDetails(gate.state).length > 0 && !confirmSeenOk(gate.state, pageCount)) throw coded('NOTHING_TO_SUBMIT');
          throw coded('GATE_CLOSED');
        }
        const selected = gate.state.selected;
        if (selected.length === 0) throw coded('NOTHING_TO_SUBMIT');
        const targetConfig = targetFor(target);
        if (!targetConfig) throw coded('INVALID_TARGET');
        batchId = `batch-${randomUUID()}`;
        const frozen = freezeBatch({
          request: target,
          selectedKeys: selected,
          target: targetConfig,
          actorId: value.actorId,
          now: nowDate(),
          batchId,
        });
        const at = nowIso();
        target.submissions = [...listOf(target.submissions), {
          id: frozen.id,
          requestId: frozen.requestId,
          batch: frozen,
          payloadHash: frozen.payloadHash,
          status: 'pending',
          parentStoryId: null,
          startedAt: null,
          updatedAt: at,
          items: [],
          notes: [],
        }];
        target.status = STATUS.SUBMITTING;
        target.blockedReason = '';
        return undefined;
      });
    } catch (error) {
      const code = safeCode(error);
      const fresh = store.get(requestId);
      if (isPlainObject(fresh)) await notice(fresh, refusal(code === 'SUBMISSION_BLOCKED' ? 'GATE_CLOSED' : code));
      await refresh(requestId, value.actorId);
      return;
    }

    let result = null;
    let failure = null;
    try {
      result = await submitter.submit({ requestId, batchId });
    } catch (error) {
      failure = error;
    }
    if (failure) await recordFailure(requestId, failure);
    else await recordResult(requestId, batchId, result);
    await refresh(requestId, value.actorId);
  }

  async function runBatchAction(value, mode) {
    await toEventLoop();
    const requestId = value.requestId;
    const current = store.get(requestId);
    if (!isPlainObject(current)) return;
    const batchId = mode === 'resume'
      ? firstString(current.lastBatchId, listOf(current.submissions).at(-1)?.batch?.id)
      : firstString(listOf(current.submissions).at(-1)?.batch?.id);
    if (batchId === '') {
      await notice(current, NOTICE.noBatch);
      return;
    }
    let result = null;
    let failure = null;
    try {
      result = mode === 'reconcile'
        ? await submitter.reconcile({ requestId, batchId })
        : await submitter.resume({ requestId, batchId, actorId: value.actorId });
    } catch (error) {
      failure = error;
    }
    if (failure) await recordFailure(requestId, failure);
    else await recordResult(requestId, batchId, result);
    await refresh(requestId, value.actorId);
  }

  // A submitter that refused outright still has to be recorded: an unrecorded
  // result is exactly the state that lets a story be created twice.
  async function recordFailure(requestId, error) {
    const code = safeCode(error);
    await write(requestId, (request) => {
      request.status = STATUS.NEEDS_REVIEW;
      request.blockedReason = code;
    });
    const request = store.get(requestId);
    if (isPlainObject(request)) await notice(request, `${refusal(code)}（${code}）`);
  }

  // ------------------------------------------------------------- content writes

  async function commitDecision(requestId, value, decision) {
    let failure = null;
    try {
      await store.transaction((state) => {
        const request = owns(state.requests, requestId) ? state.requests[requestId] : null;
        if (!isPlainObject(request)) throw coded('UNKNOWN_REQUEST');
        const gate = gateRequest(request, value);
        if (!gate.ok) throw coded(gate.code);
        const updated = applyReviewDecision({ request, actorId: value.actorId, decision });
        try {
          validateDraft({ draft: updated.draft, snapshot: updated.snapshot, actorIds: actorsOf(updated) });
        } catch (error) {
          throw coded(safeCode(error, 'VERIFY_FAILED'));
        }
        state.requests[requestId] = updated;
        return undefined;
      });
    } catch (error) {
      failure = safeCode(error);
    }
    const request = store.get(requestId);
    if (!isPlainObject(request)) return;
    if (failure) await notice(request, refusal(failure));
    else await write(requestId, (target) => {
      target.pendingInput = null;
    });
    await refresh(requestId, value.actorId);
  }

  async function askPrompt(value, kind, extra = {}) {
    await write(value.requestId, (target) => {
      target.pendingInput = { kind, actorId: value.actorId, storyKey: firstString(value.key, extra.storyKey) };
    });
    const fresh = store.get(value.requestId);
    if (!isPlainObject(fresh)) return;
    const prompts = {
      answer: `${NOTICE.needAnswer}（请求 ${fresh.id}）`,
      exclude: NOTICE.needExcludeReason,
      owner: NOTICE.pickOwner,
      iteration: NOTICE.pickIteration,
      project: NOTICE.pickProject,
    };
    await notice(fresh, prompts[kind] ?? NOTICE.pickProject);
    await refresh(value.requestId, value.actorId);
  }

  async function askParent(value, request) {
    const candidates = [...verifiedParentIds(request)];
    await write(value.requestId, (target) => {
      target.pendingInput = { kind: 'parent', actorId: value.actorId };
    });
    const fresh = store.get(value.requestId);
    if (!isPlainObject(fresh)) return;
    await notice(fresh, candidates.length > 0 ? `${NOTICE.pickParent}可选：${candidates.join('、')}。` : `${NOTICE.pickParent} ${NOTICE.pickParentEmpty}`);
    await refresh(value.requestId, value.actorId);
  }

  async function cancelRequest(value) {
    let failure = null;
    try {
      await write(value.requestId, (request) => {
        const gate = gateRequest(request, value);
        if (!gate.ok) throw coded(gate.code);
        if (cancelGate(gate.state) !== '') throw coded('CANCEL_AFTER_WRITE');
        request.status = STATUS.CANCELLED;
        request.pendingInput = null;
        request.blockedReason = 'CANCELLED';
      });
    } catch (error) {
      failure = safeCode(error);
    }
    const fresh = store.get(value.requestId);
    if (!isPlainObject(fresh)) return;
    if (failure) await notice(fresh, refusal(failure));
    await refresh(value.requestId, value.actorId);
  }

  // ------------------------------------------------------------------- analysis

  async function analysisFailure(requestId, code) {
    await write(requestId, (request) => {
      request.status = STATUS.FAILED;
      request.blockedReason = code;
    }).catch((error) => {
      logLine('warn', `requirement failure write lost: ${safeCode(error)}`);
    });
    logLine('warn', `requirement step ${requestId} failed: ${code}`);
    const request = store.get(requestId);
    if (isPlainObject(request)) await notice(request, `需求文档处理未完成：${code}，可重试。`);
  }

  async function analyzeRequest(requestId, actorId) {
    await toEventLoop();
    const request = store.get(requestId);
    if (!isPlainObject(request)) return;
    const document = isPlainObject(request.document) ? request.document : {};
    let snapshot = null;
    let error = null;
    try {
      snapshot = await documents.read({
        requestId,
        url: firstString(document.url),
        kind: firstString(document.kind) || undefined,
        token: firstString(document.token) || undefined,
      });
    } catch (caught) {
      error = caught;
    }
    if (error || !isPlainObject(snapshot) || !Array.isArray(snapshot.blocks)) {
      await analysisFailure(requestId, safeCode(error, 'SOURCE_READ_FAILED'));
      return;
    }
    await write(requestId, (target) => {
      target.snapshot = snapshot;
      target.status = STATUS.ANALYZING;
      target.blockedReason = '';
    }).catch((caught) => {
      logLine('warn', `requirement read mark lost: ${safeCode(caught)}`);
    });

    let draft = null;
    error = null;
    try {
      draft = await decomposer.analyze(snapshot);
      const fresh = store.get(requestId);
      validateDraft({ draft, snapshot, actorIds: actorsOf(isPlainObject(fresh) ? fresh : request) });
    } catch (caught) {
      error = caught;
    }
    if (error || !isPlainObject(draft)) {
      await analysisFailure(requestId, safeCode(error, 'ANALYSIS_INVALID'));
      return;
    }
    try {
      await store.transaction((state) => {
        const target = owns(state.requests, requestId) ? state.requests[requestId] : null;
        if (!isPlainObject(target)) throw coded('UNKNOWN_REQUEST');
        target.draft = draft;
        target.status = STATUS.AWAITING;
        target.blockedReason = '';
        target.pendingInput = null;
        target.view = { mode: 'list', page: 0, storyKey: '', detailPage: 0 };
        target.viewByActor = {};
      });
    } catch (caught) {
      await analysisFailure(requestId, safeCode(caught, 'LEDGER_WRITE_FAILED'));
      return;
    }
    await publish(requestId, actorId);
    const published = store.get(requestId);
    if (isPlainObject(published)) await notice(published, `草稿已生成（v${published.draft?.version ?? 1}），请在审核卡逐张确认后提交。`);
  }

  async function reviseRequest(requestId, actorId, instruction) {
    await toEventLoop();
    const base = store.get(requestId);
    if (!isPlainObject(base)) return;
    const baseVersion = reviewState(base, actorId).version;
    let draft = null;
    let error = null;
    try {
      const recheck = await documents.revalidate(base.snapshot);
      if (!isPlainObject(recheck) || recheck.unchanged !== true) throw coded('SOURCE_CHANGED');
      draft = await decomposer.revise({ snapshot: base.snapshot, draft: base.draft, instruction });
    } catch (caught) {
      error = caught;
    }
    const request = store.get(requestId);
    if (error || !isPlainObject(draft)) {
      const code = safeCode(error);
      await notice(request ?? base, `改稿未完成：${code}，草稿保持 v${baseVersion}。`);
      logLine('warn', `requirement revise ${requestId} failed: ${code}`);
      return;
    }
    let failure = null;
    try {
      await store.transaction((state) => {
        const target = owns(state.requests, requestId) ? state.requests[requestId] : null;
        if (!isPlainObject(target)) throw coded('UNKNOWN_REQUEST');
        const state2 = reviewState(target, actorId);
        // Same order as `gateRequest`: 身份 before 版本, so the re-check inside the
        // transaction cannot leak the version state to a non-reviewer either.
        if (!state2.allowed) throw coded('NOT_REVIEWER');
        if (state2.version !== baseVersion) throw coded('STALE_VERSION');
        if (!state2.writable) throw coded('NOT_WRITABLE');
        if (state2.ledger.running) throw coded('BATCH_IN_FLIGHT');
        const revised = structuredClone(draft);
        revised.decisions = [...listOf(revised.decisions), {
          id: randomUUID(),
          actorId,
          text: instruction.slice(0, MAX_DECISION_TEXT),
          sourceIds: [],
        }];
        try {
          validateDraft({ draft: revised, snapshot: target.snapshot, actorIds: actorsOf(target) });
        } catch (caught) {
          throw coded(safeCode(caught, 'VERIFY_FAILED'));
        }
        target.draft = revised;
        target.pendingInput = null;
        return undefined;
      });
    } catch (caught) {
      failure = safeCode(caught);
    }
    const fresh = store.get(requestId);
    if (!isPlainObject(fresh)) return;
    if (failure) await notice(fresh, refusal(failure));
    else await notice(fresh, `已按指令改稿至 v${fresh.draft?.version ?? ''}，此前的审核范围已作废。`);
    await refresh(requestId, actorId);
  }

  // ------------------------------------------------------------------- messages

  function rememberedStart(message) {
    const threads = [message?.parent_id, message?.root_id].filter((id) => nonEmptyString(id));
    for (const thread of threads) {
      const key = `${firstString(message?.chat_id)}|${thread}`;
      if (pendingStarts.has(key)) return { key, entry: pendingStarts.get(key) };
    }
    return null;
  }

  function rememberStart(message, documents) {
    const key = `${firstString(message?.chat_id)}|${firstString(message?.message_id)}`;
    if (pendingStarts.size >= MAX_PENDING_STARTS) {
      const oldest = pendingStarts.keys().next().value;
      if (oldest !== undefined) pendingStarts.delete(oldest);
    }
    pendingStarts.set(key, { documents, at: nowIso() });
    return key;
  }

  function parseChoice(text, count) {
    const trimmed = text.trim();
    const digits = /^(\d{1,3})$/.exec(trimmed);
    if (digits) {
      const index = Number(digits[1]);
      return index >= 1 && index <= count ? index - 1 : null;
    }
    return null;
  }

  // Re-applies the host allow-list to a pasted link and then matches it against
  // the documents this thread actually offered.
  function offeredDocument(text, documents) {
    let parsed = null;
    try {
      parsed = normalizeDocumentLink(text, { hosts });
    } catch {
      return null;
    }
    if (!parsed) return null;
    const key = `${parsed.kind}:${parsed.token}`;
    return listOf(documents).find((item) => `${item?.kind}:${item?.token}` === key) ?? null;
  }

  async function createRequest(message, document, actorId) {
    const chatId = firstString(message?.chat_id);
    if (chatId === '' || !ID_PATTERN.test(chatId)) return null;
    const projectId = resolveProject(extractPlainText(message));
    const record = {
      id: `req_${randomUUID()}`,
      chatId,
      triggerMessageId: firstString(message?.message_id),
      cardMessageIds: [],
      initiatorId: actorId,
      reviewerIds: unique([...stringsOf(requirements?.reviewers), actorId]),
      projectId,
      status: STATUS.AWAITING,
      document,
      docKey: `${document.kind}:${document.token}`,
      // The existing parent is a config fact for this project, so every request
      // starts already bound to it; the card can only confirm or replace it.
      parentStoryId: firstString(requirements?.projects?.[projectId]?.parentStoryId) || null,
      submissions: [],
      viewByActor: {},
      blockedReason: projectId === '' ? 'PROJECT_UNRESOLVED' : '',
      pendingInput: projectId === '' ? { kind: 'project', actorId: null } : null,
    };
    try {
      await store.transaction((state) => {
        put(state.requests, record.id, record);
        return undefined;
      });
    } catch (error) {
      logLine('error', `requirement ledger write failed: ${safeCode(error)}`);
      return null;
    }
    return record;
  }

  function resolveProject(text) {
    const keys = Object.keys(projects);
    if (keys.length === 1) return keys[0];
    const found = keys.filter((id) => text.toLowerCase().includes(id.toLowerCase()));
    return found.length === 1 ? found[0] : '';
  }

  // One mapping per document, in the whole ledger, whatever the project ends up
  // being: a second start for a document that already has a draft (or a batch)
  // returns the existing request instead of building a competing mapping.
  function openRequestFor(docKey) {
    for (const request of store.list()) {
      if (!isPlainObject(request)) continue;
      if (firstString(request.docKey) !== docKey) continue;
      if (CLOSED_STATUSES.has(request.status)) continue;
      return request;
    }
    return null;
  }

  // The heavy chain is announced before it is reserved, so a restart between the
  // two never sees a healthy-looking request with no draft. If the slot refuses
  // the reservation, the request goes back to waiting for a reviewer.
  async function beginAnalysis(requestId, actorId) {
    await write(requestId, (target) => {
      target.status = STATUS.READING;
      target.blockedReason = '';
    });
    const started = await reserve(requestId, () => analyzeRequest(requestId, actorId));
    if (!started) {
      await write(requestId, (target) => {
        target.status = STATUS.AWAITING;
        target.blockedReason = 'SLOT_BUSY';
      }).catch((error) => {
        logLine('warn', `requirement busy rollback lost: ${safeCode(error)}`);
      });
    }
    return started;
  }

  async function startFlow(message, links, actorId) {
    if (!stringsOf(requirements?.allowedSenders).includes(actorId)) {
      await noticeMessage(message, NOTICE.notSender);
      return;
    }
    if (links.length > 1) {
      rememberStart(message, links);
      const list = links.map((item, index) => `${index + 1}. ${item.url}`).join('\n');
      await noticeMessage(message, `${NOTICE.multipleDocuments}\n${list}`);
      return;
    }
    const document = links[0];
    const docKey = `${document.kind}:${document.token}`;
    const existing = openRequestFor(docKey);
    if (existing) {
      const hasDraft = isPlainObject(existing.draft);
      if (hasDraft || listOf(existing.submissions).length > 0) {
        await noticeMessage(message, `${NOTICE.duplicate}请求 ${existing.id}（草稿 v${existing.draft?.version ?? 1}）。`);
        await refresh(existing.id, existing.initiatorId);
        return;
      }
      // The previous attempt never produced anything: retry it in place instead of
      // adding a second mapping for the same document.
      await noticeMessage(message, `请求 ${existing.id} 尚未完成，继续用它重试。`);
      if (firstString(existing.projectId) !== '') {
        await beginAnalysis(existing.id, actorId);
      } else {
        await noticeMessage(message, NOTICE.pickProject);
      }
      return;
    }
    const record = await createRequest(message, document, actorId);
    if (!record) {
      await noticeMessage(message, REFUSALS.STEP_FAILED);
      return;
    }
    await noticeMessage(message, record.projectId === '' ? `${NOTICE.ack} ${NOTICE.pickProject}` : NOTICE.ack);
    if (record.projectId === '') return;
    await beginAnalysis(record.id, actorId);
  }

  async function editFlow(classified, actorId, message) {
    const request = store.get(classified.requestId);
    if (!isPlainObject(request)) {
      await noticeMessage(message, REFUSALS.UNKNOWN_REQUEST);
      return;
    }
    const value = {
      requestId: request.id,
      draftVersion: reviewState(request, actorId).version,
      // The chat comes from the incoming message, exactly as the card-callback
      // path takes `event.chat_id`, so naming the request from another group
      // cannot spoof the gate; notices still go to the request's own chat.
      chatId: firstString(message?.chat_id),
      messageId: firstString(classified.parentId, cardMessageIdOf(request), request.triggerMessageId),
      actorId,
      action: 'approve',
      key: '',
      page: 0,
    };
    const gate = gateRequest(request, value);
    if (!gate.ok) {
      await notice(request, refusal(gate.code));
      return;
    }
    const instruction = firstString(classified.text).trim();
    if (instruction === '' || instruction.length > MAX_INSTRUCTION_CHARS) {
      await notice(request, NOTICE.emptyInstruction);
      return;
    }
    if (!isPlainObject(request.draft)) {
      await notice(request, '本需求还没有草稿，无法改稿。');
      return;
    }
    await reserve(request.id, () => reviseRequest(request.id, actorId, instruction));
  }

  async function applyReply(request, value, kind, decision) {
    if (kind === 'iteration') {
      // Chosen discipline: `validateDraft` inside this transaction, NOT
      // `applyReviewDecision`. Its `select-fields` decision shape carries `owner`
      // only and an iteration is a request-level selection (`selections.iterationId`,
      // read back by `targetFor`), never a draft story field, so the pure policy has
      // no decision type for it and none is invented here. The revalidation the plan
      // demands (字段变更 递增草稿版本并重校验) is therefore run on the mutated draft
      // in the same transaction, with exactly one version bump per accepted change
      // and the whole change refused if the draft policy rejects it.
      let failure = null;
      try {
        await write(request.id, (target) => {
          const gate = gateRequest(target, value);
          if (!gate.ok) throw coded(gate.code);
          if (!isPlainObject(target.draft)) throw coded('VERIFY_FAILED');
          target.selections = { ...(isPlainObject(target.selections) ? target.selections : {}), iterationId: decision.iterationId };
          target.draft.version += 1;
          target.draft.decisions = [...listOf(target.draft.decisions), {
            id: randomUUID(), actorId: value.actorId, text: `iteration: ${decision.iterationId}`, sourceIds: [],
          }];
          target.pendingInput = null;
          try {
            validateDraft({ draft: target.draft, snapshot: target.snapshot, actorIds: actorsOf(target) });
          } catch (error) {
            // A revalidation failure answers with the one refusal that means "the
            // draft policy did not accept this change"; the policy's own code is
            // logged, never shown, so the chat keeps a fixed coded string.
            logLine('warn', `requirement iteration revalidation failed: ${safeCode(error, 'VERIFY_FAILED')}`);
            throw coded('VERIFY_FAILED');
          }
        });
      } catch (error) {
        failure = safeCode(error);
      }
      const fresh = store.get(request.id);
      if (!isPlainObject(fresh)) return;
      if (failure) await notice(fresh, refusal(failure));
      await refresh(request.id, value.actorId);
      return;
    }
    if (kind === 'parent') {
      await write(request.id, (target) => {
        const gate = gateRequest(target, value);
        if (!gate.ok) throw coded(gate.code);
        target.parentBindOverride = { actorId: value.actorId, storyId: decision.storyId, at: nowIso() };
        target.parentStoryId = decision.storyId;
        target.pendingInput = null;
      });
      await refresh(request.id, value.actorId);
      return;
    }
    if (kind === 'project') {
      await write(request.id, (target) => {
        const gate = gateRequest(target, value);
        if (!gate.ok) throw coded(gate.code);
        // The parent binding is per project, so a project chosen after the request
        // was created (the document named no project) must pick it up here —
        // otherwise the batch would create a duplicate parent for a document that
        // already has one. An explicit reviewer binding still wins.
        const configured = firstString(requirements?.projects?.[decision.projectId]?.parentStoryId);
        if (configured !== '' && !nonEmptyString(target.parentBindOverride?.storyId)) {
          target.parentStoryId = configured;
        }
        target.projectId = decision.projectId;
        target.blockedReason = '';
        target.pendingInput = null;
      });
      const fresh = store.get(request.id);
      if (isPlainObject(fresh) && !isPlainObject(fresh.draft)) {
        await beginAnalysis(fresh.id, value.actorId);
        return;
      }
      await refresh(request.id, value.actorId);
      return;
    }
    await commitDecision(request.id, value, decision);
  }

  // The chat id is the message's own chat, never the request's: a reply written
  // in another group is a cross-chat write even when it quotes the right request
  // and the right thread. A reply in the card's thread is still in-chat, because
  // that thread lives in the request's chat.
  function replyValue(request, message, actorId) {
    return {
      requestId: request.id,
      draftVersion: reviewState(request, actorId).version,
      chatId: firstString(message?.chat_id),
      messageId: firstString(
        message?.parent_id, message?.root_id, message?.message_id,
        cardMessageIdOf(request), request.triggerMessageId,
      ),
      actorId,
      action: 'answer',
      key: '',
      page: 0,
    };
  }

  function splitFields(text) {
    return text.split(/[·|｜]/).map((part) => part.trim()).filter((part) => part !== '');
  }

  // A thread reply is read against the request it belongs to. Identities come
  // from the message sender, never from anything written in the body.
  async function handleReply(request, message, actorId) {
    const text = extractPlainText(message).trim().slice(0, MAX_REPLY_CHARS);
    if (text === '') return false;
    const value = replyValue(request, message, actorId);
    const gate = gateRequest(request, value);
    if (!gate.ok) {
      await notice(request, refusal(gate.code));
      return true;
    }
    if (text.startsWith('修改拆分')) {
      const instruction = text.slice('修改拆分'.length).replace(/^[\s:：]+/, '').trim();
      if (instruction === '' || instruction.length > MAX_INSTRUCTION_CHARS) {
        await notice(request, NOTICE.emptyInstruction);
        return true;
      }
      if (!isPlainObject(request.draft)) {
        await notice(request, '本需求还没有草稿，无法改稿。');
        return true;
      }
      await reserve(request.id, () => reviseRequest(request.id, actorId, instruction));
      return true;
    }

    const pending = isPlainObject(request.pendingInput) ? request.pendingInput : null;
    const fields = splitFields(text);
    const issueIds = listOf(request.draft?.issues).map((issue) => String(issue?.id ?? ''));
    const storyKeys = listOf(request.draft?.stories).map((story) => String(story?.key ?? ''));
    const resources = listOf(request.snapshot?.resources).map((resource) => String(resource?.id ?? ''));
    const owners = stringsOf(projectEntry(request.projectId)?.owners);
    const iterations = stringsOf(projectEntry(request.projectId)?.iterationIds);
    const projectId = firstString(request.projectId);

    if (pending?.kind === 'project' && fields.length === 1 && owns(projects, fields[0])) {
      await applyReply(request, value, 'project', { projectId: fields[0] });
      return true;
    }
    if (pending?.kind === 'parent') {
      const storyId = fields[0];
      if (!verifiedParentIds(request).has(storyId)) {
        await notice(request, `${NOTICE.unverifiableParent}（${NOTICE.pickParentEmpty}）`);
        return true;
      }
      await applyReply(request, value, 'parent', { storyId });
      return true;
    }
    if (pending?.kind === 'iteration') {
      const iterationId = fields[0]?.replace(/^迭代[:：]?\s*/, '').trim();
      if (!iterations.includes(iterationId)) {
        await notice(request, `${NOTICE.pickIteration}（配置外迭代不可用，操作无效。）`);
        return true;
      }
      await applyReply(request, value, 'iteration', { iterationId });
      return true;
    }
    if (pending?.kind === 'owner') {
      const storyKey = storyKeys.includes(fields[0]) ? fields.shift() : firstString(pending.storyKey);
      const owner = fields.join(' · ').trim() || text;
      if (!owners.includes(owner)) {
        await notice(request, `${NOTICE.pickOwner}（名单外负责人，操作无效。）`);
        return true;
      }
      await applyReply(request, value, 'decision', { type: 'select-fields', storyKey, owner });
      return true;
    }
    if (pending?.kind === 'exclude') {
      const storyKey = storyKeys.includes(fields[0]) ? fields.shift() : firstString(pending.storyKey);
      const reason = fields.join(' · ').trim() || text;
      await applyReply(request, value, 'decision', { type: 'exclude', storyKeys: [storyKey], reason });
      return true;
    }

    // Unprompted but unambiguous forms stay usable: the answer to a question and
    // the explanation of an unread resource both name their own target.
    if (projectId === '' && fields.length === 1 && owns(projects, fields[0])) {
      await applyReply(request, value, 'project', { projectId: fields[0] });
      return true;
    }
    let head = fields[0] ?? '';
    let rest = fields.slice(1);
    if (/^请求\s/i.test(head)) {
      head = rest.shift() ?? '';
    }
    const issueId = /^Q?\d+$/.test(head) && issueIds.includes(head.startsWith('Q') ? head : `Q${head}`)
      ? (head.startsWith('Q') ? head : `Q${head}`)
      : null;
    if (issueId && rest.length > 0) {
      await applyReply(request, value, 'decision', { type: 'answer', issueId, text: rest.join(' · ') });
      return true;
    }
    if (resources.includes(head) && rest.length > 0) {
      const word = rest.shift() ?? '';
      const action = RESOURCE_ACTION_WORDS[word.toLowerCase()] ?? RESOURCE_ACTION_WORDS[word];
      const decisionAction = action ?? (pending?.kind === 'answer' ? 'explain' : null);
      if (decisionAction) {
        await applyReply(request, value, 'decision', {
          type: 'explain-resource', resourceId: head, action: decisionAction, text: rest.join(' · ') || word,
        });
        return true;
      }
    }
    if (storyKeys.includes(head) && owners.includes(rest.join(' · ').trim())) {
      await applyReply(request, value, 'decision', { type: 'select-fields', storyKey: head, owner: rest.join(' · ').trim() });
      return true;
    }
    if (iterations.includes(head) && rest.length === 0) {
      await applyReply(request, value, 'iteration', { iterationId: head });
      return true;
    }
    if (verifiedParentIds(request).has(head) && rest.length === 0) {
      await applyReply(request, value, 'parent', { storyId: head });
      return true;
    }
    return false;
  }

  async function handleMessage(message) {
    if (!enabled) return false;
    if (!isPlainObject(message)) return false;
    if (isServiceMessage(message)) return false;
    const chatId = firstString(message.chat_id);
    if (chatId === '') return false;
    const actorId = actorIdOf(message);
    if (actorId === '' || !OPEN_ID_PATTERN.test(actorId)) return false;
    let requests = [];
    try {
      requests = store.list();
    } catch (error) {
      logLine('error', `requirement ledger unreadable: ${safeCode(error)}`);
      return false;
    }

    let classified = null;
    try {
      classified = classifyRequirementMessage(message, { selfOpenId, hosts, requests });
    } catch (error) {
      if (firstString(error?.message) === 'AMBIGUOUS_REQUEST') {
        await noticeMessage(message, NOTICE.ambiguous);
        return true;
      }
      logLine('warn', `requirement classification failed: ${safeCode(error)}`);
      return false;
    }

    if (classified?.kind === 'start') {
      await startFlow(message, classified.documents, actorId);
      return true;
    }
    if (classified?.kind === 'edit') {
      await editFlow(classified, actorId, message);
      return true;
    }

    let reference = null;
    try {
      reference = resolveRequestReference(message, requests);
    } catch {
      await noticeMessage(message, NOTICE.ambiguous);
      return true;
    }

    const remembered = rememberedStart(message);
    if (remembered) {
      const { entry } = remembered;
      const text = extractPlainText(message).trim();
      const index = parseChoice(text, listOf(entry.documents).length);
      let chosen = index === null ? null : entry.documents[index];
      if (chosen === null) {
        // A bare link may be pasted into the pick thread instead of a number. It
        // only counts when it is one of the links already offered, so the choice
        // cannot smuggle in a document that was never shown to the reviewer.
        chosen = offeredDocument(text, entry.documents);
      }
      if (chosen === null) {
        await noticeMessage(message, NOTICE.multipleDocuments);
        return true;
      }
      pendingStarts.delete(remembered.key);
      // The pick is started as the person who picked it: `allowedSenders` is
      // checked against them in startFlow, never against who asked first.
      await startFlow(
        { ...message, message_id: remembered.key.split('|').at(-1) },
        [chosen],
        actorId,
      );
      return true;
    }

    if (reference === null) return false;
    const request = store.get(reference);
    if (!isPlainObject(request)) return false;
    return handleReply(request, message, actorId);
  }

  // --------------------------------------------------------------------- events

  function enqueue(event) {
    if (!enabled) return false;
    const value = parseAction(event);
    if (!value) return false;
    let request = null;
    try {
      request = store.get(value.requestId);
    } catch (error) {
      logLine('error', `requirement ledger unreadable: ${safeCode(error)}`);
      return false;
    }
    const crossGroup = isPlainObject(request) && request.chatId !== value.chatId;
    const unknownCard = isPlainObject(request) && !crossGroup
      && !stringsOf(request.cardMessageIds).includes(value.messageId)
      && request.triggerMessageId !== value.messageId;
    const gate = gateRequest(request, value, { nav: NAV.has(value.action) });
    if (!gate.ok) {
      logLine('warn', `requirement action ${value.action} refused: ${gate.code}`);
      if (!crossGroup && !unknownCard && isPlainObject(request)) {
        track(() => notice(request, refusal(gate.code)));
      }
      return true;
    }

    if (HEAVY_ACTIONS.has(value.action)) {
      track(() => reserve(value.requestId, () => {
        if (value.action === 'submit') return runSubmit(value);
        return runBatchAction(value, value.action);
      }));
      return true;
    }
    if (NAV.has(value.action)) {
      track(() => applyNavigation(value, request));
      return true;
    }
    track(() => {
      switch (value.action) {
        case 'approve':
          return commitDecision(value.requestId, value, { type: 'approve', storyKeys: [value.key] });
        case 'defer':
          return commitDecision(value.requestId, value, { type: 'defer', storyKeys: [value.key] });
        case 'exclude':
          return askPrompt(value, 'exclude');
        case 'cancel':
          return cancelRequest(value);
        case 'answer':
          return askPrompt(value, 'answer');
        case 'select_target':
          return askPrompt(value, 'project');
        case 'select_owner':
          return askPrompt(value, 'owner');
        case 'select_iteration':
          return askPrompt(value, 'iteration');
        case 'bind_parent':
          return askParent(value, request);
        default:
          return undefined;
      }
    });
    return true;
  }

  // ------------------------------------------------------------------ recovery

  async function recover() {
    let requests = [];
    try {
      requests = store.list();
    } catch (error) {
      logLine('error', `requirement recovery skipped: ${safeCode(error)}`);
      return;
    }
    for (const request of requests) {
      if (!isPlainObject(request)) continue;
      const requestId = firstString(request.id);
      if (requestId === '' || inFlight.has(requestId)) continue;
      if (request.status === STATUS.READING || request.status === STATUS.ANALYZING) {
        // The status is the only record of which step was in flight, so the
        // interrupted reason is derived from it and never guessed from the draft.
        const reason = request.status === STATUS.READING ? 'READ_INTERRUPTED' : 'ANALYZE_INTERRUPTED';
        await write(requestId, (target) => {
          target.status = STATUS.INTERRUPTED;
          target.blockedReason = reason;
        }).catch((error) => {
          logLine('warn', `requirement recovery downgrade lost: ${safeCode(error)}`);
        });
        const fresh = store.get(requestId);
        if (isPlainObject(fresh)) await notice(fresh, NOTICE.recovered);
        continue;
      }
      const inflight = listOf(request.submissions).some((submission) => submission?.status === 'running')
        || listOf(request.submissions).some((submission) => listOf(submission?.items).some((item) => item?.status === 'sending'));
      // The freeze and the submitter's first write are two transactions, so a restart
      // can land between them: `submitting` with a batch that has no items and no
      // start stamp is proof the submitter never touched it, so nothing can exist
      // remotely. Handing that to `reconcile` would only park it, and `submitting` is
      // not a writable status, so the reviewer would be left with a dead card. The
      // safe move is to release the request; the next submit freezes afresh.
      const neverStarted = inflight || request.status !== STATUS.SUBMITTING
        ? null
        : (listOf(request.submissions).find((submission) => submission?.status === 'pending'
          && listOf(submission?.items).length === 0
          && !nonEmptyString(submission?.startedAt)) ?? null);
      if (neverStarted) {
        await write(requestId, (target) => {
          target.status = STATUS.NEEDS_REVIEW;
          target.blockedReason = 'BATCH_NOT_STARTED';
        }).catch((error) => {
          logLine('warn', `requirement freeze release lost: ${safeCode(error)}`);
        });
        const fresh = store.get(requestId);
        if (isPlainObject(fresh)) await notice(fresh, NOTICE.freezeReleased);
        track(() => refresh(requestId, firstString(request.renderViewer, request.initiatorId)));
        continue;
      }
      if (inflight) {
        const batchId = firstString(
          request.lastBatchId,
          listOf(request.submissions).find((submission) => listOf(submission?.items).some((item) => item?.status === 'sending'))?.batch?.id,
          listOf(request.submissions).find((submission) => submission?.status === 'running')?.batch?.id,
        );
        if (batchId === '') continue;
        // A lost card update is never a reason to create a story again, so the
        // only recovery move for an unfinished batch is the read-only reconcile.
        track(() => reserve(requestId, () => runBatchAction({
          requestId,
          action: 'reconcile',
          key: '',
          page: 0,
          draftVersion: reviewState(request, request.initiatorId).version,
          chatId: request.chatId,
          messageId: cardMessageIdOf(request) || firstString(request.triggerMessageId),
          actorId: firstString(request.initiatorId),
        }, 'reconcile')));
        continue;
      }
      if (isPlainObject(request.draft) && !CLOSED_STATUSES.has(request.status)) {
        track(() => refresh(requestId, firstString(request.renderViewer, request.initiatorId)));
      }
    }
  }

  async function flush() {
    if (!enabled) return;
    if (!recoveryRun) {
      recoveryRun = true;
      await recover();
    }
    await drainPendingCards();
  }

  async function whenIdle() {
    let guard = 0;
    while (tasks.size > 0) {
      guard += 1;
      if (guard > 1000) throw coded('WORK_NOT_SETTLED');
      await Promise.allSettled([...tasks]);
    }
  }

  return { handleMessage, enqueue, flush, whenIdle };
}
