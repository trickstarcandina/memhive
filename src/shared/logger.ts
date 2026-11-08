import { appendFileSync, chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureHomeDir, resolvePaths } from './paths.js';

export interface Logger { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void; debug(msg: string, data?: object): void }

const fileSize = (f: string) => { try { return statSync(f).size; } catch { return 0; } };

// Hooks run as many processes: one rotates at a time (exclusive lock file) and re-checks the size under the lock,
// so a second process cannot rename the fresh small log over the rotated one. A lock older than 10 s is a crash leftover.
function rotate(file: string, maxBytes: number): void {
  const lock = `${file}.rotate`;
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { try { if (Date.now() - statSync(lock).mtimeMs > 10000) rmSync(lock, { force: true }); } catch { /* gone */ } return; }
  try { if (fileSize(file) > maxBytes) renameSync(file, `${file}.1`); }
  catch { /* rename refused (Windows EBUSY/EPERM): keep appending to the big file */ }
  finally { rmSync(lock, { force: true }); }
}

export function createLogger(home: string, name: string, env: NodeJS.ProcessEnv = process.env, opts: { maxBytes?: number } = {}): Logger {
  const dir = resolvePaths(home).logs;
  const file = path.join(dir, `${name}.log`);
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const debug = env.MEMHIVE_DEBUG === '1' || env.MEMHIVE_DEBUG === 'true';
  let dirReady = false;
  const write = (level: string, msg: string, data?: object) => {
    try {
      if (!dirReady) {
        ensureHomeDir(dir); dirReady = true;
        for (const f of [file, `${file}.1`]) try { chmodSync(f, 0o600); } catch { /* not there yet */ }   // logs made by older builds were 0644
      }
      if (fileSize(file) > maxBytes) rotate(file, maxBytes);
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
