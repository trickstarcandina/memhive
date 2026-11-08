import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from './paths.js';

export interface Logger { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void; debug(msg: string, data?: object): void }

export function createLogger(home: string, name: string, env: NodeJS.ProcessEnv = process.env, opts: { maxBytes?: number } = {}): Logger {
  const dir = resolvePaths(home).logs;
  const file = path.join(dir, `${name}.log`);
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const debug = env.MEMHUB_DEBUG === '1' || env.MEMHUB_DEBUG === 'true';
  const write = (level: string, msg: string, data?: object) => {
    try {
      mkdirSync(dir, { recursive: true });
      try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ?? {}) }) + '\n');
    } catch { /* logging must never throw */ }
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    debug: (m, d) => { if (debug) write('debug', m, d); },
  };
}
