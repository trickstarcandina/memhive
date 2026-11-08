import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadSettings } from '../../shared/settings.js';
import { readDaemonInfo } from '../../daemon/info.js';
import { DaemonClient } from '../../daemon/client.js';
import { createEmbedder, createProvider } from '../../providers/factory.js';
import { VERSION } from '../../shared/version.js';
import { envDisabled, matchesAny, pausedUntil } from '../../shared/optout.js';
import { projectKeyFor } from '../../shared/project-key.js';

// Never prints secrets: API keys and the daemon token are reported only as set / not set.
export async function doctorCommand(_args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; ping?: boolean; cwd?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env;
  let problems = 0;
  const line = (ok: boolean, text: string) => { io.stdout(`${ok ? 'ok  ' : 'FAIL'} ${text}\n`); if (!ok) problems++; };
  io.stdout(`memhive ${VERSION} · home ${home}\n`);
  let s; try { s = loadSettings(home, env); } catch (e) { line(false, `settings: ${e instanceof Error ? e.message : e}`); io.stdout(`${problems} problem(s) found\n`); return 1; }
  line(true, `provider ${s.llm.provider} model ${s.llm.model}${s.llm.baseUrl ? ` at ${s.llm.baseUrl}` : ''} (api key ${s.llm.apiKey ? 'set' : 'not set'})`);
  if (s.embed) line(true, `embedder ${s.embed.model} (${s.embed.dims} dims) at ${s.embed.baseUrl} (api key ${s.embed.apiKey ? 'set' : 'not set'})`);
  else io.stdout('info embedder: not configured (FTS-only search)\n');
  let provider; try { provider = createProvider(s); line(true, 'provider credentials present'); } catch (e) { line(false, `provider: ${e instanceof Error ? e.message : e}`); }
  if (opts.ping !== false) {
    if (provider) {
      try { const t = await provider.complete({ system: 'Reply with the JSON {"ok":true}', user: 'ping', maxTokens: 20 }); line(t.includes('ok'), `provider ping: ${t.slice(0, 40).replace(/\n/g, ' ')}`); }
      catch (e) { line(false, `provider ping failed: ${e instanceof Error ? e.message : e}`); }
    }
    try {
      const emb = createEmbedder(s);
      if (emb) { const [v] = await emb.embed(['ping']); line(v.length === emb.dims, `embedder ping: ${v.length} dims`); }
    } catch (e) { line(false, `embedder ping failed: ${e instanceof Error ? e.message : e}`); }
  }
  const until = envDisabled(env) ? Infinity : pausedUntil(home);
  if (until !== null) io.stdout(`info capture ${envDisabled(env) ? 'disabled by MEMHIVE_DISABLED' : until === Infinity ? 'paused until `memhive resume`' : `paused until ${new Date(until).toISOString()}`}\n`);
  const here = projectKeyFor(opts.cwd ?? process.cwd());
  if (here.disabled || matchesAny(s.excludeProjects, here.key, here.top)) io.stdout(`info this project (${here.key}) is excluded from capture (${here.disabled ? '.memhive.json' : 'excludeProjects'})\n`);
  const info = readDaemonInfo(home);
  const alive = info ? await new DaemonClient(info).health() : false;
  line(true, alive ? `daemon running on port ${info!.port}` : 'daemon not running (starts on first hook)');
  if (alive) {
    try {
      const st = await new DaemonClient(info!).request<{ observerAuthFailed?: boolean; pushBlocked?: string[]; hubErrors?: Array<{ hub: string; error: string }> }>('GET', '/v1/status', undefined, 2000);
      line(!st.observerAuthFailed, st.observerAuthFailed ? 'observer: provider rejected the API key (401/403); observations paused until settings.json changes (retried every 15 min)' : 'observer running');
      if (st.pushBlocked?.length) line(false, `sync: push to the hub keeps failing with a 404 or a non-hub 4xx for ${st.pushBlocked.length} project(s); check the hub URL and any proxy (see daemon log)`);
      for (const h of st.hubErrors ?? []) line(false, `sync: ${h.hub}: ${h.error}`);
    } catch (e) { line(false, `observer status unavailable: ${e instanceof Error ? e.message : e}`); }
  }
  io.stdout(problems ? `${problems} problem(s) found\n` : 'all good\n');
  return problems ? 1 : 0;
}
