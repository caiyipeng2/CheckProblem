import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Spec §12: daily files, 14 days kept. The service runs for months, so the
// prune happens once at creation rather than on every write.
const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function pruneOldLogs(dir, now) {
  const cutoff = now - KEEP_DAYS * DAY_MS;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry);
    if (!match) continue;
    const day = Date.parse(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(day) || day >= cutoff) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {
      // A locked file is not worth failing startup over; it will be retried.
    }
  }
}

export function createLogger({ dir, name = 'app', echo = true, now = Date.now() }) {
  mkdirSync(dir, { recursive: true });
  pruneOldLogs(dir, now);

  const write = (level, msg) => {
    const line = `${new Date().toISOString()} [${level}] [${name}] ${msg}`;
    const day = line.slice(0, 10);
    appendFileSync(join(dir, `app-${day}.log`), line + '\n');
    if (echo) console.log(line);
  };

  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    child: (sub) => createLogger({ dir, name: `${name}:${sub}`, echo, now }),
  };
}