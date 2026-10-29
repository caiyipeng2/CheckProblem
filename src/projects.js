import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NETWORK_TIMEOUT_MS = 1_800_000;
// Identity-based authority: callback objects (even with a plausible dir) cannot
// authorize destructive work. selectProject transfers this authority to its result.
const serviceProjects = new WeakMap();

export function validateBranch(branch) {
  if (typeof branch !== 'string' || !branch || branch.length > 500 || /[^\p{L}\p{N}\p{M}/_.+&-]/u.test(branch)
      || branch.startsWith('-') || branch.includes('..') || branch.endsWith('.')
      || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('project branch is not a safe Git branch');
  }
  return branch;
}

function validateUrl(url) {
  // The existing runner uses a shell on Windows. Do not permit expansions,
  // quoting, whitespace, URL credentials, or query/fragment delimiters.
  if (typeof url !== 'string' || !url.startsWith('https://') || /[^A-Za-z0-9._:/+-]/.test(url)) {
    throw new Error('project url must be shell-safe HTTPS without credentials, query or fragment');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('project url is invalid'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw new Error('project url must be HTTPS without credentials, query or fragment');
  }
  return url;
}

export function normalizeProjects(rawProjects, root) {
  if (rawProjects === undefined) return undefined;
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    throw new Error('config: projects must be a nonempty array');
  }
  const ids = new Set();
  return rawProjects.map((project) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('config: project must be an object');
    }
    const { id, name, url, branch = 'master' } = project;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id) || /[^a-z0-9-]/.test(id)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) {
      throw new Error('config: project id is invalid or a reserved Windows directory name');
    }
    if (ids.has(id.toLowerCase())) throw new Error('config: duplicate project id');
    ids.add(id.toLowerCase());
    if (typeof name !== 'string' || !name.trim() || name.length > 80) {
      throw new Error('config: project name must be nonempty and at most 80 characters');
    }
    if (Object.hasOwn(project, 'dir') || Object.hasOwn(project, 'mode')) {
      throw new Error('config: project dir/mode are service-derived, not configurable');
    }
    const normalized = {
      id, name, url: validateUrl(url), branch: validateBranch(branch),
      dir: join(resolve(root), 'repo', 'cards', id), mode: 'clone',
    };
    serviceProjects.set(normalized, { ...normalized });
    return normalized;
  });
}

function assertServiceProject(repo) {
  const trusted = serviceProjects.get(repo);
  if (!trusted || ['id', 'name', 'url', 'dir', 'mode', 'branch'].some((key) => repo[key] !== trusted[key])) {
    throw new Error('project must be an unmodified normalized/selected service clone');
  }
  // Paths come from trusted config roots, but still cross the shell boundary.
  if (/[\x00-\x1f\x7f"'`$%!&|<>^();]/.test(repo.dir)) throw new Error('unsafe service project dir');
  return trusted;
}

export function selectProject(config, projectId, branch) {
  const project = config.projects?.find((item) => item.id === projectId);
  if (!project) throw new Error('unknown project id');
  assertServiceProject(project);
  const selected = { ...project, branch: validateBranch(branch === undefined ? project.branch : branch) };
  serviceProjects.set(selected, { ...selected });
  return selected;
}

function assertOk(result, operation) {
  if (!result || result.code !== 0 || result.truncated) {
    throw new Error(`git ${operation} failed: ${(result?.stderr || result?.stdout || '').slice(0, 300)}`);
  }
  return String(result.stdout ?? '');
}

export async function listRemoteBranches({ url, run, timeoutMs = 30000 }) {
  validateUrl(url);
  const output = assertOk(await run('git', ['ls-remote', '--heads', '--', url], { timeoutMs }), 'ls-remote');
  const branches = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue;
    const match = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\trefs\/heads\/(.+)$/.exec(line);
    if (!match) throw new Error('git ls-remote returned a malformed branch ref');
    branches.add(validateBranch(match[1]));
  }
  if (!branches.size) throw new Error('git ls-remote returned no remote branches');
  return [...branches].sort();
}

function statIfPresent(path) {
  try { return lstatSync(path); } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function assertDirectoryChain(path) {
  for (let current = path; ; current = dirname(current)) {
    const stat = statIfPresent(current);
    // Node reports Windows junction/reparse symlinks through isSymbolicLink().
    if (stat?.isSymbolicLink()) throw new Error(`service directory cannot be a symlink/reparse point: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`service directory is not a directory: ${current}`);
    if (dirname(current) === current) break;
  }
}

function inspectServiceDirectory(repo, requireRepository = false) {
  assertServiceProject(repo);
  assertDirectoryChain(repo.dir);
  const gitDir = join(repo.dir, '.git');
  const gitStat = statIfPresent(gitDir);
  if (gitStat) {
    assertDirectoryChain(gitDir); // Reject linked worktrees and redirected .git dirs.
    return true;
  }
  if (requireRepository) throw new Error('service clone is not a git repository');
  if (statIfPresent(repo.dir) && readdirSync(repo.dir).length !== 0) {
    throw new Error('service project directory is a nonempty non-repository');
  }
  return false;
}

async function verifyRepository(repo, run) {
  if (!inspectServiceDirectory(repo)) throw new Error('service clone is not a git repository');
  const git = async (args) => assertOk(await run('git', ['-C', repo.dir, ...args]), args[0]).trim();
  const top = await git(['rev-parse', '--show-toplevel']);
  const gitDir = await git(['rev-parse', '--absolute-git-dir']);
  if (!top || !gitDir || resolve(top) !== resolve(repo.dir) || resolve(gitDir) !== join(repo.dir, '.git')) {
    throw new Error('git repository boundaries do not match the service clone');
  }
  const origin = await git(['remote', 'get-url', '--all', 'origin']);
  if (origin !== repo.url) throw new Error('git origin URL does not match configured project url');
}

// Caller holds the config-root PID lock across this AND subsequent analysis.
export async function syncSelectedProject({ repo, run, log }) {
  const existing = inspectServiceDirectory(repo);
  const branches = await listRemoteBranches({ url: repo.url, run });
  if (!branches.includes(repo.branch)) throw new Error('selected branch no longer exists on the remote');
  if (existing) await verifyRepository(repo, run);
  else {
    inspectServiceDirectory(repo);
    mkdirSync(dirname(repo.dir), { recursive: true });
    inspectServiceDirectory(repo);
    log?.info?.(`cloning ${repo.url} -> ${repo.dir}`);
    assertOk(await run('git', ['clone', '--branch', repo.branch, '--', repo.url, repo.dir], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    }), 'clone');
    await verifyRepository(repo, run);
  }
  const remoteRef = `refs/remotes/origin/${repo.branch}`;
  inspectServiceDirectory(repo, true);
  // An explicit refspec fails if the remote branch vanished; generic fetch can
  // leave a stale local ref, especially in a previously single-branch clone.
  assertOk(await run('git', ['-C', repo.dir, 'fetch', '--prune', 'origin',
    `+refs/heads/${repo.branch}:${remoteRef}`], { timeoutMs: NETWORK_TIMEOUT_MS }), 'fetch');
  await verifyRepository(repo, run);
  inspectServiceDirectory(repo, true);
  assertOk(await run('git', ['-C', repo.dir, 'reset', '--hard', remoteRef]), 'reset');
  inspectServiceDirectory(repo, true);
  assertOk(await run('git', ['-C', repo.dir, 'clean', '-fd']), 'clean');
  inspectServiceDirectory(repo, true);
  const commit = assertOk(await run('git', ['-C', repo.dir, 'rev-parse', '--short', 'HEAD']), 'rev-parse').trim();
  if (!/^[a-fA-F0-9]{4,64}$/.test(commit)) throw new Error('git returned an invalid commit');
  const provenance = `${repo.branch}@${commit}`;
  log?.info?.(`analysing ${repo.dir} at ${provenance}`);
  return { branch: repo.branch, commit, dirty: 0, provenance };
}
