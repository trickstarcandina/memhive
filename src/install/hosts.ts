import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../shared/atomic.js';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { hasTomlTable, setTomlBooleanChecked } from './toml.js';

export type RunFn = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
export const defaultRun: RunFn = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000 }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }; };

export const PLUGIN_ID = 'memhive@memhive-local';
export const MARKETPLACE_NAME = 'memhive-local';

export function detectHosts(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): { claudeCode: boolean; codex: boolean } {
  return { claudeCode: exists(env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')), codex: exists(env.CODEX_HOME ?? path.join(homedir(), '.codex')) };
}

function tryRun(run: RunFn, cmd: string, args: string[], log: string[]): boolean {
  const r = run(cmd, args);
  const ok = !r.error && r.status === 0;
  log.push(`${ok ? 'ran' : 'FAILED'}: ${cmd} ${args.join(' ')}${ok ? '' : ` — ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`}`);
  return ok;
}

export function installClaudeCode(marketplaceRoot: string, run: RunFn = defaultRun): string[] {
  const log: string[] = [];
  run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  if (!tryRun(run, 'claude', ['plugin', 'marketplace', 'add', marketplaceRoot], log) || !tryRun(run, 'claude', ['plugin', 'install', PLUGIN_ID], log)) {
    log.push(`Run inside Claude Code: /plugin marketplace add ${marketplaceRoot}  then  /plugin install ${PLUGIN_ID}`);
  }
  return log;
}
export function uninstallClaudeCode(run: RunFn = defaultRun): string[] {
  const log: string[] = [];
  tryRun(run, 'claude', ['plugin', 'uninstall', PLUGIN_ID], log);
  tryRun(run, 'claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], log);
  return log;
}

/** The host's own config: keep a one-time backup of the user's original, then replace it atomically with its mode kept. */
function writeCodexConfig(link: string, content: string): void {
  let mode: number | undefined;
  const cfg = existsSync(link) ? realpathSync(link) : link;   // a dotfile-managed symlink stays a symlink: write its target
  if (existsSync(cfg)) {
    mode = statSync(cfg).mode & 0o777;
    if (!existsSync(`${cfg}.memhive-bak`)) copyFileSync(cfg, `${cfg}.memhive-bak`);
  }
  writeFileAtomic(cfg, content, mode);
}

/** hooksWereOn: [features] hooks was already true before this install; pluginWasThere: an earlier memhive install had enabled the plugin. */
export function installCodex(marketplaceRoot: string, codexHome: string, run: RunFn = defaultRun): { log: string[]; ok: boolean; hooksWereOn?: boolean; pluginWasThere?: boolean } {
  const log: string[] = [];
  const cfg = path.join(codexHome, 'config.toml');
  const manual = () => log.push(`Do it by hand: codex plugin marketplace add ${marketplaceRoot} ; codex plugin add ${PLUGIN_ID} ; then in ${cfg} set [features] hooks = true and [plugins."${PLUGIN_ID}"] enabled = true`);
  run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  if (!tryRun(run, 'codex', ['plugin', 'marketplace', 'add', marketplaceRoot], log) || !tryRun(run, 'codex', ['plugin', 'add', PLUGIN_ID], log)) { manual(); return { log, ok: false }; }
  let hooksWereOn = false; let pluginWasThere = false;
  try {
    let content = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
    pluginWasThere = hasTomlTable(content, `[plugins."${PLUGIN_ID}"]`);
    try { hooksWereOn = (parse(content) as { features?: { hooks?: unknown } }).features?.hooks === true; } catch { /* setTomlBooleanChecked reports it */ }
    content = setTomlBooleanChecked(content, '[features]', 'hooks', true);
    content = setTomlBooleanChecked(content, `[plugins."${PLUGIN_ID}"]`, 'enabled', true);
    mkdirSync(codexHome, { recursive: true });
    writeCodexConfig(cfg, content);
  } catch (e) {
    log.push(`FAILED to edit ${cfg}: ${(e as Error).message}`); manual(); return { log, ok: false };
  }
  log.push(`updated ${cfg}: [features] hooks = true, [plugins."${PLUGIN_ID}"] enabled = true`);
  log.push('Restart Codex and trust the memhive hooks when prompted.');
  return { log, ok: true, hooksWereOn, pluginWasThere };
}
/** resetHooks: memhive turned [features] hooks on (set it back to false); false: it was on before; undefined: unknown, left alone. */
export function uninstallCodex(codexHome: string, run: RunFn = defaultRun, resetHooks?: boolean): string[] {
  const log: string[] = [];
  const cfg = path.join(codexHome, 'config.toml');
  const header = `[plugins."${PLUGIN_ID}"]`;
  if (existsSync(cfg)) {
    let src = readFileSync(cfg, 'utf8');
    if (hasTomlTable(src, header)) {
      try { src = setTomlBooleanChecked(src, header, 'enabled', false); writeCodexConfig(cfg, src); log.push(`disabled ${PLUGIN_ID} in ${cfg}`); }
      catch (e) { log.push(`FAILED to edit ${cfg}: ${(e as Error).message}; set enabled = false under ${header} by hand`); }
    }
    if (resetHooks === true && hasTomlTable(src, '[features]')) {
      try { writeCodexConfig(cfg, setTomlBooleanChecked(src, '[features]', 'hooks', false)); log.push(`set [features] hooks = false in ${cfg} (memhive had turned it on)`); }
      catch (e) { log.push(`FAILED to reset [features] hooks in ${cfg}: ${(e as Error).message}`); }
    } else if (resetHooks === false) log.push(`left [features] hooks = true in ${cfg}: it was on before memhive`);
    else if (hasTomlTable(src, '[features]')) log.push(`left [features] hooks in ${cfg} as it is: memhive did not record whether it turned it on (installed before 0.2); other plugins may need it`);
  }
  tryRun(run, 'codex', ['plugin', 'remove', PLUGIN_ID], log);
  tryRun(run, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], log);
  return log;
}
