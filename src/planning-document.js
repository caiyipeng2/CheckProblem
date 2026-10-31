// Planning-document reader: turns a Feishu docx/wiki link into a source
// Snapshot (blocks, media manifest, comments, fingerprint), re-checks that
// Snapshot against a fresh read, and owns the per-request asset directory.
//
// Remote content and media tokens only exist inside one read: the Snapshot
// keeps extracted text, fixed failure codes and local paths. Everything
// remote goes through the injected `run` (lark-cli); no document text or model
// input ever reaches argv.

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

import { normalizeDocumentLink } from './requirement-input.js';

const IDENTITY = ['--as', 'user', '--json'];
const REQUEST_ID = /^[A-Za-z0-9_-]+$/;
const UNSAFE_NAME = /[^A-Za-z0-9_-]/g;
const PERMISSION_CODES = new Set(['403', '99991672', '99991663']);
const READER_REASONS = new Set([
  'READ_FAILED',
  'RESOURCE_TOO_LARGE',
  'RESOURCE_TRUNCATED',
  'NO_READER',
]);

export const DEFAULT_LIMITS = {
  maxChars: 500_000,
  maxResources: 100,
  maxTotalBytes: 200 * 1024 * 1024,
  maxResourceBytes: 20 * 1024 * 1024,
  maxPages: 20,
};

const MAX_WHITEBOARD_TEXT = 10_000;
const MAX_WORKBOOK_TEXT = 100_000;
const MAX_SPREADSHEET_TEXT = 30_000;
const MAX_LABEL = 500;
const WORKBOOK_TEXT_SUFFIX = '\n[读取限制] 预览为 HTML 渲染结果，隐藏工作表和公式可能缺失';

const MEDIA_TAGS = new Set(['img', 'whiteboard', 'sheet', 'source']);
const VOID_TAGS = new Set(['br', 'hr', 'col', 'meta', 'link']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3']);
const WHITEBOARD_SKIP_KEYS = new Set([
  'id',
  'token',
  'url',
  'href',
  'src',
  'file',
  'file_token',
  'avatar',
  'style',
  'color',
  'type',
  'key',
  'mime',
  'image',
]);
const OUTPUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.xlsx', '.json', '.html'];

function fail(code, cause) {
  const error = new Error(code);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function limitValue(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function safeName(value, fallback) {
  const cleaned = String(value ?? '').replace(UNSAFE_NAME, '_').slice(0, 120);
  return cleaned || fallback;
}

// Local file names keep their extension but never a leading dot segment, so a
// remote id cannot turn the target into `..` or a hidden path.
function safeFileName(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 160);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

function isInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function failureReason(error) {
  const code = error instanceof Error ? error.message : '';
  return READER_REASONS.has(code) ? code : 'READ_FAILED';
}

// A failed lark-cli call still prints its envelope on stdout, so the envelope
// decides between authorization and generic failure. Messages stay fixed
// codes: remote text must not reach Snapshot.resources[].reason.
function createCliCall(run) {
  return async (args) => {
    let result;
    try {
      result = (await run('lark-cli', args)) ?? {};
    } catch {
      fail('SOURCE_READ_FAILED');
    }
    if (result.truncated) fail('SOURCE_TRUNCATED');
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      fail('SOURCE_READ_FAILED');
    }
    if (!isPlainObject(envelope)) fail('SOURCE_READ_FAILED');
    if (envelope.ok !== true) {
      const error = isPlainObject(envelope.error) ? envelope.error : {};
      const missingScopes = envelope.missing_scopes ?? error.missing_scopes;
      const code = String(error.code ?? envelope.code ?? '');
      if (
        (Array.isArray(missingScopes) && missingScopes.length > 0)
        || PERMISSION_CODES.has(code)
      ) {
        fail('SOURCE_ACCESS_DENIED');
      }
      fail('SOURCE_READ_FAILED');
    }
    if (result.code !== 0) fail('SOURCE_READ_FAILED');
    return isPlainObject(envelope.data) ? envelope.data : {};
  };
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    }
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return match;
    }
  });
}

// Linear tag scanner. A quote-aware end-of-tag search keeps `>` inside
// attribute values from truncating the tag; no body text is ever reassembled
// into a shell command.
function findTagEnd(content, start) {
  let quote = null;
  for (let index = start; index < content.length; index += 1) {
    const ch = content[index];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return index;
  }
  return -1;
}

function parseTag(raw) {
  const nameMatch = /^([A-Za-z][A-Za-z0-9:_-]*)/.exec(raw);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  const attrs = {};
  let index = nameMatch[1].length;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (index >= raw.length) break;
    const keyStart = index;
    while (index < raw.length && !/[\s=]/.test(raw[index])) index += 1;
    const key = raw.slice(keyStart, index).toLowerCase();
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    let value = '';
    if (raw[index] === '=') {
      index += 1;
      while (index < raw.length && /\s/.test(raw[index])) index += 1;
      if (raw[index] === '"' || raw[index] === "'") {
        const quote = raw[index];
        index += 1;
        const valueStart = index;
        while (index < raw.length && raw[index] !== quote) index += 1;
        value = raw.slice(valueStart, index);
        if (raw[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < raw.length && !/\s/.test(raw[index])) index += 1;
        value = raw.slice(valueStart, index);
      }
    }
    if (key) attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

function sanitizeLabel(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text || /^https?:\/\//i.test(text)) return '';
  return text.slice(0, MAX_LABEL);
}

function referenceKind(attrs) {
  const mime = typeof attrs.mime === 'string' ? attrs.mime.toLowerCase() : '';
  const name = typeof attrs.name === 'string' ? attrs.name : '';
  if (mime.startsWith('video/')) return 'video';
  if (/spreadsheet|ms-excel|excel/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) {
    return 'workbook';
  }
  return 'reference';
}

function referenceEntries(referenceMap) {
  const entries = [];
  const push = (value, fallbackHref) => {
    if (typeof value === 'string') {
      // A map entry like { "<url>": "label" } carries the href in the key.
      if (fallbackHref !== undefined) entries.push({ href: fallbackHref, label: value });
      else entries.push({ href: value, label: '' });
      return;
    }
    if (!isPlainObject(value)) return;
    const href = [value.url, value.href, value.link, value.target, fallbackHref]
      .find((candidate) => typeof candidate === 'string' && candidate);
    const label = [value.title, value.name, value.text, value.label]
      .find((candidate) => typeof candidate === 'string' && candidate);
    if (href || label) entries.push({ href: href ?? '', label: label ?? '' });
  };
  if (Array.isArray(referenceMap)) {
    for (const item of referenceMap) push(item);
  } else if (isPlainObject(referenceMap)) {
    for (const [key, value] of Object.entries(referenceMap)) {
      push(value, /^https?:\/\//i.test(key) ? key : undefined);
    }
  }
  return entries;
}

function parseContent({ content, referenceMap, maxChars, maxResources }) {
  const blocks = [];
  const resources = [];
  const usedBlockIds = new Set();
  const usedResourceIds = new Set();
  const generated = new Map();
  const referenceKeys = new Set();
  let title = '';
  let currentHeading = '';
  let chars = 0;
  let referenceCount = 0;

  const nextGenerated = (tag) => {
    const count = (generated.get(tag) ?? 0) + 1;
    generated.set(tag, count);
    return `${tag}-${count}`;
  };

  const uniqueName = (base, used) => {
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name;
  };

  const addBlock = ({ id, attrs = {}, tag, kind, text, allowEmpty = false }) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value && !allowEmpty) return null;
    const base = safeName(id ?? attrs.id, nextGenerated(tag));
    const block = {
      id: uniqueName(base, usedBlockIds),
      heading: currentHeading,
      kind,
      text: value,
    };
    blocks.push(block);
    chars += value.length;
    if (chars > maxChars) fail('SOURCE_LIMIT_EXCEEDED');
    return block;
  };

  const addResource = ({ block, kind, token, text, sheetId }) => {
    if (resources.length >= maxResources) fail('SOURCE_LIMIT_EXCEEDED');
    resources.push({
      id: uniqueName(`r-${block.id}`, usedResourceIds),
      kind,
      sourceBlockId: block.id,
      token: typeof token === 'string' && token !== '' ? token : undefined,
      sheetId: typeof sheetId === 'string' && sheetId !== '' ? sheetId : undefined,
      text: typeof text === 'string' ? text : '',
      reason: null,
    });
  };

  const addReference = ({ href, label }) => {
    const text = sanitizeLabel(label);
    const key = (typeof href === 'string' && href !== '' ? href : '') || (text ? `label:${text}` : '');
    if (!key || referenceKeys.has(key)) return;
    referenceKeys.add(key);
    if (resources.length >= maxResources) fail('SOURCE_LIMIT_EXCEEDED');
    referenceCount += 1;
    resources.push({
      id: uniqueName(`ref-${referenceCount}`, usedResourceIds),
      kind: 'reference',
      sourceBlockId: null,
      token: undefined,
      sheetId: undefined,
      text,
      reason: 'REFERENCE_NOT_FOLLOWED',
    });
  };

  const openMedia = (tag, attrs) => {
    if (tag === 'img') {
      const text = typeof attrs.alt === 'string' ? attrs.alt : '';
      const block = addBlock({ id: attrs.id, attrs, tag, kind: 'image', text, allowEmpty: true });
      addResource({ block, kind: 'image', token: attrs.src, text });
      return;
    }
    if (tag === 'whiteboard') {
      const text = typeof attrs.name === 'string' ? attrs.name : '';
      const block = addBlock({ id: attrs.id, attrs, tag, kind: 'whiteboard', text, allowEmpty: true });
      addResource({ block, kind: 'whiteboard', token: attrs.token, text });
      return;
    }
    if (tag === 'sheet') {
      const text = typeof attrs.name === 'string' ? attrs.name : '';
      const block = addBlock({ id: attrs.id, attrs, tag, kind: 'sheet', text, allowEmpty: true });
      addResource({
        block,
        kind: 'spreadsheet',
        token: attrs.token,
        text,
        sheetId: attrs['sheet-id'],
      });
      return;
    }
    const kind = referenceKind(attrs);
    const text = typeof attrs.name === 'string' ? attrs.name : '';
    const block = addBlock({ id: attrs.id, attrs, tag, kind: 'source', text, allowEmpty: true });
    addResource({ block, kind, token: attrs.token, text });
  };

  const stack = [{ tag: '#root', attrs: {}, text: '', hasList: false }];

  const finishElement = (element) => {
    const text = element.text.trim();
    const parent = stack[stack.length - 1];
    const insideCell = stack.some((entry) => entry.tag === 'td');
    if (element.tag === 'td') {
      // Every td is a cell block, even when the cell is empty.
      addBlock({
        id: element.attrs.id,
        attrs: element.attrs,
        tag: 'td',
        kind: 'cell',
        text,
        allowEmpty: true,
      });
    } else if (!insideCell) {
      if (element.tag === 'title') {
        title = text;
        currentHeading = text;
        addBlock({ id: element.attrs.id, attrs: element.attrs, tag: 'title', kind: 'title', text });
      } else if (HEADING_TAGS.has(element.tag)) {
        currentHeading = text;
        addBlock({ id: element.attrs.id, attrs: element.attrs, tag: element.tag, kind: 'heading', text });
      } else if (element.tag === 'p') {
        addBlock({ id: element.attrs.id, attrs: element.attrs, tag: 'p', kind: 'paragraph', text });
      } else if (element.tag === 'li') {
        addBlock({ id: element.attrs.id, attrs: element.attrs, tag: 'li', kind: 'list', text });
      } else if (element.tag === 'ol' && !element.hasList) {
        addBlock({ id: element.attrs.id, attrs: element.attrs, tag: 'ol', kind: 'list', text });
      }
    }
    if (element.tag === 'a' && typeof element.attrs.href === 'string' && element.attrs.href) {
      addReference({ href: element.attrs.href, label: text });
    }
    if (element.tag === 'li') {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === 'ol') {
          stack[index].hasList = true;
          break;
        }
      }
    }
    if (parent) parent.text += text;
  };

  const closeElement = (name) => {
    let depth = stack.length - 1;
    while (depth > 0 && stack[depth].tag !== name) depth -= 1;
    if (depth === 0) return;
    while (stack.length - 1 > depth) finishElement(stack.pop());
    finishElement(stack.pop());
  };

  let index = 0;
  while (index < content.length) {
    const open = content.indexOf('<', index);
    if (open === -1) {
      stack[stack.length - 1].text += decodeEntities(content.slice(index));
      break;
    }
    if (open > index) {
      stack[stack.length - 1].text += decodeEntities(content.slice(index, open));
    }
    const end = findTagEnd(content, open + 1);
    if (end === -1) {
      stack[stack.length - 1].text += decodeEntities(content.slice(open));
      break;
    }
    const raw = content.slice(open + 1, end);
    index = end + 1;
    if (raw.startsWith('!') || raw.startsWith('?')) continue;
    if (raw.startsWith('/')) {
      closeElement(raw.slice(1).trim().toLowerCase());
      continue;
    }
    const selfClosing = /\/\s*$/.test(raw);
    const body = selfClosing ? raw.slice(0, raw.lastIndexOf('/')) : raw;
    const parsed = parseTag(body);
    if (!parsed) continue;
    const { name, attrs } = parsed;
    if (MEDIA_TAGS.has(name)) {
      openMedia(name, attrs);
      continue;
    }
    if (VOID_TAGS.has(name)) continue;
    stack.push({ tag: name, attrs, text: '', hasList: false });
    if (selfClosing) closeElement(name);
  }
  while (stack.length > 1) finishElement(stack.pop());

  for (const entry of referenceEntries(referenceMap)) addReference(entry);

  return { blocks, resources, title };
}

function normalizeCommentText(comment) {
  const replies = Array.isArray(comment.reply_list) ? comment.reply_list : [];
  return [comment.quote, ...replies.map((reply) => reply?.content)]
    .filter((part) => typeof part === 'string' && part !== '')
    .join('\n');
}

async function readComments({ url, call, maxPages }) {
  const comments = [];
  const seen = new Set();
  let pageToken = null;
  let pages = 0;
  while (true) {
    if (pages >= maxPages) fail('SOURCE_LIMIT_EXCEEDED');
    const args = ['drive', '+list-comments', '--url', url];
    if (pageToken !== null) args.push('--page-token', pageToken);
    const data = await call(args);
    pages += 1;
    if (!Array.isArray(data.items)) fail('SOURCE_READ_FAILED');
    for (const item of data.items) {
      if (!isPlainObject(item)) continue;
      let id = typeof item.comment_id === 'string' && item.comment_id !== ''
        ? item.comment_id
        : `comment-${comments.length + 1}`;
      if (seen.has(id)) id = `${id}-${comments.length + 1}`;
      seen.add(id);
      comments.push({ id, sourceBlockId: null, text: normalizeCommentText(item) });
    }
    if (data.has_more !== true) return { comments, commentsComplete: true };
    const next = data.page_token;
    // Incomplete pagination must never look like a complete comment read.
    if (typeof next !== 'string' || next === '' || next === pageToken) {
      fail('SOURCE_READ_FAILED');
    }
    pageToken = next;
  }
}

function resourcePath(value, requestDir) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('READ_FAILED');
  const candidate = resolve(value);
  if (!isInside(requestDir, candidate)) fail('READ_FAILED');
  return candidate;
}

// Only source content participates: path, requestId, sourceIds and platform
// tokens are derived or local and stay out of the fingerprint.
function snapshotFingerprint(snapshot) {
  return sha256Text(canonicalJson({
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    blocks: snapshot.blocks,
    resources: snapshot.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      sourceBlockId: resource.sourceBlockId,
      status: resource.status,
      fingerprint: resource.fingerprint,
      text: resource.text,
      reason: resource.reason,
    })),
    comments: snapshot.comments,
  }));
}

function validSnapshotShape(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  if (typeof snapshot.url !== 'string' || snapshot.url === '') return false;
  if (typeof snapshot.requestId !== 'string' || !REQUEST_ID.test(snapshot.requestId)) return false;
  if (typeof snapshot.documentId !== 'string' || snapshot.documentId === '') return false;
  if (typeof snapshot.fingerprint !== 'string' || snapshot.fingerprint === '') return false;
  return Array.isArray(snapshot.blocks)
    && Array.isArray(snapshot.resources)
    && Array.isArray(snapshot.comments);
}

function diffSnapshots(before, after) {
  const changes = [];
  const seen = new Set();
  const push = (target, id) => {
    const key = `${target}\u0000${id ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    changes.push(id === undefined ? { target } : { target, id });
  };
  const compare = (target, beforeItems, afterItems, fields) => {
    const left = new Map(beforeItems.map((item) => [item?.id, item]));
    const right = new Map(afterItems.map((item) => [item?.id, item]));
    const ids = [...new Set([...left.keys(), ...right.keys()])];
    for (const id of ids) {
      const a = left.get(id);
      const b = right.get(id);
      if (!isPlainObject(a) || !isPlainObject(b)) {
        if (a !== b) push(target, id);
        continue;
      }
      const changed = fields.some((field) => a[field] !== b[field]);
      if (changed) push(target, id);
    }
  };

  if (String(before.revision ?? '') !== String(after.revision ?? '')) push('document');
  compare('blocks', before.blocks, after.blocks, ['heading', 'kind', 'text']);
  compare(
    'resources',
    before.resources,
    after.resources,
    ['kind', 'sourceBlockId', 'status', 'fingerprint', 'text', 'reason'],
  );
  compare('comments', before.comments, after.comments, ['text']);
  return changes;
}

function outputPath(requestDir, name) {
  const target = resolve(requestDir, safeFileName(name, 'resource'));
  if (!isInside(requestDir, target)) fail('READ_FAILED');
  return target;
}

function locateOutput(savedPath, target) {
  const candidates = [];
  if (typeof savedPath === 'string' && savedPath !== '') {
    // The CLI may report an absolute path or one relative to the request
    // directory. Resolve against the request directory first so a same-named
    // file in the process cwd can never shadow the real output.
    candidates.push(resolve(dirname(target), savedPath));
    candidates.push(resolve(savedPath));
  }
  candidates.push(resolve(target));
  for (const extension of OUTPUT_EXTENSIONS) candidates.push(resolve(`${target}${extension}`));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  fail('READ_FAILED');
}

function assertInside(root, candidate) {
  if (!isInside(root, candidate)) fail('READ_FAILED');
  return candidate;
}

function readBounded(file, maxBytes) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    fail('READ_FAILED');
  }
  if (size > maxBytes) fail('RESOURCE_TOO_LARGE');
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail('READ_FAILED');
  }
  if (bytes.length > maxBytes) fail('RESOURCE_TOO_LARGE');
  return bytes;
}

function reportedSize(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function collectWhiteboardStrings(nodes) {
  const out = [];
  const seen = new Set();
  let total = 0;
  const visit = (value, key) => {
    if (total >= MAX_WHITEBOARD_TEXT) return;
    if (typeof value === 'string') {
      if (key && WHITEBOARD_SKIP_KEYS.has(key.toLowerCase())) return;
      if (/^https?:\/\//i.test(value)) return;
      const text = value.trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      const room = MAX_WHITEBOARD_TEXT - total;
      out.push(text.slice(0, room));
      total += Math.min(text.length, room) + 1;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(nodes, '');
  return out.join('\n').slice(0, MAX_WHITEBOARD_TEXT);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

// Production resource readers. Each one returns the same JSON-safe shape the
// injected test readers use; every failure is a fixed code, never remote text.
export function createCliResourceReaders({ run, limits = {} } = {}) {
  const call = createCliCall(run);
  const maxBytes = limitValue(limits.maxResourceBytes, DEFAULT_LIMITS.maxResourceBytes);
  const invoke = (args, trailing = []) => call([...args, ...IDENTITY, ...trailing]);

  const requireToken = (resource) => {
    if (typeof resource?.token !== 'string' || resource.token === '') fail('READ_FAILED');
    return resource.token;
  };

  const sourceIdsFor = (resource) => (
    typeof resource?.sourceBlockId === 'string' && resource.sourceBlockId !== ''
      ? [resource.sourceBlockId]
      : []
  );

  const download = async (token, target, { reported } = {}) => {
    const data = await invoke(
      ['docs', '+media-preview', '--token', token, '--output', target],
      ['--overwrite'],
    );
    if (reported) {
      const size = Number(data.size_bytes);
      if (Number.isFinite(size) && size > maxBytes) fail('RESOURCE_TOO_LARGE');
    }
    const file = assertInside(dirname(target), locateOutput(data.saved_path, target));
    return { file, data };
  };

  const image = async ({ resource, requestDir }) => {
    const token = requireToken(resource);
    const target = outputPath(requestDir, resource.id);
    const { file, data } = await download(token, target, { reported: true });
    const bytes = readBounded(file, maxBytes);
    return {
      text: typeof resource.text === 'string' ? resource.text : '',
      fingerprint: sha256Bytes(bytes),
      sourceIds: sourceIdsFor(resource),
      path: file,
      bytes: reportedSize(Number(data.size_bytes), bytes.length),
    };
  };

  const whiteboard = async ({ resource, requestDir }) => {
    const token = requireToken(resource);
    const base = outputPath(requestDir, `${resource.id}-whiteboard`);
    const rawTarget = outputPath(requestDir, `${resource.id}-whiteboard-nodes.json`);
    // Export refuses to replace an existing file; a re-check reuses the same
    // request directory, so stale outputs are removed first.
    for (const stale of [base, rawTarget, ...OUTPUT_EXTENSIONS.map((extension) => `${base}${extension}`)]) {
      try {
        rmSync(stale, { force: true });
      } catch {
        // best effort; the export failure below still surfaces
      }
    }
    const previewData = await invoke([
      'whiteboard', '+export',
      '--whiteboard-token', token,
      '--output-type', 'preview',
      '--output', base,
    ]);
    const previewFile = assertInside(requestDir, locateOutput(previewData.saved_path, base));
    const rawData = await invoke([
      'whiteboard', '+export',
      '--whiteboard-token', token,
      '--output-type', 'raw',
      '--output', rawTarget,
    ]);
    const rawFile = assertInside(requestDir, locateOutput(rawData.saved_path, rawTarget));
    const previewBytes = readBounded(previewFile, maxBytes);
    const rawBytes = readBounded(rawFile, maxBytes);
    // The cap applies to the whole resource, not to each exported file.
    if (previewBytes.length + rawBytes.length > maxBytes) fail('RESOURCE_TOO_LARGE');
    let raw;
    try {
      raw = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      fail('READ_FAILED');
    }
    return {
      text: collectWhiteboardStrings(raw?.nodes),
      fingerprint: sha256Bytes(Buffer.concat([previewBytes, rawBytes])),
      sourceIds: sourceIdsFor(resource),
      path: previewFile,
      bytes: previewBytes.length + rawBytes.length,
    };
  };

  const spreadsheet = async ({ resource }) => {
    const token = requireToken(resource);
    const sheetId = typeof resource.sheetId === 'string' ? resource.sheetId : '';
    if (sheetId === '') fail('READ_FAILED');
    const data = await invoke([
      'sheets', '+csv-get',
      '--spreadsheet-token', token,
      '--sheet-id', sheetId,
      '--max-chars', String(MAX_SPREADSHEET_TEXT),
    ]);
    // A truncated sheet is not a complete read: keep the resource pending.
    if (data.has_more === true) fail('RESOURCE_TRUNCATED');
    if (typeof data.annotated_csv !== 'string') fail('READ_FAILED');
    const revision = data.revision === undefined || data.revision === null
      ? ''
      : String(data.revision);
    return {
      text: data.annotated_csv.slice(0, MAX_SPREADSHEET_TEXT),
      fingerprint: sha256Text(`${revision}\n${data.annotated_csv}`),
      sourceIds: sourceIdsFor(resource),
      path: null,
    };
  };

  const workbook = async ({ resource, requestDir }) => {
    const token = requireToken(resource);
    const originalTarget = outputPath(requestDir, `${resource.id}-original`);
    const htmlTarget = outputPath(requestDir, `${resource.id}-preview.html`);
    const { file: originalFile, data: originalData } = await download(
      token,
      originalTarget,
      { reported: true },
    );
    const htmlData = await invoke([
      'drive', '+preview',
      '--file-token', token,
      '--type', 'html',
      '--output', htmlTarget,
      '--if-exists', 'overwrite',
    ]);
    if (Number.isFinite(Number(htmlData.size_bytes)) && Number(htmlData.size_bytes) > maxBytes) {
      fail('RESOURCE_TOO_LARGE');
    }
    const htmlFile = assertInside(requestDir, locateOutput(htmlData.saved_path, htmlTarget));
    const originalBytes = readBounded(originalFile, maxBytes);
    const htmlBytes = readBounded(htmlFile, maxBytes);
    // The cap applies to the whole resource (original plus preview), not to
    // each downloaded file.
    if (originalBytes.length + htmlBytes.length > maxBytes) fail('RESOURCE_TOO_LARGE');
    const body = htmlToText(htmlBytes.toString('utf8'));
    const room = Math.max(0, MAX_WORKBOOK_TEXT - WORKBOOK_TEXT_SUFFIX.length);
    return {
      text: `${body.slice(0, room)}${WORKBOOK_TEXT_SUFFIX}`,
      fingerprint: sha256Bytes(Buffer.concat([
        originalBytes,
        Buffer.from('\n', 'utf8'),
        htmlBytes,
      ])),
      sourceIds: sourceIdsFor(resource),
      path: originalFile,
      bytes: reportedSize(Number(originalData.size_bytes), originalBytes.length) + htmlBytes.length,
    };
  };

  return { image, whiteboard, spreadsheet, workbook };
}

export function createPlanningDocumentReader({
  run,
  resourceReaders,
  hosts = [],
  assetsDir,
  limits = {},
} = {}) {
  const settings = {
    maxChars: limitValue(limits.maxChars, DEFAULT_LIMITS.maxChars),
    maxResources: limitValue(limits.maxResources, DEFAULT_LIMITS.maxResources),
    maxTotalBytes: limitValue(limits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
    maxResourceBytes: limitValue(limits.maxResourceBytes, DEFAULT_LIMITS.maxResourceBytes),
    maxPages: limitValue(limits.maxPages, DEFAULT_LIMITS.maxPages),
  };
  const call = createCliCall(run);
  const invoke = (args) => call([...args, ...IDENTITY]);
  const readers = resourceReaders ?? createCliResourceReaders({ run, limits: settings });

  const read = async (link) => {
    if (typeof link?.requestId !== 'string' || !REQUEST_ID.test(link.requestId)) {
      fail('INVALID_REQUEST_ID');
    }
    let normalized;
    try {
      normalized = normalizeDocumentLink(link?.url, { hosts });
    } catch (cause) {
      fail('INVALID_DOCUMENT_LINK', cause);
    }
    if (
      (link.kind !== undefined && link.kind !== normalized.kind)
      || (link.token !== undefined && link.token !== normalized.token)
    ) {
      fail('INVALID_DOCUMENT_LINK');
    }

    const requestDir = resolve(assetsDir, link.requestId);
    // Task 1 argv order: identity comes before --detail.
    const data = await call([
      'docs', '+fetch',
      '--doc', normalized.url,
      '--as', 'user',
      '--detail', 'full',
      '--json',
    ]);
    const document = data.document;
    if (!isPlainObject(document) || typeof document.content !== 'string') {
      fail('SOURCE_READ_FAILED');
    }
    if (typeof document.document_id !== 'string' || document.document_id === '') {
      fail('SOURCE_READ_FAILED');
    }
    const revision = document.revision_id === undefined || document.revision_id === null
      ? ''
      : String(document.revision_id);

    const parsed = parseContent({
      content: document.content,
      referenceMap: document.reference_map,
      maxChars: settings.maxChars,
      maxResources: settings.maxResources,
    });
    const { comments, commentsComplete } = await readComments({
      url: normalized.url,
      call: invoke,
      maxPages: settings.maxPages,
    });

    let chars = comments.reduce((total, comment) => total + comment.text.length, 0);
    for (const block of parsed.blocks) chars += block.text.length;
    if (chars > settings.maxChars) fail('SOURCE_LIMIT_EXCEEDED');

    try {
      mkdirSync(requestDir, { recursive: true });
    } catch {
      fail('SOURCE_READ_FAILED');
    }

    let totalBytes = 0;
    const resources = [];
    for (const transient of parsed.resources) {
      const base = {
        id: transient.id,
        kind: transient.kind,
        sourceBlockId: transient.sourceBlockId,
        status: 'pending',
        fingerprint: null,
        text: '',
        reason: transient.reason ?? null,
        sourceIds: transient.sourceBlockId ? [transient.sourceBlockId] : [],
        path: null,
      };

      if (transient.kind === 'reference') {
        base.text = transient.text;
        base.reason = transient.reason ?? 'REFERENCE_NOT_FOLLOWED';
        resources.push(base);
        continue;
      }

      const reader = readers?.[transient.kind];
      if (!transient.token || typeof reader !== 'function') {
        base.text = transient.text;
        base.reason = transient.reason ?? (transient.kind === 'video' ? 'NO_READER' : 'READ_FAILED');
        resources.push(base);
        continue;
      }

      let materialized;
      try {
        const result = await reader({ resource: transient, requestDir });
        const fingerprint = typeof result?.fingerprint === 'string' ? result.fingerprint : '';
        if (fingerprint === '') fail('READ_FAILED');
        const sourceIds = Array.isArray(result.sourceIds)
          && result.sourceIds.every((id) => typeof id === 'string')
          ? result.sourceIds
          : base.sourceIds;
        const path = resourcePath(result.path, requestDir);
        materialized = {
          ...base,
          status: 'parsed',
          fingerprint,
          text: typeof result.text === 'string' ? result.text : '',
          reason: null,
          sourceIds,
          path,
        };
        if (Number.isFinite(result.bytes)) {
          totalBytes += result.bytes;
        }
      } catch (error) {
        resources.push({ ...base, reason: failureReason(error) });
        continue;
      }
      if (totalBytes > settings.maxTotalBytes) fail('SOURCE_LIMIT_EXCEEDED');
      resources.push(materialized);
    }

    const snapshot = {
      documentId: document.document_id,
      url: normalized.url,
      title: parsed.title,
      revision,
      blocks: parsed.blocks,
      resources,
      comments,
      commentsComplete,
      requestId: link.requestId,
    };
    snapshot.fingerprint = snapshotFingerprint(snapshot);
    return snapshot;
  };

  const revalidate = async (snapshot) => {
    if (!validSnapshotShape(snapshot)) fail('SOURCE_RECHECK_FAILED');
    let link;
    try {
      link = normalizeDocumentLink(snapshot.url, { hosts });
    } catch (cause) {
      fail('SOURCE_RECHECK_FAILED', cause);
    }
    let fresh;
    try {
      fresh = await read({
        kind: link.kind,
        token: link.token,
        url: snapshot.url,
        requestId: snapshot.requestId,
      });
    } catch (cause) {
      // A re-check that cannot read the source is never "unchanged".
      fail('SOURCE_RECHECK_FAILED', cause);
    }
    if (fresh.documentId !== snapshot.documentId) fail('SOURCE_RECHECK_FAILED');
    if (fresh.fingerprint === snapshot.fingerprint) {
      return { unchanged: true, changes: [] };
    }
    return { unchanged: false, changes: diffSnapshots(snapshot, fresh) };
  };

  const cleanup = (requestId) => {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      fail('INVALID_REQUEST_ID');
    }
    try {
      rmSync(resolve(assetsDir, requestId), { recursive: true, force: true });
    } catch (cause) {
      // Raw fs errors echo the local path; report a fixed code instead.
      fail('CLEANUP_FAILED', cause);
    }
  };

  return { read, revalidate, cleanup };
}
