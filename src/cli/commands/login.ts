import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadSettings } from '../../shared/settings.js';
import { loadCredentials, normalizeHubUrl, saveCredentials } from '../../sync/credentials.js';
import { HubClient } from '../../sync/client.js';
import { daemonCommand } from './daemon.js';

class Cancelled extends Error {}

async function readStdin(): Promise<string> {
  let s = ''; process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

// Prompt with echo muted so the key never reaches the terminal scrollback.
async function promptKey(): Promise<string> {
  process.stderr.write('API key: ');
  const rl = createInterface({ input: process.stdin, output: new Writable({ write(_c, _e, cb) { cb(); } }), terminal: true });
  try {
    return (await new Promise<string>((resolve, reject) => { rl.on('SIGINT', () => reject(new Cancelled())); rl.question('').then(resolve, reject); })).trim();
  } finally { rl.close(); process.stderr.write('\n'); }
}

export async function loginCommand(args: string[], io: CliIo, opts: { home?: string; readKey?: () => Promise<string> } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const { positional, flags } = parseArgs(args, 'login');
  if (!positional[0]) { io.stderr('usage: memhive login <hub-url> [--key-stdin]\n'); return 2; }
  let hubUrl: string; try { hubUrl = normalizeHubUrl(positional[0]); } catch (e) { io.stderr(`memhive login: ${e instanceof Error ? e.message : e}\n`); return 1; }
  let key: string;
  try { key = opts.readKey ? await opts.readKey() : flags['key-stdin'] || !process.stdin.isTTY ? await readStdin() : await promptKey(); }
  catch (e) { if (e instanceof Cancelled) { io.stderr('memhive login: cancelled\n'); return 130; } throw e; }
  if (!key) { io.stderr('memhive login: no API key given\n'); return 1; }
  const client = new HubClient(hubUrl, key);
  try {
    const me = await client.me();
    const c = loadCredentials(home); c.hubs[hubUrl] = { key, user: me.user }; saveCredentials(home, c);   // fresh entry also clears authFailed
    io.stdout(`logged in to ${hubUrl} as ${me.user}\n`);
    let cfg: Awaited<ReturnType<HubClient['config']>> | null = null;
    try { cfg = await client.config(); } catch (e) { io.stdout(`warning: could not read hub config (${e instanceof Error ? e.message : e}); embedder compatibility not checked\n`); }
    const local = loadSettings(home).embed;
    if (cfg?.embedding_model && (!local || local.model !== cfg.embedding_model || local.dims !== cfg.embedding_dims)) io.stdout(`warning: hub embeds with ${cfg.embedding_model}/${cfg.embedding_dims}; your settings use ${local ? `${local.model}/${local.dims}` : 'no embedder'}. Your vectors will be pushed without embeddings until they match.\n`);
    await daemonCommand(['stop'], { stdout: () => {}, stderr: () => {} }, { home });   // restart picks up the new user id
    return 0;
  } catch (e) { io.stderr(`memhive login failed: ${e instanceof Error ? e.message : e}\n`); return 1; }
}
