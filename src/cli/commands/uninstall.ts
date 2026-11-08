import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { isOwnEntry, resolvePaths } from '../../shared/paths.js';
import { codexHooksByMemhive, updateState } from '../../shared/optout.js';
import { uninstallClaudeCode, uninstallCodex, defaultRun, type RunFn } from '../../install/hosts.js';
import { daemonCommand } from './daemon.js';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function uninstallCommand(args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; run?: RunFn; input?: Readable } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env; const run = opts.run ?? defaultRun;
  const { flags } = parseArgs(args, 'uninstall');
  await daemonCommand(['stop'], io, { home });
  for (const l of uninstallClaudeCode(run)) io.stdout(`  claude-code: ${l}\n`);
  for (const l of uninstallCodex(env.CODEX_HOME ?? path.join(homedir(), '.codex'), run, codexHooksByMemhive(home))) io.stdout(`  codex: ${l}\n`);
  rmSync(resolvePaths(home).marketplace, { recursive: true, force: true });   // rendered plugin files only, never memory
  if (existsSync(home)) updateState(home, { codexHooksByMemhive: undefined });
  if (!flags.purge) {
    io.stdout(`Plugin removed. Your data stays in ${home}: memhive.db (your memory), logs, and settings.json and credentials.json, which hold your LLM, embedding and hub API keys.\nTo delete all of it: rm -rf ${shq(home)}   (or: memhive uninstall --purge)\n`);
    return 0;
  }
  if (!existsSync(home)) { io.stdout(`Plugin removed; ${home} does not exist.\n`); return 0; }
  // Never rm -rf a directory memhive does not own: MEMHIVE_HOME may point at $HOME or a shared folder.
  const real = realpathSync(home); const foreign = readdirSync(real).filter((n) => !isOwnEntry(n));
  if (real === path.parse(real).root || real === realpathSync(homedir()) || foreign.length) {
    io.stderr(`memhive uninstall: not deleting ${home}: ${foreign.length ? `it holds files memhive did not create (${foreign.slice(0, 5).join(', ')})` : 'it is not a memhive-only directory'}. Delete what you want by hand.\n`);
    return 1;
  }
  if (flags.yes !== true) {
    io.stdout(`Delete ${home} with your memory and API keys permanently? [y/N] `);
    const rl = createInterface({ input: opts.input ?? process.stdin, terminal: false });
    const answer = await new Promise<string>((r) => { rl.once('line', r); rl.once('close', () => r('')); }); rl.close();   // end of input = no
    if (!/^y(es)?$/i.test(answer.trim())) { io.stderr(`aborted; ${home} is kept\n`); return 1; }
  }
  rmSync(real, { recursive: true, force: true });
  io.stdout(`Deleted ${home}. Rows already pushed to a hub stay there; revoke the hub key there (memhive key revoke <id>).\n`);
  return 0;
}
