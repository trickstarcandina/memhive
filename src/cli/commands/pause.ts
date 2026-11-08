import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { parseDuration, pausedUntil, writePause } from '../../shared/optout.js';

/** `pause [30m|1h|2d]` (no duration: until `resume`). The daemon picks the change up within 5 s. */
export async function pauseCommand(
  args: string[],
  io: CliIo,
  opts: { home?: string; resume?: boolean } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  if (opts.resume) {
    const was = pausedUntil(home);
    writePause(home, null);
    io.stdout(was === null ? 'memhive was not paused\n' : 'memhive resumed\n');
    return 0;
  }
  const [d] = args;
  const ms = d === undefined ? Infinity : parseDuration(d);
  if (ms === null) {
    io.stderr('usage: memhive pause [duration like 30m, 1h, 2d]\n');
    return 2;
  }
  const until = ms === Infinity ? Infinity : Date.now() + ms;
  writePause(home, until);
  io.stdout(
    until === Infinity
      ? 'memhive paused until `memhive resume`\n'
      : `memhive paused until ${new Date(until).toISOString()}\n`
  );
  return 0;
}
