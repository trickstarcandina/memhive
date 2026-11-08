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

declare const __dirname: string;

/** The bundle lives at <package>/dist/memhub.cjs; templates at <package>/plugin and <package>/plugin-marketplace. */
export function packageRoot(): string { return path.resolve(typeof __dirname === 'string' ? __dirname : path.dirname(process.argv[1]), '..'); }
// In the CJS bundle __dirname is <package>/dist. process.argv[1] may be the global bin symlink, so it is only a fallback.

export async function installCommand(args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; run?: RunFn } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env; const run = opts.run ?? defaultRun;
  const { flags } = parseArgs(args);
  const root = packageRoot();
  const bundle = path.join(root, 'dist', 'memhub.cjs');
  if (!existsSync(bundle)) { io.stderr(`memhub: bundle not found at ${bundle}. Install with: npm install -g memhub\n`); return 1; }
  if (/[\\/]_npx[\\/]/.test(root)) { io.stderr('memhub: running from the npx cache. Install permanently first:\n  npm install -g memhub && memhub install\n'); return 1; }

  const rl = flags.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) => (rl ? (await rl.question(`${q} [${def}]: `)).trim() || def : def);

  const detected = detectHosts(env);
  const hostFlag = typeof flags.host === 'string' ? flags.host : await ask(`Install for which hosts? (claude-code,codex)`, [detected.claudeCode && 'claude-code', detected.codex && 'codex'].filter(Boolean).join(',') || 'claude-code');
  const hosts = new Set(hostFlag.split(',').map((s) => s.trim()));

  const current = loadSettings(home, env);
  const providerFlag = typeof flags.provider === 'string' ? flags.provider : await ask('Observer provider (anthropic | openai-compat)', current.llm.provider);
  const settings: Settings = { ...DEFAULT_SETTINGS, ...current };
  if (providerFlag === 'openai-compat') {
    settings.llm = { provider: 'openai-compat', baseUrl: await ask('LLM base URL (OpenAI-compatible, e.g. http://localhost:11434/v1)', current.llm.baseUrl ?? 'http://localhost:11434/v1'), model: await ask('LLM model', current.llm.provider === 'openai-compat' ? current.llm.model : 'qwen2.5:7b'), apiKey: (await ask('LLM API key (empty if none)', current.llm.apiKey ?? '')) || undefined };
  } else {
    settings.llm = { provider: 'anthropic', model: await ask('Anthropic model', current.llm.provider === 'anthropic' ? current.llm.model : DEFAULT_SETTINGS.llm.model), apiKey: (await ask('Anthropic API key', current.llm.apiKey ?? env.ANTHROPIC_API_KEY ?? '')) || undefined };
  }
  const embedUrl = await ask('Embeddings base URL (empty = keyword search only)', current.embed?.baseUrl ?? '');
  settings.embed = embedUrl ? { baseUrl: embedUrl, model: await ask('Embedding model', current.embed?.model ?? 'bge-m3'), dims: Number(await ask('Embedding dims', String(current.embed?.dims ?? 1024))), apiKey: (await ask('Embedding API key (empty if none)', current.embed?.apiKey ?? '')) || undefined } : null;
  rl?.close();
  saveSettings(home, settings);
  io.stdout(`settings written to ${resolvePaths(home).settings}\n`);

  const marketplaceRoot = resolvePaths(home).marketplace;
  renderPluginDir({ templateRoot: root, marketplaceRoot, nodePath: process.execPath, bundlePath: bundle, version: VERSION });
  io.stdout(`plugin files rendered to ${marketplaceRoot}\n`);

  if (hosts.has('claude-code')) for (const l of installClaudeCode(marketplaceRoot, run)) io.stdout(`  claude-code: ${l}\n`);
  if (hosts.has('codex')) for (const l of installCodex(marketplaceRoot, env.CODEX_HOME ?? path.join(homedir(), '.codex'), run)) io.stdout(`  codex: ${l}\n`);

  io.stdout('\nChecking setup…\n');
  await doctorCommand([], io, { home, env, ping: !flags['no-ping'] });
  io.stdout('\nDone. Restart your agent; memory appears from your second session in a project.\n');
  return 0;
}
