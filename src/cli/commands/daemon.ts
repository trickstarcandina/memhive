import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { readDaemonInfo } from '../../daemon/info.js';
import { DaemonClient } from '../../daemon/client.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { createDaemonContext, startDaemon, DaemonAlreadyRunning } from '../../daemon/server.js';

export async function daemonCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const sub = args[0] ?? 'status';
  if (sub === 'run') {
    let h;
    try { h = await startDaemon(createDaemonContext(home)); }
    catch (e) { if (e instanceof DaemonAlreadyRunning) return 0; throw e; }
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void h.close().catch(() => {}).then(() => process.exit(0)); };   // close() flushes the observer
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    await new Promise(() => {});
    return 0;
  }
  if (sub === 'start') {
    const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
    if (!info) { io.stderr('memhub: daemon failed to start (see logs/daemon.log)\n'); return 1; }
    io.stdout(`memhub daemon running on port ${info.port} (pid ${info.pid})\n`); return 0;
  }
  const info = readDaemonInfo(home);
  const alive = info ? await new DaemonClient(info).health() : false;
  if (sub === 'status') {
    io.stdout(alive ? `memhub daemon running on port ${info!.port} (pid ${info!.pid}, since ${info!.startedAt})\n` : 'memhub daemon not running\n');
    return alive ? 0 : 1;
  }
  if (sub === 'stop') {
    if (!alive) { io.stdout('memhub daemon not running\n'); return 0; }
    await new DaemonClient(info!).request('POST', '/v1/shutdown').catch(() => {});
    io.stdout('memhub daemon stopping\n'); return 0;
  }
  io.stderr(`memhub daemon: unknown subcommand "${sub}" (run|start|stop|status)\n`); return 1;
}
