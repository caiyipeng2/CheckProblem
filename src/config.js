import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { normalizeProjects } from './projects.js';

export { normalizeProjects } from './projects.js';

// lark-cli only writes files beneath its allowlist (cwd, the account temp
// directory, ~/files). Node's os.tmpdir() follows TMP, which is relocated on
// this machine and refused by the CLI, so prefer the Windows per-user temp.
export function defaultImagesDir(env = process.env, home = homedir()) {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Temp') : join(home, 'files');
  return join(base, 'checkproblem-images');
}

const DEFAULTS = {
  triggerKeyword: '蔡龙',
  confirmTimeoutSec: 600,
  pollIntervalSec: 15,
  contextMessages: 5,
  maxReplyChars: 4000,
  // Tried in order; a slow engine only costs its own budget before the next one
  // starts. Every attempt still runs codex-shaped and read-only.
  analyze: {
    attempts: [
      { label: 'codex-fast', command: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', timeoutSec: 240 },
      { label: 'codex-deep', command: 'codex', timeoutSec: 600 },
    ],
  },
  dryRun: false,
};

// TAPD takes a fixed set of fields, and the operator writes them with the UI names.
// Mapping once here means src/tapd.js never guesses parameter names, and an unknown
// key fails at startup instead of silently dropping a value the tester expects.
//
// The list is closed on purpose, not just tidy: buildBugPayload spreads this map LAST,
// so `title`, `description` or `workspace_id` here would overwrite the analysis and the
// target workspace of an already-built ticket. Nothing reaches the payload key except
// the eight names below.
const TAPD_FIELDS = {
  versionReport: 'version_report',
  te: 'te',
  currentOwner: 'current_owner',
  cc: 'cc',
  severity: 'severity',
  priority: 'priority',
  frequency: 'frequency',
};
const TAPD_VALUE_LIMIT = 100;
const WORKSPACE_ID = /^\d{6,20}$/;

// `device` is deliberately not a ticket field: TAPD's `os` is 操作系统 with an empty
// candidate list, and neither game workspace has any 机型/设备 field at all, so the
// team's 使用机型 only survives as a line of the description (src/tapd.js).
function tapdDevice(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`config: ${where} must be a string`);
  const text = value.trim();
  if (text.length > TAPD_VALUE_LIMIT) throw new Error(`config: ${where} is too long`);
  return text === '' ? undefined : text;
}

function tapdFields(raw, where) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    // Object.hasOwn, not `in`: a config object comes from JSON.parse, so a key like
    // `constructor` or `__proto__` is an own property that `in` would accept through
    // Object.prototype and map to a function instead of a TAPD parameter name.
    if (!Object.hasOwn(TAPD_FIELDS, key)) throw new Error(`config: ${where} has unknown field ${key}`);
    if (value === null || value === undefined) continue;
    const text = String(value);
    // The key is named, never the value: an over-long field is proof of a mistake, and
    // the config file may hold text that does not belong in a log line.
    if (text.length > TAPD_VALUE_LIMIT) throw new Error(`config: ${where}.${key} is too long`);
    if (text.trim() !== '') out[TAPD_FIELDS[key]] = text;
  }
  return out;
}

export function normalizeTapd(raw, projects) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('config: tapd must be an object');
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('config: tapd requires projects');
  const tokenFile = typeof raw.tokenFile === 'string' && raw.tokenFile.trim() !== '' ? raw.tokenFile.trim() : null;
  if (!tokenFile) throw new Error('config: tapd.tokenFile is required');
  const baseUrl = raw.baseUrl === undefined ? 'https://api.tapd.cn' : String(raw.baseUrl);
  if (!/^https:\/\/api\.tapd\.cn(\/.*)?$/.test(baseUrl)) throw new Error('config: tapd.baseUrl must be https://api.tapd.cn');
  const base = tapdFields(raw.fields, 'tapd.fields');
  const baseDevice = tapdDevice(raw.device, 'tapd.device');
  const ids = new Set(projects.map((project) => project.id));
  const workspaces = {};
  for (const [projectId, value] of Object.entries(raw.workspaces ?? {})) {
    if (!ids.has(projectId)) throw new Error(`config: tapd.workspaces.${projectId} has no matching project`);
    const workspaceId = String(value?.workspaceId ?? '');
    if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`config: tapd.workspaces.${projectId}.workspaceId must be 6-20 digits`);
    // A path is checked for shape only: createTapdClient reads it at ticket time, so the
    // file may live on a machine that exists only at deploy. Same type check as the
    // top-level tokenFile: String(null) would load as the literal path "null" and fail
    // only when someone clicks the ticket button. Absent means inherit; present must be
    // a non-empty string.
    const rawOverride = value?.tokenFile;
    if (rawOverride !== undefined && typeof rawOverride !== 'string') {
      throw new Error(`config: tapd.workspaces.${projectId}.tokenFile must be a string`);
    }
    const override = rawOverride === undefined ? tokenFile : rawOverride.trim();
    if (override === '') throw new Error(`config: tapd.workspaces.${projectId}.tokenFile is empty`);
    const device = value?.device === undefined ? baseDevice : tapdDevice(value.device, `tapd.workspaces.${projectId}.device`);
    workspaces[projectId] = { workspaceId, tokenFile: override, device, fields: { ...base, ...tapdFields(value?.fields, `tapd.workspaces.${projectId}.fields`) } };
  }
  return { baseUrl, tokenFile, workspaces };
}

export function loadConfig(filePath) {
  const abs = resolve(filePath);
  const root = dirname(abs);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  if (!raw.chatId) throw new Error('config: chatId is required');
  if (!raw.selfOpenId) throw new Error('config: selfOpenId is required');

  const repo = { mode: 'clone', branch: 'master', ...(raw.repo ?? {}) };
  if (repo.dir && !isAbsolute(repo.dir)) repo.dir = join(root, repo.dir);

  const projects = normalizeProjects(raw.projects, root);
  const projectConfig = {};
  if (projects !== undefined) {
    const defaultProjectId = raw.defaultProjectId === undefined ? projects[0].id : raw.defaultProjectId;
    if (!projects.some((project) => project.id === defaultProjectId)) {
      throw new Error('config: defaultProjectId must match a configured project id');
    }
    Object.assign(projectConfig, { projects, defaultProjectId });
  }

  // An absent tapd block leaves config.tapd undefined, and every card and ticket
  // feature stays off.
  const tapd = normalizeTapd(raw.tapd, projects);

  return {
    ...DEFAULTS,
    ...raw,
    ...projectConfig,
    ...(tapd ? { tapd } : {}),
    analyze: {
      ...DEFAULTS.analyze,
      ...(raw.analyze ?? {}),
      attempts:
        Array.isArray(raw.analyze?.attempts) && raw.analyze.attempts.length > 0
          ? raw.analyze.attempts
          : DEFAULTS.analyze.attempts,
    },
    repo,
    root,
    paths: {
      stateFile: join(root, 'state', 'state.json'),
      logDir: join(root, 'logs'),
      jobsDir: join(root, 'logs', 'jobs'),
      imagesDir: defaultImagesDir(),
    },
  };
}
