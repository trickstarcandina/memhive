import type { CliIo } from '../index.js';
import { createHubStore, ensureAdminKey, hubConfigFromEnv, startHub } from '../../hub/server.js';
import { createLogger } from '../../shared/logger.js';
import { resolvePaths } from '../../shared/paths.js';

export async function serveCommand(_args: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let store; try { store = createHubStore(env); } catch (e) { io.stderr(`memhub serve: ${e instanceof Error ? e.message : e}\n`); return 1; }
  const cfg = hubConfigFromEnv(env);
  // Migrate before listening: an unreachable DB must fail here, not leave a half-working server.
  try { await store.migrate(); } catch (e) { io.stderr(`memhub serve: database unreachable or migration failed: ${e instanceof Error ? e.message : e}\n`); await store.close().catch(() => {}); return 1; }
  const admin = await ensureAdminKey(store);
  if (admin) io.stdout(`First start: created user "admin". API key (shown once):\n  ${admin}\n`);
  let hub; try { hub = await startHub(store, cfg, createLogger(resolvePaths(env.MEMHUB_HOME).home, 'hub', env)); }
  catch (e) { io.stderr(`memhub serve: cannot listen on :${cfg.port}: ${e instanceof Error ? e.message : e}\n`); await store.close().catch(() => {}); return 1; }
  io.stdout(`memhub hub listening on :${hub.port} (embedding ${cfg.embeddingModel ?? 'none'}${cfg.embeddingDims ? `/${cfg.embeddingDims}` : ''})\n`);
  const stop = () => void hub.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  await new Promise(() => {});
  return 0;
}
