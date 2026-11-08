import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points TMPDIR/TMP/TEMP at one directory per run before the workers start, so every mkdtempSync(join(tmpdir(), ...))
 * in a test lands there and the whole run is removed at the end, instead of leaving thousands of dirs in /tmp.
 */
export default function setup(): () => Promise<void> {
  const dir = join(tmpdir(), `memhive-vitest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const keys = ['TMPDIR', 'TMP', 'TEMP', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  // Project keys come from `git -C <cwd>`: stop git at the run dir and ignore the machine's git config, so a temp dir
  // inside some repo, or a global safe.directory, cannot change the keys tests see. Fixture repos inside still work.
  process.env.GIT_CEILING_DIRECTORIES = dir;
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // Windows keeps a handle open for a moment after a child exits (EBUSY/EPERM): retry instead of failing the run
    const rm = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try { rm(); } catch { unlock(dir); rm(); }
  };
}

// some tests leave a directory without search permission (a log file path made a 0600 dir); give them back so rm works
function unlock(d: string): void {
  try { chmodSync(d, 0o700); } catch { return; }
  for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(join(d, e.name));
}
