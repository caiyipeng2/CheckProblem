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

function documentHosts(raw) {
  const where = 'documentHosts';
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(where, 'must be a non-empty array of bare hostnames');
  }
  const hosts = raw.map((value) => {
    if (typeof value !== 'string') fail(where, 'must be a non-empty array of bare hostnames');
    const host = value.trim().toLowerCase();
    // No scheme, path, port or wildcard: a link's host must equal one of these exactly.
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      fail(where, 'must be a non-empty array of bare hostnames');
    }
    return host;
  });
  return [...new Set(hosts)];
}

function modelAttempt(raw, analyze) {
  const where = 'modelAttempt';
  if (!Array.isArray(analyze) || !Number.isInteger(raw) || raw < 0 || raw >= analyze.length) {
    fail(where, 'must be an integer index into analyze');
  }
  const attempt = analyze[raw];
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    fail(where, 'must reference a chat attempt');
  }
  if (typeof attempt.command === 'string' && attempt.command !== '') {
    fail(where, 'must reference a chat attempt');
  }
  if (typeof attempt.apiKeyFile !== 'string' || attempt.apiKeyFile.trim() === '') {
    fail(where, 'must reference a chat attempt with apiKeyFile');
  }
  if ((attempt.apiKeyEnv ?? '') !== '') {
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
    entries[projectId] = {
      parentTypeId: requiredString(entry.parentTypeId, `${where}.parentTypeId`),
      childTypeId: requiredString(entry.childTypeId, `${where}.childTypeId`),
      templateId: requiredString(entry.templateId, `${where}.templateId`),
      owners: stringList(entry.owners, `${where}.owners`, { allowEmpty: false }),
      iterationIds: stringList(entry.iterationIds, `${where}.iterationIds`, { allowEmpty: true }),
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
  const hosts = documentHosts(raw.documentHosts);
  const attempt = modelAttempt(raw.modelAttempt, analyze);
  const entries = projectEntries(raw.projects, projects, tapd);

  return {
    allowedSenders,
    reviewers,
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
