import { join } from 'node:path';

function fail(where, reason) {
  throw new Error(`config: requirements${where ? `.${where}` : ''} ${reason}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(where, 'must be a non-empty string');
  return value.trim();
}

function stringList(value, where, { allowEmpty }) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(where, allowEmpty ? 'must be an array of non-empty strings' : 'must be a non-empty array of non-empty strings');
  }
  return value.map((item) => requiredString(item, where));
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_HOSTNAME_LENGTH = 253;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,120}$/;

// The poller runs under the service account, but the command mentions the bot.
// Without an explicit bot id the mention check would compare against the wrong
// account and the command would silently never trigger.
function botOpenId(raw) {
  const value = requiredString(raw, 'botOpenId');
  if (!OPEN_ID.test(value)) fail('botOpenId', 'must be the bot open_id (ou_…)');
  return value;
}

function documentHosts(raw) {
  const where = 'documentHosts';
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(where, 'must be a non-empty array of bare hostnames');
  }
  const hosts = raw.map((value) => {
    if (typeof value !== 'string') fail(where, 'must be a non-empty array of bare hostnames');
    const host = value.trim().toLowerCase();
    // No scheme, path, port or wildcard: a link's host must equal one of these
    // exactly, so only a sequence of DNS labels is a usable allowlist entry.
    if (host.length > MAX_HOSTNAME_LENGTH || !HOSTNAME.test(host)) {
      fail(where, 'must be a non-empty array of bare hostnames');
    }
    return host;
  });
  return [...new Set(hosts)];
}

function modelAttempt(raw, analyze) {
  const where = 'modelAttempt';
  const attempts = Array.isArray(analyze) ? analyze : analyze?.attempts;
  if (!Array.isArray(attempts) || !Number.isInteger(raw) || raw < 0 || raw >= attempts.length) {
    fail(where, 'must be an integer index into analyze');
  }
  const attempt = attempts[raw];
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    fail(where, 'must reference a chat attempt');
  }
  if (typeof attempt.command === 'string' && attempt.command !== '') {
    fail(where, 'must reference a chat attempt');
  }
  // A chat endpoint must be declared in full. In particular apiKeyEnv must be
  // present and empty: an absent value would make resolveApiKey fall back to
  // DEEPSEEK_API_KEY in the process environment.
  if (attempt.kind !== 'chat'
    || typeof attempt.baseUrl !== 'string' || attempt.baseUrl.trim() === ''
    || typeof attempt.model !== 'string' || attempt.model.trim() === '') {
    fail(where, 'must reference a chat attempt with baseUrl and model');
  }
  if (typeof attempt.apiKeyFile !== 'string' || attempt.apiKeyFile.trim() === '') {
    fail(where, 'must reference a chat attempt with apiKeyFile');
  }
  if (attempt.apiKeyEnv !== '') {
    fail(where, "must use apiKeyEnv:''");
  }
  return attempt;
}

function projectEntries(raw, projects, tapd) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    fail('projects', 'must be a non-empty object');
  }
  const known = new Set(
    (Array.isArray(projects) ? projects : [])
      .map((project) => project?.id)
      .filter((id) => typeof id === 'string'),
  );
  const workspaces = tapd && typeof tapd === 'object' && isPlainObject(tapd.workspaces)
    ? tapd.workspaces
    : null;
  const entries = {};
  for (const [projectId, entry] of Object.entries(raw)) {
    const where = `projects.${projectId}`;
    if (!known.has(projectId)) fail(where, 'has no matching project');
    // Object.hasOwn, not `in`: the workspaces map inherits Object.prototype,
    // so a project named constructor must not look like a mapped workspace.
    if (!workspaces || !Object.hasOwn(workspaces, projectId) || !workspaces[projectId]) {
      fail(where, 'has no TAPD workspace mapping');
    }
    if (!isPlainObject(entry)) fail(where, 'must be an object');
    // The document's existing parent is a deployment fact, so it comes from the
    // config: a reviewer can see it as verified but never hand-type a new id.
    const parentStoryId = entry.parentStoryId === undefined
      ? ''
      : requiredString(entry.parentStoryId, `${where}.parentStoryId`);
    if (parentStoryId !== '' && !/^\d{6,32}$/.test(parentStoryId)) {
      fail(`${where}.parentStoryId`, 'must be a TAPD story id');
    }
    const parentOwner = entry.parentOwner === undefined
      ? ''
      : requiredString(entry.parentOwner, `${where}.parentOwner`);
    const parentIterationId = entry.parentIterationId === undefined
      ? ''
      : requiredString(entry.parentIterationId, `${where}.parentIterationId`);
    const titlePrefix = entry.titlePrefix === undefined
      ? ''
      : requiredString(entry.titlePrefix, `${where}.titlePrefix`);
    entries[projectId] = {
      parentTypeId: requiredString(entry.parentTypeId, `${where}.parentTypeId`),
      childTypeId: requiredString(entry.childTypeId, `${where}.childTypeId`),
      templateId: requiredString(entry.templateId, `${where}.templateId`),
      owners: stringList(entry.owners, `${where}.owners`, { allowEmpty: false }),
      iterationIds: stringList(entry.iterationIds, `${where}.iterationIds`, { allowEmpty: true }),
      ...(parentStoryId === '' ? {} : { parentStoryId }),
      ...(parentOwner === '' ? {} : { parentOwner }),
      ...(parentIterationId === '' ? {} : { parentIterationId }),
      ...(titlePrefix === '' ? {} : { titlePrefix }),
    };
  }
  return entries;
}

export function normalizeRequirements(raw, { projects, tapd, analyze, root } = {}) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new Error('config: requirements must be an object');

  const allowedSenders = stringList(raw.allowedSenders, 'allowedSenders', { allowEmpty: false });
  const reviewers = [...new Set(stringList(
    raw.reviewers === undefined ? [] : raw.reviewers,
    'reviewers',
    { allowEmpty: true },
  ))];
  const bot = botOpenId(raw.botOpenId);
  const hosts = documentHosts(raw.documentHosts);
  const attempt = modelAttempt(raw.modelAttempt, analyze);
  const entries = projectEntries(raw.projects, projects, tapd);

  return {
    allowedSenders,
    reviewers,
    botOpenId: bot,
    documentHosts: hosts,
    modelAttempt: raw.modelAttempt,
    attempt,
    projects: entries,
    paths: {
      stateFile: join(root, 'state', 'requirements.json'),
      assetsDir: join(root, 'state', 'requirement-assets'),
    },
  };
}

// The submitter builds TAPD payloads straight from this map (it needs the types
// and the template, not just the workspace), so the entry point and the tests
// must derive it the same way instead of each assembling their own shape.
export function requirementTargets({ tapd, requirements } = {}) {
  const targets = {};
  for (const [projectId, entry] of Object.entries(requirements?.projects ?? {})) {
    const workspaceId = tapd?.workspaces?.[projectId]?.workspaceId;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw new Error(`config: requirements.projects.${projectId} has no TAPD workspace id`);
    }
    const parent = {};
    if (entry.parentStoryId !== undefined) {
      parent.mode = 'bind';
      parent.storyId = entry.parentStoryId;
    }
    if (entry.parentOwner !== undefined) parent.owner = entry.parentOwner;
    if (entry.parentIterationId !== undefined) parent.iterationId = entry.parentIterationId;
    targets[projectId] = {
      workspaceId,
      parentTypeId: entry.parentTypeId,
      childTypeId: entry.childTypeId,
      templateId: entry.templateId,
      ...(entry.titlePrefix === undefined ? {} : { titlePrefix: entry.titlePrefix }),
      ...(Object.keys(parent).length === 0 ? {} : { parent }),
    };
  }
  return targets;
}
