import { appendFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { ensureHomeDir, resolvePaths } from './paths.js';

export interface Logger { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void; debug(msg: string, data?: object): void }

export function createLogger(home: string, name: string, env: NodeJS.ProcessEnv = process.env, opts: { maxBytes?: number } = {}): Logger {
  const dir = resolvePaths(home).logs;
  const file = path.join(dir, `${name}.log`);
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const debug = env.MEMHUB_DEBUG === '1' || env.MEMHUB_DEBUG === 'true';
  let dirReady = false;
  const write = (level: string, msg: string, data?: object) => {
    try {
      if (!dirReady) { ensureHomeDir(dir); dirReady = true; }
      try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      appendFileSync(file, JSON.stringify({ ...(data ?? {}), t: new Date().toISOString(), level, msg }) + '\n', { mode: 0o600 });   // mode applies on create
    } catch { /* logging must never throw */ }
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    debug: (m, d) => { if (debug) write('debug', m, d); },
  };
}
