import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const EVENT_KEY = 'card.action.trigger';
const READY_MARKER = `[event] ready event_key=${EVENT_KEY}`;
const MAX_LINE_BYTES = 256 * 1024;

// This consumer owns only its child process/streams, never the shared CLI event bus.
// onEvent must synchronously enqueue work; analysis must not block consumption.
export function startCardEvents({
  onEvent, log, spawnImpl = spawn, startupTimeoutMs = 15000, shutdownTimeoutMs = 5000,
}) {
  let child, timer, shutdownTimer;
  let stopping = false, failed = false, closed = false, exited = false, readySettled = false;
  let resolveReady, rejectReady, resolveDone, rejectDone;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Both may reject together while a caller is still awaiting ready. Retain the
  // original rejecting promises, but prevent an interim unhandled rejection.
  ready.catch(() => {});
  done.catch(() => {});

  function settleReady(error) {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(timer);
    if (error) rejectReady(error);
    else resolveReady();
  }

  function forceShutdown() {
    if (closed) return;
    fail('shutdown timed out waiting for consumer close');
    diagnostic('error', 'bounded shutdown failed: consumer did not close; releasing owned handles');
    const killFailed = () => diagnostic('error', 'bounded shutdown failed: could not terminate owned consumer');
    try {
      // An observed exit is not stream closure, but its PID may already have
      // been reused. Never target that PID, a process name, or the shared bus.
      if (!exited) {
        if (process.platform === 'win32') {
          if (Number.isSafeInteger(child.pid) && child.pid > 0) {
            const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore',
            });
            killer.on('error', killFailed);
            killer.on('close', (code) => { if (code !== 0) killFailed(); });
            // Even a stalled/failed taskkill must not keep this service alive.
            killer.unref();
          } else {
            killFailed();
          }
        } else if (!child.kill('SIGKILL')) {
          killFailed();
        }
      }
    } catch {
      killFailed();
    } finally {
      // OS signaling is not proof of closure. Bound our own handle lifetime
      // even when termination fails or a descendant holds a pipe open.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream?.destroy(); }
        catch { diagnostic('error', 'bounded shutdown failed: could not destroy owned stream'); }
      }
      try { child.unref(); }
      catch { diagnostic('error', 'bounded shutdown failed: could not unref owned consumer'); }
    }
  }

  function endStdin() {
    if (!child || closed || shutdownTimer !== undefined) return;
    // Keep this timer referenced: done rejects promptly on failure, but the
    // caller must not exit before attempting cleanup. Repeated stop/fail calls
    // must neither cancel nor extend this independent shutdown deadline.
    shutdownTimer = setTimeout(forceShutdown, shutdownTimeoutMs);
    if (child.stdin && !child.stdin.writableEnded) {
      try { child.stdin.end(); } catch { fail('stdin shutdown failed'); }
    }
  }

  function fail(message) {
    if (failed || closed) return;
    failed = true;
    clearTimeout(timer);
    const error = new Error(`[card-events] ${message}`);
    settleReady(error);
    rejectDone(error);
    endStdin();
  }

  function stop() {
    if (stopping || closed) return;
    stopping = true;
    clearTimeout(timer);
    settleReady(new Error('[card-events] stopped before ready'));
    endStdin();
  }

  // Never echo arbitrary CLI lines: they may contain callback tokens, user
  // payloads, or credentials. Fixed categories preserve operational signals.
  function diagnostic(level, message) {
    const write = log?.[level] ?? log?.warn ?? console.warn;
    try { write.call(log ?? console, `[card-events] ${message}`); }
    catch { fail('diagnostic logger failed'); }
  }

  function stdoutLine(line) {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); }
    catch { fail('invalid JSON on stdout'); return; }
    if (value && !Array.isArray(value) && value.type === EVENT_KEY) {
      try { onEvent(value); }
      catch { fail('onEvent enqueue failed'); }
    }
  }

  function stderrLine(line) {
    if (!line) return;
    if (line === READY_MARKER) {
      if (!stopping) {
        settleReady();
        diagnostic('info', 'ready');
      }
      return;
    }
    let envelope;
    try { envelope = JSON.parse(line); } catch { /* Non-JSON diagnostics are normal. */ }
    if (envelope?.ok === false) {
      diagnostic('error', 'CLI error diagnostic (details redacted)');
      fail('CLI error diagnostic');
    } else if (/\bdrop(?:ped|ping|s)?\b/i.test(line)) {
      diagnostic('warn', 'WARN: CLI reported event drop (details redacted)');
    } else if (/\bwarn(?:ing)?\b/i.test(line)) {
      diagnostic('warn', 'WARN: CLI diagnostic (details redacted)');
    } else {
      diagnostic('warn', 'CLI stderr diagnostic (details redacted)');
    }
  }

  function consume(stream, name, onLine) {
    const decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0, ended = false;
    function flush() {
      const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      pending = '';
      bytes = 0;
      onLine(line);
    }
    stream.on('data', (chunk) => {
      if (failed || closed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < buffer.length && !failed) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 ? buffer.length : newline;
        bytes += end - start;
        if (bytes > MAX_LINE_BYTES) {
          fail(`${name} line exceeds 256 KiB`);
          return;
        }
        pending += decoder.write(buffer.subarray(start, end));
        if (newline < 0) break;
        // End each record's decoder so incomplete UTF-8 cannot bleed into the
        // next line. StringDecoder is reusable after end().
        pending += decoder.end();
        flush();
        start = newline + 1;
      }
    });
    stream.on('end', () => {
      ended = true;
      if (failed || closed) return;
      pending += decoder.end();
      if (pending) flush();
      if (!stopping) fail(`${name} unexpected EOF`);
    });
    stream.on('error', () => fail(`${name} stream error`));
    stream.on('close', () => {
      if (!ended) fail(`${name} stream closed before EOF`);
    });
  }

  const handle = { ready, done, stop };
  try {
    // shell is necessary for the Windows npm .cmd shim. Every argument is a
    // fixed, safe literal; no tokens, payloads, IDs, or user text enter argv.
    child = spawnImpl('lark-cli', ['event', 'consume', EVENT_KEY, '--as', 'bot'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => fail('child process error'));
    child.on('exit', () => { exited = true; });
    child.on('close', (code, signal) => {
      if (!failed) {
        if (!stopping || code !== 0 || signal) {
          fail(`consumer unexpectedly closed (exit ${Number.isInteger(code) ? code : 'unknown'})`);
        } else {
          resolveDone();
        }
      }
      closed = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
    });
    child.stdin.on('error', () => fail('stdin stream error'));
    child.stdin.on('close', () => {
      if (!stopping && !failed) fail('stdin unexpectedly closed');
    });
    consume(child.stdout, 'stdout', stdoutLine);
    consume(child.stderr, 'stderr', stderrLine);
    timer = setTimeout(() => fail('startup timed out waiting for ready'), startupTimeoutMs);
  } catch {
    fail('could not spawn card event consumer');
  }
  return handle;
}
