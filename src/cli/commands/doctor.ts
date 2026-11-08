import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadSettings } from '../../shared/settings.js';
import { readDaemonInfo } from '../../daemon/info.js';
import { DaemonClient } from '../../daemon/client.js';
import { createEmbedder, createProvider } from '../../providers/factory.js';
import { VERSION } from '../../shared/version.js';

// Never prints secrets: API keys and the daemon token are reported only as set / not set.
export async function doctorCommand(_args: string[], io: CliIo, opts: { home?: string; env?: NodeJS.ProcessEnv; ping?: boolean } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const env = opts.env ?? process.env;
  let problems = 0;
  const line = (ok: boolean, text: string) => { io.stdout(`${ok ? 'ok  ' : 'FAIL'} ${text}\n`); if (!ok) problems++; };
  io.stdout(`memhub ${VERSION} · home ${home}\n`);
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
  const info = readDaemonInfo(home);
  const alive = info ? await new DaemonClient(info).health() : false;
  line(true, alive ? `daemon running on port ${info!.port}` : 'daemon not running (starts on first hook)');
  if (alive) {
    try {
      const st = await new DaemonClient(info!).request<{ observerAuthFailed?: boolean }>('GET', '/v1/status', undefined, 2000);
      line(!st.observerAuthFailed, st.observerAuthFailed ? 'observer: provider rejected the API key (401/403); observations paused until settings.json changes (retried every 15 min)' : 'observer running');
    } catch (e) { line(false, `observer status unavailable: ${e instanceof Error ? e.message : e}`); }
  }
  io.stdout(problems ? `${problems} problem(s) found\n` : 'all good\n');
  return problems ? 1 : 0;
}
