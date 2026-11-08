import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings.js';
import { VERSION } from '../../shared/version.js';
import { renderPluginDir } from '../../install/plugin-files.js';
import { detectHosts, installClaudeCode, installCodex, defaultRun, type RunFn } from '../../install/hosts.js';
import { doctorCommand } from './doctor.js';
import { daemonCommand } from './daemon.js';

declare const __dirname: string;

/** The bundle lives at <package>/dist/memhive.cjs; templates at <package>/plugin and <package>/plugin-marketplace. */
export function packageRoot(): string { return path.resolve(typeof __dirname === 'string' ? __dirname : path.dirname(process.argv[1]), '..'); }
// In the CJS bundle __dirname is <package>/dist. process.argv[1] may be the global bin symlink, so it is only a fallback.

const validHosts = (v: string) => { const h = v.split(',').map((s) => s.trim()).filter(Boolean); return h.length > 0 && h.every((x) => x === 'claude-code' || x === 'codex'); };

export type AskFn = (question: string, def: string) => Promise<string>;

export async function installCommand(args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; run?: RunFn; root?: string; ask?: AskFn } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env; const run = opts.run ?? defaultRun;
  const { flags } = parseArgs(args, 'install');
  // Flags are checked before any prompt, so a typo never costs a round of questions.
  const badHost = flags.host !== undefined && (typeof flags.host !== 'string' || !validHosts(flags.host));
  if (badHost) { io.stderr(`memhive: unknown --host "${flags.host === true ? '' : flags.host}" (use claude-code, codex or both comma-separated)\n`); return 2; }
  if (flags.provider !== undefined && flags.provider !== 'anthropic' && flags.provider !== 'openai-compat') { io.stderr(`memhive: unknown --provider "${flags.provider === true ? '' : flags.provider}" (use anthropic or openai-compat)\n`); return 2; }
  const root = opts.root ?? packageRoot();
  const bundle = path.join(root, 'dist', 'memhive.cjs');
  if (!existsSync(bundle)) { io.stderr(`memhive: bundle not found at ${bundle}. Install with: npm install -g memhive\n`); return 1; }
  if (/[\\/]_npx[\\/]/.test(root)) { io.stderr('memhive: running from the npx cache. Install permanently first:\n  npm install -g memhive && memhive install\n'); return 1; }

  const rl = flags.yes || opts.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask: AskFn = opts.ask && !flags.yes ? opts.ask : async (q, def) => (rl ? (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def : def);
  // A saved key is never echoed as the default; Enter keeps it.
  const askKey = async (q: string, saved: string | undefined) => (await ask(saved ? `${q} (saved; Enter keeps it)` : `${q} (empty if none)`, '')) || saved || undefined;

  const detected = detectHosts(env);
  const hostFlag = typeof flags.host === 'string' ? flags.host : await ask(`Install for which hosts? (claude-code,codex)`, [detected.claudeCode && 'claude-code', detected.codex && 'codex'].filter(Boolean).join(',') || 'claude-code');
  if (!validHosts(hostFlag)) { rl?.close(); io.stderr(`memhive: unknown --host "${hostFlag}" (use claude-code, codex or both comma-separated)\n`); return 2; }
  const hosts = new Set(hostFlag.split(',').map((s) => s.trim()).filter(Boolean));

  // File values only: env overrides (MEMHIVE_*_API_KEY, MEMHIVE_CONTEXT_TOKENS, ...) must not be copied into settings.json.
  const current = loadSettings(home, {});
  const providerFlag = typeof flags.provider === 'string' ? flags.provider : await ask('Observer provider (anthropic | openai-compat)', current.llm.provider);
  if (providerFlag !== 'anthropic' && providerFlag !== 'openai-compat') { rl?.close(); io.stderr(`memhive: unknown --provider "${providerFlag}" (use anthropic or openai-compat)\n`); return 2; }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...current };
  if (providerFlag === 'openai-compat') {
    settings.llm = { provider: 'openai-compat', baseUrl: await ask('LLM base URL (OpenAI-compatible, e.g. http://localhost:11434/v1)', current.llm.baseUrl ?? 'http://localhost:11434/v1'), model: await ask('LLM model', current.llm.provider === 'openai-compat' ? current.llm.model : 'qwen2.5:7b'), apiKey: await askKey('LLM API key', current.llm.provider === 'openai-compat' ? current.llm.apiKey : undefined) };
  } else {
    settings.llm = { provider: 'anthropic', model: await ask('Anthropic model', current.llm.provider === 'anthropic' ? current.llm.model : DEFAULT_SETTINGS.llm.model), apiKey: await askKey('Anthropic API key', current.llm.provider === 'anthropic' ? current.llm.apiKey : undefined) };
  }
  const embedUrl = await ask('Embeddings base URL (empty = keyword search only)', current.embed?.baseUrl ?? '');
  settings.embed = null;
  if (embedUrl) {
    const model = await ask('Embedding model', current.embed?.model ?? 'bge-m3');
    const dimsText = await ask('Embedding dims', String(current.embed?.dims ?? 1024));
    const dims = Number(dimsText);
    if (!/^\d+$/.test(dimsText.trim()) || !Number.isSafeInteger(dims) || dims < 1) { rl?.close(); io.stderr(`memhive: embedding dims must be a positive integer, got "${dimsText}"\n`); return 2; }
    settings.embed = { baseUrl: embedUrl, model, dims, apiKey: await askKey('Embedding API key', current.embed?.apiKey) };
  }
  rl?.close();
  saveSettings(home, settings);
  io.stdout(`settings written to ${resolvePaths(home).settings}\n`);
  if (settings.llm.provider === 'anthropic' && !settings.llm.apiKey && env.ANTHROPIC_API_KEY && !env.MEMHIVE_ANTHROPIC_API_KEY) {
    io.stdout('note: ANTHROPIC_API_KEY is set but memhive does not read it; export MEMHIVE_ANTHROPIC_API_KEY or run install again and paste the key\n');
  }

  const marketplaceRoot = resolvePaths(home).marketplace;
  renderPluginDir({ templateRoot: root, marketplaceRoot, nodePath: process.execPath, bundlePath: bundle, version: VERSION });
  io.stdout(`plugin files rendered to ${marketplaceRoot}\n`);
  await daemonCommand(['stop'], io, { home });   // a running daemon would keep the old bundle and settings

  if (hosts.has('claude-code')) for (const l of installClaudeCode(marketplaceRoot, run)) io.stdout(`  claude-code: ${l}\n`);
  let codexOk = true;
  if (hosts.has('codex')) { const r = installCodex(marketplaceRoot, env.CODEX_HOME ?? path.join(homedir(), '.codex'), run); codexOk = r.ok; for (const l of r.log) io.stdout(`  codex: ${l}\n`); }

  io.stdout('\nChecking setup…\n');
  await doctorCommand([], io, { home, env, ping: !flags['no-ping'], bundle });
  if (!codexOk) { io.stderr('\nmemhive: Codex setup did not complete; follow the manual steps above.\n'); return 1; }
  io.stdout('\nDone. Restart your agent; memory appears from your second session in a project.\n');
  return 0;
}
