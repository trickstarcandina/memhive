import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { isOurDaemon, readDaemonInfo } from '../../daemon/info.js';
import { DaemonClient } from '../../daemon/client.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { daemonUnavailableMessage } from '../daemon-unavailable.js';
import { createDaemonContext, startDaemon, DaemonAlreadyRunning } from '../../daemon/server.js';
import { DatabaseNewerThanBinary } from '../../store/sqlite/store.js';

export async function daemonCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const sub = args.find((a) => !a.startsWith('--')) ?? 'status';
  if (sub === 'run') {
    let h: Awaited<ReturnType<typeof startDaemon>>;
    try {
      h = await startDaemon(createDaemonContext(home));
    } catch (e) {
      if (e instanceof DaemonAlreadyRunning) return 0;
      if (e instanceof DatabaseNewerThanBinary) {
        io.stderr(`memhive: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void h
        .close()
        .catch(() => {})
        .then(() => process.exit(0));
    }; // close() flushes the observer
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await new Promise(() => {});
    return 0;
  }
  if (sub === 'start') {
    const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
    if (!info) {
      io.stderr(daemonUnavailableMessage(home));
      return 1;
    }
    io.stdout(`memhive daemon running on port ${info.port} (pid ${info.pid})\n`);
    return 0;
  }
  const info = readDaemonInfo(home);
  const alive = info ? await new DaemonClient(info).health() : false;
  if (sub === 'status') {
    if (args.includes('--json')) {
      io.stdout(
        JSON.stringify(
          alive
            ? {
                running: true,
                port: info!.port,
                pid: info!.pid,
                startedAt: info!.startedAt,
                version: info!.version ?? null,
              }
            : { running: false },
          null,
          2
        ) + '\n'
      );
      return alive ? 0 : 1;
    }
    io.stdout(
      alive
        ? `memhive daemon running on port ${info!.port} (pid ${info!.pid}, since ${info!.startedAt})\n`
        : 'memhive daemon not running\n'
    );
    return alive ? 0 : 1;
  }
  if (sub === 'stop') {
    if (!alive) {
      // A daemon from an older build fails the new health proof but still runs: stop it by pid, only when /proc shows it is ours.
      const pid = info?.pid ?? Number(readText(path.join(home, 'daemon.lock')));
      if (pid && pid !== process.pid && isOurDaemon(home, pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          io.stdout(`memhive daemon (pid ${pid}) stopping\n`);
          return 0;
        } catch {
          /* already gone */
        }
      }
      io.stdout('memhive daemon not running\n');
      return 0;
    }
    await new DaemonClient(info!).request('POST', '/v1/shutdown').catch(() => {});
    io.stdout('memhive daemon stopping\n');
    return 0;
  }
  io.stderr(`memhive daemon: unknown subcommand "${sub}" (run|start|stop|status)\n`);
  return 2;
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// shortcut: needs /proc (Linux); elsewhere an old daemon is left to its idle timeout.
