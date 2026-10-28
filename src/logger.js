import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createLogger({ dir, name = 'app', echo = true }) {
  mkdirSync(dir, { recursive: true });
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
    child: (sub) => createLogger({ dir, name: `${name}:${sub}`, echo }),
  };
}
