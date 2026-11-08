import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { createHubStore, ensureAdminKey, hubConfigFromEnv, startHub } from '../../hub/server.js';
import { HubDimsConflict } from '../../hub/store/types.js';
import { createLogger } from '../../shared/logger.js';
import { resolvePaths } from '../../shared/paths.js';

function writeSecret(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a leftover from a crash would make the exclusive create below fail
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' }); // wx: never write through a file or symlink planted at tmp
  renameSync(tmp, file);
}

/** opts.signal stops the hub and returns 0 (tests); without it the hub runs until SIGTERM/SIGINT. */
export async function serveCommand(
  args: string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  opts: { signal?: AbortSignal } = {}
): Promise<number> {
  const { flags } = parseArgs(args, 'serve');
  if (flags['reset-vectors']) env = { ...env, MEMHIVE_RESET_VECTORS: '1' };
  let store: ReturnType<typeof createHubStore>;
  try {
    store = createHubStore(env);
  } catch (e) {
    io.stderr(`memhive serve: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  const cfg = hubConfigFromEnv(env);
  // Migrate before listening: an unreachable DB must fail here, not leave a half-working server.
  try {
    await store.migrate();
  } catch (e) {
    io.stderr(
      e instanceof HubDimsConflict
        ? `memhive serve: ${e.message}\n`
        : `memhive serve: database unreachable or migration failed: ${e instanceof Error ? e.message : e}\n`
    );
    await store.close().catch(() => {});
    return 1;
  }
  // The first admin key goes to a 0600 file, not stdout: container logs keep stdout on the host for anyone in the docker group.
  const keyFile = env.MEMHIVE_ADMIN_KEY_FILE || path.join(resolvePaths(env.MEMHIVE_HOME).home, 'hub-admin-key');
  let admin: Awaited<ReturnType<typeof ensureAdminKey>>;
  try {
    admin = await ensureAdminKey(store, (raw) => writeSecret(keyFile, raw + '\n'));
  } catch (e) {
    io.stderr(`memhive serve: cannot write the admin key to ${keyFile}: ${e instanceof Error ? e.message : e}\n`);
    await store.close().catch(() => {});
    return 1;
  }
  if (admin) {
    io.stdout(
      `First start: created user "admin". Its API key is in ${keyFile} (mode 0600).\n  Read it once, create personal keys with "memhive key create", then revoke this one ("memhive key list" shows its id) and delete the file.\n`
    );
    if (env.MEMHIVE_PRINT_ADMIN_KEY === '1') io.stdout(`  ${admin}\n`);
  }
  let hub: Awaited<ReturnType<typeof startHub>>;
  try {
    hub = await startHub(store, cfg, createLogger(resolvePaths(env.MEMHIVE_HOME).home, 'hub', env));
  } catch (e) {
    io.stderr(`memhive serve: cannot listen on :${cfg.port}: ${e instanceof Error ? e.message : e}\n`);
    await store.close().catch(() => {});
    return 1;
  }
  io.stdout(
    `memhive hub listening on ${hub.host}:${hub.port} (embedding ${cfg.embeddingModel ?? 'none'}${cfg.embeddingDims ? `/${cfg.embeddingDims}` : ''})\n`
  );
  if (opts.signal) {
    const signal = opts.signal;
    await new Promise<void>((r) =>
      signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })
    );
    await hub.close();
    return 0;
  }
  const stop = () => void hub.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise(() => {});
  return 0;
}
