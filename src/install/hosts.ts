import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTomlBoolean } from './toml.js';

export type RunFn = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
export const defaultRun: RunFn = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000 }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }; };

export const PLUGIN_ID = 'memhub@memhub-local';
export const MARKETPLACE_NAME = 'memhub-local';

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

export function installCodex(marketplaceRoot: string, codexHome: string, run: RunFn = defaultRun): string[] {
  const log: string[] = [];
  run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  tryRun(run, 'codex', ['plugin', 'marketplace', 'add', marketplaceRoot], log);
  tryRun(run, 'codex', ['plugin', 'add', PLUGIN_ID], log);
  const cfg = path.join(codexHome, 'config.toml');
  mkdirSync(codexHome, { recursive: true });
  let content = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  content = setTomlBoolean(content, '[features]', 'hooks', true);
  content = setTomlBoolean(content, `[plugins."${PLUGIN_ID}"]`, 'enabled', true);
  writeFileSync(cfg, content);
  log.push(`updated ${cfg}: [features] hooks = true, [plugins."${PLUGIN_ID}"] enabled = true`);
  log.push('Restart Codex and trust the memhub hooks when prompted.');
  return log;
}
export function uninstallCodex(codexHome: string, run: RunFn = defaultRun): string[] {
  const log: string[] = [];
  const cfg = path.join(codexHome, 'config.toml');
  if (existsSync(cfg)) { writeFileSync(cfg, setTomlBoolean(readFileSync(cfg, 'utf8'), `[plugins."${PLUGIN_ID}"]`, 'enabled', false)); log.push(`disabled ${PLUGIN_ID} in ${cfg}`); }
  tryRun(run, 'codex', ['plugin', 'remove', PLUGIN_ID], log);
  tryRun(run, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], log);
  return log;
}
