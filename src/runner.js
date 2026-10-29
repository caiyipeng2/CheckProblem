// The only module that starts processes.
//
// Windows shape: lark-cli and codex are npm `.cmd` shims, which cannot be
// spawned without a shell, so `shell: true` is mandatory. That turns argv into
// one cmd.exe command line: arguments are quoted here and untrusted bodies
// travel on stdin. Runtime failures never reject the promise.

import { spawn } from 'node:child_process';

const SAFE_ARG = /^[A-Za-z0-9_@.,:=+\\/-]+$/;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const SPAWN_ERROR_EXIT = 127;
const TIMEOUT_EXIT = 124;

// Every child gets a budget. A call that never returns would leave the poll
// tick pending forever, which silently stops the service: no error, no log.
const DEFAULT_TIMEOUT_MS = 120_000;

// cmd.exe re-parses the whole command line and does not honour the `\"`
// escaping CommandLineToArgvW expects, so one quote anywhere inside the JSON
// can end the quoted run early and hand `&`, `|` or `%VAR%` back to cmd. The
// exemption therefore holds only while every string inside the value — object
// keys included — is inert on its own.
function jsonIsShellInert(parsed) {
  const stack = [parsed];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (!SAFE_ARG.test(item)) return false;
      continue;
    }
    // JSON numbers, booleans and null serialize to characters SAFE_ARG
    // already permits (digits, signs, '.', 'e', letters).
    if (item === null || typeof item === 'number' || typeof item === 'boolean') continue;
    if (Array.isArray(item)) {
      for (const value of item) stack.push(value);
      continue;
    }
    if (typeof item === 'object') {
      for (const [key, value] of Object.entries(item)) {
        if (!SAFE_ARG.test(key)) return false;
        stack.push(value);
      }
      continue;
    }
    return false;
  }
  return true;
}

// lark-cli's `--params` is the one legitimate quoted argument: JSON.stringify
// output with no whitespace and nothing inside that cmd.exe could act on.
// Arbitrary quoted text is still refused.
function isSafeJsonArg(value) {
  if (!/^[{[]/.test(value) || /\s/.test(value)) return false;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return jsonIsShellInert(parsed);
}

// CommandLineToArgvW quoting: backslashes are literal unless they precede a
// quote; a quote is escaped and the backslashes before it are doubled.
function escapeForCmd(value) {
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

export function quoteArg(arg) {
  const value = String(arg);
  if (SAFE_ARG.test(value)) return value;
  if (value.includes('"') && !isSafeJsonArg(value)) {
    throw new Error(`runner: refusing an argument with a quote character: ${value.slice(0, 80)}`);
  }
  return escapeForCmd(value);
}

// With `shell: true` a missing executable is reported by cmd.exe, not by a
// spawn 'error' event: exit 1 (9009 on some builds) and a diagnostic that
// starts with the command name in quotes, in every locale.
function isMissingCommand(cmd, code, stdout, stderr) {
  if (code !== 1 && code !== 9009) return false;
  if (stdout !== '') return false;
  const text = stderr.trimStart();
  return text.startsWith(`'${cmd}'`) || text.startsWith(`"${cmd}"`);
}

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

export function run(cmd, args, { stdin, timeoutMs } = {}) {
  // Quote before spawning: an unquotable argument is a programming error and
  // must surface as such rather than reach the shell.
  const useShell = cmd !== 'git';
  const quoted = useShell ? [cmd, ...args].map(quoteArg) : [cmd, ...args];

  // A missing or nonsensical budget falls back to the default rather than
  // meaning "no timeout": unbounded is never a safe option here.
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(quoted[0], quoted.slice(1), {
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: SPAWN_ERROR_EXIT, stdout: '', stderr: messageOf(err) });
      return;
    }

    const out = { chunks: [], bytes: 0, full: false };
    const err = { chunks: [], bytes: 0, full: false };
    let truncated = false;
    let settled = false;
    let timer = null;

    const textOf = (state) => Buffer.concat(state.chunks).toString('utf8');

    const finish = (code, overrides = {}) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const result = {
        code,
        stdout: overrides.stdout ?? textOf(out),
        stderr: overrides.stderr ?? textOf(err),
      };
      if (truncated) result.truncated = true;
      resolve(result);
    };

    // The direct child is cmd.exe; killing only it would orphan the real
    // codex process, which keeps the pipes (and this process) alive. taskkill
    // must therefore go first, while the shell pid is still resolvable; the
    // plain kill is only the fallback when taskkill cannot even be started.
    const killTree = () => {
      const pid = child.pid;
      let treeKillStarted = false;
      if (pid && process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {});
          killer.unref();
          treeKillStarted = true;
        } catch {
          // fall through to the direct kill
        }
      }
      if (treeKillStarted) return;
      try {
        child.kill();
      } catch {
        // already gone
      }
    };

    const collect = (state, chunk) => {
      if (settled || state.full) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = MAX_STREAM_BYTES - state.bytes;
      if (buf.length > room) {
        if (room > 0) state.chunks.push(buf.subarray(0, room));
        state.bytes = MAX_STREAM_BYTES;
        state.full = true;
        truncated = true;
        killTree();
        return;
      }
      state.chunks.push(buf);
      state.bytes += buf.length;
    };

    child.stdout.on('data', (chunk) => collect(out, chunk));
    child.stderr.on('data', (chunk) => collect(err, chunk));

    child.on('error', (spawnErr) => {
      finish(SPAWN_ERROR_EXIT, { stdout: '', stderr: messageOf(spawnErr) });
    });

    child.on('close', (code) => {
      if (settled) return;
      const exitCode = typeof code === 'number' ? code : 1;
      const stdout = textOf(out);
      const stderr = textOf(err);
      if (isMissingCommand(cmd, exitCode, stdout, stderr)) {
        finish(SPAWN_ERROR_EXIT, { stdout: '', stderr });
        return;
      }
      finish(exitCode, { stdout, stderr });
    });

    timer = setTimeout(() => {
      if (settled) return;
      killTree();
      // Resolve now so the wait stays bounded even if the tree refuses to die.
      finish(TIMEOUT_EXIT, {
        stderr: textOf(err) + `\n分析超时（${budgetMs / 1000} 秒）`,
      });
    }, budgetMs);

    // The child may exit before reading stdin; EPIPE must not become an
    // unhandled stream error.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin === undefined || stdin === null ? undefined : stdin);
  });
}
