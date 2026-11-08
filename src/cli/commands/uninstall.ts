import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { uninstallClaudeCode, uninstallCodex, defaultRun, type RunFn } from '../../install/hosts.js';
import { daemonCommand } from './daemon.js';

export async function uninstallCommand(_args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; run?: RunFn } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env; const run = opts.run ?? defaultRun;
  await daemonCommand(['stop'], io, { home });
  for (const l of uninstallClaudeCode(run)) io.stdout(`  claude-code: ${l}\n`);
  for (const l of uninstallCodex(env.CODEX_HOME ?? path.join(homedir(), '.codex'), run)) io.stdout(`  codex: ${l}\n`);
  rmSync(resolvePaths(home).marketplace, { recursive: true, force: true });   // rendered plugin files only, never memory
  io.stdout(`Plugin removed. Your memory stays in ${home}; delete that folder to remove it.\n`);
  return 0;
}
