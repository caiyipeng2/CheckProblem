// Pure classification of planning-document messages. No I/O, no clock, no network.

const URL_PATTERN = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"…，。；：！？）、】」』”’]+$/u;
const EDIT_PREFIX = '修改拆分';
const START_COMMAND = '拆分需求';

function parseBody(message) {
  const raw = message?.body?.content ?? message?.content ?? '';
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectNode(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectNode(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.tag === 'text' || node.tag === 'md') {
    if (typeof node.text === 'string') out.texts.push(node.text);
  } else if (node.tag === 'a') {
    if (typeof node.text === 'string') out.texts.push(node.text);
    if (typeof node.href === 'string') out.urls.push(node.href);
  } else if (node.tag === 'at') {
    if (typeof node.user_id === 'string') out.atIds.push(node.user_id);
  }
  // Locale wrappers and paragraph arrays hide the same nodes one level down.
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectNode(value, out);
  }
}

function postBlocks(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.content)) return [payload.content];
  return Object.values(payload)
    .map((locale) => locale?.content)
    .filter((content) => Array.isArray(content));
}

function messageParts(message) {
  const payload = parseBody(message);
  if (!payload || typeof payload !== 'object') return { text: '', urls: [], atIds: [] };
  if (message?.msg_type === 'text') {
    return { text: typeof payload.text === 'string' ? payload.text : '', urls: [], atIds: [] };
  }
  if (message?.msg_type !== 'post') return { text: '', urls: [], atIds: [] };
  const out = { texts: [], urls: [], atIds: [] };
  for (const block of postBlocks(payload)) collectNode(block, out);
  return { text: out.texts.join(''), urls: out.urls, atIds: out.atIds };
}

function hasBotMention(message, parts, selfOpenId) {
  if (typeof selfOpenId !== 'string' || selfOpenId === '') return false;
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  return mentions.some((mention) => mention?.id?.open_id === selfOpenId)
    || parts.atIds.includes(selfOpenId);
}

function urlsInText(text) {
  const urls = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    if (candidate) urls.push(candidate);
  }
  return urls;
}

function gatherDocuments(parts, hosts) {
  const documents = [];
  const seen = new Set();
  for (const candidate of [...urlsInText(parts.text), ...parts.urls]) {
    let document;
    try {
      document = normalizeDocumentLink(candidate, { hosts });
    } catch {
      continue; // A stray link must not make the whole command unusable.
    }
    const key = `${document.kind}:${document.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(document);
  }
  return documents;
}

function stripMentions(text) {
  return String(text ?? '').replace(/@_user_\d+/g, '').trim();
}

function textMentionsId(text, id) {
  if (!text) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

export function normalizeDocumentLink(rawUrl, { hosts } = {}) {
  if (typeof rawUrl !== 'string') throw new Error('UNTRUSTED_DOCUMENT_URL');
  // new URL drops a default port and empty userinfo, so inspect the raw
  // authority: allowlisted hosts are DNS names, and any ':' or '@' there means
  // a port, userinfo or IPv6 literal. Parsed checks below remain as backup.
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(rawUrl)?.[1];
  if (authority === undefined || authority.includes(':') || authority.includes('@')) {
    throw new Error('UNTRUSTED_DOCUMENT_URL');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('UNTRUSTED_DOCUMENT_URL');
  }
  const hostname = url.hostname.toLowerCase();
  const allowlist = Array.isArray(hosts) ? hosts : [];
  const trusted = allowlist.some(
    (host) => typeof host === 'string' && host.trim().toLowerCase() === hostname,
  );
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hostname || !trusted) {
    throw new Error('UNTRUSTED_DOCUMENT_URL');
  }
  const match = /^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error('UNSUPPORTED_DOCUMENT_URL');
  const [, kind, token] = match;
  return { kind, token, url: `https://${hostname}/${kind}/${token}` };
}

export function resolveRequestReference(message, requests) {
  const { text: rawText } = messageParts(message);
  // An id embedded in a link is part of the attachment, not a reference.
  const text = rawText.replace(URL_PATTERN, ' ');
  const matched = new Set();
  const threadIds = new Set(
    [message?.parent_id, message?.root_id]
      .filter((id) => id !== undefined && id !== null && String(id) !== '')
      .map(String),
  );
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== 'object') continue;
    const { id } = request;
    if (typeof id !== 'string' || id === '') continue;
    if (textMentionsId(text, id)) matched.add(id);
    const references = [
      request.triggerMessageId,
      ...(Array.isArray(request.cardMessageIds) ? request.cardMessageIds : []),
    ];
    if (references.some((reference) => reference !== undefined && reference !== null
      && String(reference) !== '' && threadIds.has(String(reference)))) {
      matched.add(id);
    }
  }
  if (matched.size === 0) return null;
  if (matched.size > 1) throw new Error('AMBIGUOUS_REQUEST');
  return [...matched][0];
}

export function classifyRequirementMessage(message, options = {}) {
  const { selfOpenId, hosts, requests = [] } = options;
  const parts = messageParts(message);
  if (!hasBotMention(message, parts, selfOpenId)) return null;

  const cleaned = stripMentions(parts.text);
  if (cleaned.startsWith(EDIT_PREFIX)) {
    const requestId = resolveRequestReference(message, requests);
    if (!requestId) return null;
    const text = cleaned
      .slice(EDIT_PREFIX.length)
      .replace(/^[\s:：]+/, '')
      .trim();
    return {
      kind: 'edit',
      requestId,
      text,
      parentId: message?.parent_id || null,
      rootId: message?.root_id || null,
    };
  }

  if (!cleaned.startsWith(START_COMMAND)) return null;
  const documents = gatherDocuments(parts, hosts);
  return documents.length > 0 ? { kind: 'start', documents } : null;
}
