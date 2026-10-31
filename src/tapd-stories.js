// TAPD requirement-story adapter: structured description templates plus the
// only HTTP exit for parent/child requirement stories.
//
// Reads reconcile a submission against TAPD, so a page walk that cannot be
// finished reports complete:false rather than "not found". Writes have no
// idempotency key: only an explicit JSON status:0 rejection proves nothing was
// created; every other failure is UNKNOWN and must be checked by a human.
// Document text is untrusted and is escaped into generated HTML; the token is
// read per call and only ever reaches the Authorization header.

import { readFileSync } from 'node:fs';

import { resolveApiKey } from './chat.js';

const BASE_URL = 'https://api.tapd.cn';
const BASE_URL_PATTERN = /^https:\/\/api\.tapd\.cn\/?$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 100;
const DESCRIPTION_LIMIT = 6000;
const TITLE_LIMIT = 100;
const MARKER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const SAFE_URL = /^https?:\/\//i;
const BR = '<br />';

function codedError(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

function fail(code, message) {
  throw codedError(code, message);
}

function assertMarker(marker) {
  if (typeof marker !== 'string' || !MARKER_PATTERN.test(marker)) {
    fail('INVALID_MARKER', 'tapd-stories: invalid marker');
  }
  return marker;
}

function assertId(value, field) {
  if (typeof value !== 'string' || value === '') {
    fail('INVALID_ARGUMENT', `tapd-stories: ${field} is required`);
  }
  return value;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function line(value) {
  return esc(value).replace(/\r?\n/g, BR);
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(CONTROL_CHARS, '');
  if (text.length <= TITLE_LIMIT) return text;
  const clipped = text.slice(0, TITLE_LIMIT);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') ?? '';
}

// TAPD renders descriptions as HTML. Only http(s) links are turned into
// anchors; anything else is omitted so a document value cannot become a
// javascript: target or trusted markup.
function documentLink(value) {
  const text = typeof value === 'string' ? value : '';
  if (!SAFE_URL.test(text)) return '';
  return `<a href="${esc(text)}">${esc(text)}</a>`;
}

function versionLine(snapshot) {
  return `【来源版本】${line(snapshot?.revision ?? '')}（指纹 ${line(snapshot?.fingerprint ?? '')}）`;
}

function issueLine(issue) {
  const flag = issue?.blocking === true ? '[阻塞] ' : '';
  return `- ${flag}${line(issue?.question ?? '')}`;
}

// The clip can only cut the tail; a partial entity or tag would make the HTML
// malformed, so those fragments are dropped before the marker is appended.
// An anchor opened before the cut would otherwise swallow the marker, so the
// missing closing tags are appended, paid for by trimming body text.
function trimFragments(text) {
  return text
    .replace(/&[A-Za-z#0-9]*$/, '')
    .replace(/<[^>]*$/, '')
    .replace(/(?:<br \/>)+$/, '');
}

function openAnchors(text) {
  return (text.match(/<a /g) ?? []).length - (text.match(/<\/a>/g) ?? []).length;
}

function clipHtml(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  cut = trimFragments(cut);
  const missing = openAnchors(cut);
  if (missing === 0) return cut;
  const closers = '</a>'.repeat(missing);
  const body = trimFragments(cut.slice(0, Math.max(0, max - closers.length)));
  // The paid trim can drop the opening tag itself, so recount before closing.
  const stillMissing = Math.min(missing, openAnchors(body));
  return `${body}${'</a>'.repeat(stillMissing)}`;
}

function assembleDescription(lines, marker) {
  const tail = `【追踪标识】${marker}`;
  const room = DESCRIPTION_LIMIT - tail.length - BR.length;
  const body = clipHtml(lines.filter((entry) => entry !== '').join(BR), room);
  return body === '' ? tail : `${body}${BR}${tail}`;
}

function sourceLines(story, snapshot) {
  const ids = [...new Set(
    (Array.isArray(story?.sourceIds) ? story.sourceIds : []).map(String),
  )];
  const blockIds = new Set(
    (Array.isArray(snapshot?.blocks) ? snapshot.blocks : []).map((block) => String(block?.id)),
  );
  const commentIds = new Set(
    (Array.isArray(snapshot?.comments) ? snapshot.comments : [])
      .map((comment) => String(comment?.id)),
  );
  const pendingIds = new Set(
    (Array.isArray(snapshot?.resources) ? snapshot.resources : [])
      .filter((resource) => resource?.status === 'pending')
      .map((resource) => String(resource?.id)),
  );

  const lines = [];
  const blocks = ids.filter((id) => blockIds.has(id));
  if (blocks.length > 0) lines.push(`来源块：${blocks.map(line).join('、')}`);
  const comments = ids.filter((id) => commentIds.has(id));
  if (comments.length > 0) lines.push(`评论：${comments.map(line).join('、')}`);
  const pending = ids.filter((id) => pendingIds.has(id));
  if (pending.length > 0) {
    lines.push(`未读素材：${pending.map((id) => `${line(id)}（未读取）`).join('、')}`);
  }
  return lines;
}

export function buildParentFields({ request, target, marker } = {}) {
  assertMarker(marker);
  const snapshot = request?.snapshot ?? {};
  assertId(target?.workspaceId, 'target.workspaceId');
  assertId(target?.parentTypeId, 'target.parentTypeId');
  assertId(target?.templateId, 'target.templateId');
  assertId(snapshot.documentId, 'snapshot.documentId');
  const draft = request?.draft ?? {};
  const stories = Array.isArray(draft.stories) ? draft.stories : [];
  const approved = stories.filter((story) => story?.disposition === 'approved');
  const deferred = stories.filter((story) => story?.disposition === 'deferred');
  const exclusions = Array.isArray(draft.exclusions) ? draft.exclusions : [];
  const issues = (Array.isArray(draft.issues) ? draft.issues : [])
    .filter((issue) => issue?.resolvedBy == null);
  const title = target?.parent?.title ?? snapshot.title;

  const lines = [
    `【需求文档】${documentLink(snapshot.url)}（文档 ID：${line(snapshot.documentId)}；本单不附带飞书附件，来源见需求文档链接）`,
    versionLine(snapshot),
    `【目标】${line(title)}`,
    '【本期范围】',
    ...(approved.length > 0
      ? approved.map((story) => `- ${line(story?.title)}`)
      : ['（无已批准子单）']),
    '【延期与排除】',
    ...(deferred.length + exclusions.length > 0
      ? [
        ...deferred.map((story) => `- 延期：${line(story?.title)}`),
        ...exclusions.map((exclusion) => `- 排除：${line(exclusion?.reason)}`),
      ]
      : ['（无）']),
    '【待确认】',
    ...(issues.length > 0 ? issues.map(issueLine) : ['（无）']),
  ];

  const fields = {
    workspace_id: target.workspaceId,
    name: cleanTitle(title),
    workitem_type_id: target.parentTypeId,
    templated_id: target.templateId,
    description: assembleDescription(lines, marker),
  };
  const owner = firstValue(target?.parent?.owner);
  if (owner !== '') fields.owner = owner;
  const iterationId = firstValue(target?.parent?.iterationId);
  if (iterationId !== '') fields.iteration_id = iterationId;
  return fields;
}

export function buildChildFields({
  story,
  request,
  target,
  parentId,
  dependencyIds,
  marker,
} = {}) {
  assertMarker(marker);
  assertId(target?.workspaceId, 'target.workspaceId');
  assertId(target?.childTypeId, 'target.childTypeId');
  assertId(target?.templateId, 'target.templateId');
  assertId(parentId, 'parentId');
  const snapshot = request?.snapshot ?? {};
  const draft = request?.draft ?? {};
  const rules = Array.isArray(story?.rules) ? story.rules : [];
  const acceptance = Array.isArray(story?.acceptance) ? story.acceptance : [];
  const dependencies = Array.isArray(story?.dependencies) ? story.dependencies : [];
  const issues = Array.isArray(draft.issues) ? draft.issues : [];
  const issueIds = new Set(
    (Array.isArray(story?.issueIds) ? story.issueIds : []).map(String),
  );

  const dependencyLines = dependencies.map((dependency) => {
    const key = String(dependency);
    const id = dependencyIds?.[key];
    if (typeof id !== 'string' || id === '') {
      fail('INVALID_DEPENDENCY', 'tapd-stories: dependency has no TAPD id');
    }
    return `- ${line(key)}（TAPD #${line(id)}）`;
  });

  const lines = [
    '【功能规则】',
    ...(rules.length > 0
      ? rules.map((rule, index) => `${index + 1}. ${line(rule?.text)}`)
      : ['（无）']),
    '【验收条件】',
    ...(acceptance.length > 0
      ? acceptance.map((item, index) => `${index + 1}. ${line(item?.text)}`)
      : ['（无）']),
    '【依赖】',
    ...(dependencyLines.length > 0 ? dependencyLines : ['无']),
    '【需求来源】',
    `文档：${documentLink(snapshot.url)}（本单不附带飞书附件，来源见需求文档链接）`,
    `版本：${line(snapshot.revision ?? '')}（指纹 ${line(snapshot.fingerprint ?? '')}）`,
    ...sourceLines(story, snapshot),
  ];

  const openIssues = issues.filter(
    (issue) => issue?.resolvedBy == null && issueIds.has(String(issue?.id)),
  );
  if (openIssues.length > 0) {
    lines.push('【待确认/范围说明】', ...openIssues.map(issueLine));
  }

  const fields = {
    workspace_id: target.workspaceId,
    name: cleanTitle(story?.title),
    parent_id: parentId,
    workitem_type_id: target.childTypeId,
    templated_id: target.templateId,
    description: assembleDescription(lines, marker),
  };
  const owner = firstValue(story?.owner, target?.childDefaults?.owner);
  if (owner !== '') fields.owner = owner;
  const iterationId = firstValue(story?.iterationId, target?.childDefaults?.iterationId);
  if (iterationId !== '') fields.iteration_id = iterationId;
  return fields;
}

function normalizeStory(raw, fallbackWorkspaceId) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(source.id ?? ''),
    workspaceId: String(source.workspace_id ?? fallbackWorkspaceId ?? ''),
    name: String(source.name ?? ''),
    parentId: String(source.parent_id ?? ''),
    childrenIds: String(source.children_id ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
    ancestorId: String(source.ancestor_id ?? ''),
    level: String(source.level ?? ''),
    workitemTypeId: String(source.workitem_type_id ?? ''),
    templatedId: String(source.templated_id ?? ''),
    iterationId: String(source.iteration_id ?? ''),
    description: String(source.description ?? ''),
  };
}

function unwrapStory(item) {
  return item && typeof item === 'object' && item.Story && typeof item.Story === 'object'
    ? item.Story
    : item;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function descriptionTokens(description) {
  return decodeEntities(String(description ?? '').replace(/<[^>]*>/g, ' '))
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => token !== '');
}

function hasDescriptionToken(description, token) {
  const wanted = typeof token === 'string' ? token : '';
  return wanted !== '' && descriptionTokens(description).includes(wanted);
}

export function createTapdStories({
  tokenFile,
  request = globalThis.fetch,
  readFile = (file) => readFileSync(file, 'utf8'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = BASE_URL,
} = {}) {
  if (typeof tokenFile !== 'string' || tokenFile === '') {
    throw codedError('INVALID_CONFIG', 'tapd-stories: tokenFile is required');
  }
  if (!BASE_URL_PATTERN.test(String(baseUrl))) {
    throw codedError('INVALID_BASE_URL', 'tapd-stories: baseUrl must be https://api.tapd.cn');
  }
  if (typeof request !== 'function') {
    throw codedError('INVALID_CONFIG', 'tapd-stories: request is required');
  }
  const root = String(baseUrl).replace(/\/+$/, '');

  function tokenOrFail() {
    const token = resolveApiKey({ apiKeyEnv: '', apiKeyFile: tokenFile, readFile });
    if (!token) fail('UNSENT', 'tapd-stories: 令牌文件不可读或为空');
    return token;
  }

  function signal() {
    return AbortSignal.timeout(timeoutMs);
  }

  async function getPage(token, params) {
    const url = `${root}/stories?${params.toString()}`;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: signal(),
      });
      if (!res.ok) return { ok: false, items: [] };
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, items: [] };
      }
      if (parsed?.status !== 1 || !Array.isArray(parsed.data)) {
        return { ok: false, items: [] };
      }
      return { ok: true, items: parsed.data };
    } catch {
      return { ok: false, items: [] };
    }
  }

  async function collectPages(token, workspaceId, extra) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        workspace_id: String(workspaceId),
        ...extra,
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      const result = await getPage(token, params);
      if (!result.ok) return { items, complete: false };
      if (result.items.length === 0) return { items, complete: true };
      for (const item of result.items) {
        items.push(normalizeStory(unwrapStory(item), workspaceId));
      }
    }
    return { items, complete: false };
  }

  return {
    async getStory({ workspaceId, id } = {}) {
      assertId(workspaceId, 'workspaceId');
      assertId(id, 'id');
      const token = tokenOrFail();
      const params = new URLSearchParams({
        workspace_id: workspaceId,
        id,
      });
      const result = await getPage(token, params);
      if (!result.ok) fail('READ_FAILED', 'tapd-stories: 读取需求失败');
      const wanted = id;
      const found = result.items
        .map((item) => normalizeStory(unwrapStory(item), workspaceId))
        .find((story) => story.id === wanted);
      if (!found) fail('NOT_FOUND', 'tapd-stories: 未找到需求');
      return found;
    },

    async listChildren({ workspaceId, parentId } = {}) {
      assertId(workspaceId, 'workspaceId');
      assertId(parentId, 'parentId');
      const token = tokenOrFail();
      return collectPages(token, workspaceId, { parent_id: parentId });
    },

    async findParents({ workspaceId, name, documentId } = {}) {
      assertId(workspaceId, 'workspaceId');
      const wantedName = cleanTitle(name);
      assertId(wantedName, 'name');
      assertId(documentId, 'documentId');
      const token = tokenOrFail();
      const { items, complete } = await collectPages(token, workspaceId, { name: wantedName });
      return {
        items: items.filter((story) => cleanTitle(story.name) === wantedName
          && story.parentId === '0'
          && hasDescriptionToken(story.description, documentId)),
        complete,
      };
    },

    async findByMarker({ workspaceId, parentId, marker } = {}) {
      assertMarker(marker);
      assertId(workspaceId, 'workspaceId');
      assertId(parentId, 'parentId');
      const token = tokenOrFail();
      const wantedWorkspace = workspaceId;
      const wantedParent = parentId;
      const { items, complete } = await collectPages(token, workspaceId, {
        parent_id: wantedParent,
      });
      return {
        items: items.filter((story) => story.workspaceId === wantedWorkspace
          && story.parentId === wantedParent
          && hasDescriptionToken(story.description, marker)),
        complete,
      };
    },

    async createStory({ workspaceId, fields } = {}) {
      assertId(workspaceId, 'workspaceId');
      const token = tokenOrFail();
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value == null) continue;
        form.set(key, String(value));
      }
      form.set('workspace_id', workspaceId);

      let res;
      try {
        res = await request(`${root}/stories`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          redirect: 'error',
          signal: signal(),
        });
      } catch (error) {
        const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        fail('UNKNOWN', timedOut
          ? 'tapd-stories: 建单结果未知（超时）'
          : 'tapd-stories: 建单结果未知（网络异常）');
      }

      let text;
      try {
        text = await res.text();
      } catch {
        fail('UNKNOWN', 'tapd-stories: 建单结果未知（响应读取失败）');
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body is often TAPD's HTML login page; it proves nothing
        // about whether the write landed, so the result stays UNKNOWN.
      }

      if (
        parsed
        && parsed.status === 0
        && typeof parsed.info === 'string'
        && parsed.info !== ''
      ) {
        const error = codedError('REJECTED', `tapd-stories: 建单被拒绝（HTTP ${res.status}）`);
        error.status = res.status;
        throw error;
      }

      const storyId = parsed?.data?.Story?.id;
      if (res.ok && parsed?.status === 1 && storyId != null && String(storyId) !== '') {
        return { id: String(storyId) };
      }

      const error = codedError('UNKNOWN', `tapd-stories: 建单结果未知（HTTP ${res.status}）`);
      error.status = res.status;
      throw error;
    },
  };
}
