import { getAdapter } from './adapters/index.js';
import { readStdin as defaultReadStdin, STDIN_LIMIT } from './stdin.js';
import { ensureDaemon as defaultEnsureDaemon } from '../daemon/ensure.js';
import { DaemonClient } from '../daemon/client.js';
import { createLogger } from '../shared/logger.js';
import { resolvePaths, setHomeWarningSink } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';
import { envDisabled } from '../shared/optout.js';

export interface HookDeps {
  readStdin(): Promise<string>;
  ensureDaemon: typeof defaultEnsureDaemon;
  fetchImpl: typeof fetch;
  stdout(s: string): void;
  home: string;
  now(): Date;
  env: NodeJS.ProcessEnv;
}

const EVENT_TIMEOUT_MS = 250;
const START_TIMEOUT_MS = 5000;

export async function runHook(args: string[], deps: Partial<HookDeps> = {}): Promise<number> {
  if (envDisabled(deps.env ?? process.env)) return 0; // opted out: no stdin read, no log file, no daemon
  const d: HookDeps = {
    readStdin: defaultReadStdin,
    ensureDaemon: defaultEnsureDaemon,
    fetchImpl: fetch,
    stdout: (s) => process.stdout.write(s),
    home: resolvePaths().home,
    now: () => new Date(),
    env: process.env,
    ...deps,
  };
  const log = createLogger(d.home, 'hook');
  setHomeWarningSink((m) => log.warn(m.trim())); // spec: a hook never writes to stderr
  try {
    const [host, hostEvent] = args;
    const adapter = getAdapter(host ?? '');
    if (!adapter) {
      log.warn('unknown host', { host });
      return 0;
    }
    const raw = await d.readStdin();
    if (!raw.trim()) {
      log.warn('empty stdin', { host, hostEvent });
      return 0;
    }
    // Accepted deviation from spec 5: an event over 2 MB is dropped, not trimmed (the cut JSON cannot be parsed).
    if (Buffer.byteLength(raw) > STDIN_LIMIT) {
      log.warn('stdin too large', { host, hostEvent, bytes: Buffer.byteLength(raw) });
      return 0;
    }
    const payload = safeJsonParse(raw);
    if (payload === undefined) {
      log.warn('invalid JSON on stdin', { host, hostEvent, bytes: raw.length });
      return 0;
    }
    const ev = adapter.parse(payload, d.now());
    if (!ev) {
      log.debug('event ignored', { host, hostEvent });
      return 0;
    }

    if (ev.event === 'session-start') {
      const info = await d.ensureDaemon(d.home, { wait: true, fetchImpl: d.fetchImpl });
      if (!info) {
        log.error('daemon unavailable for session-start');
        return 0;
      }
      const r = await new DaemonClient(info, d.fetchImpl).request<{ context: string }>(
        'POST',
        '/v1/sessions/start',
        ev,
        START_TIMEOUT_MS
      );
      if (r.context) d.stdout(adapter.formatContext(ev, r.context));
      return 0;
    }

    const info = await d.ensureDaemon(d.home, { wait: false, fetchImpl: d.fetchImpl });
    if (!info) {
      log.debug('daemon not ready, event skipped', { event: ev.event });
      return 0;
    }
    await new DaemonClient(info, d.fetchImpl)
      .request('POST', '/v1/events', ev, EVENT_TIMEOUT_MS)
      .catch((e) => log.debug('event delivery failed', { event: ev.event, error: String(e) }));
    return 0;
  } catch (e) {
    log.error('hook failed', { error: e instanceof Error ? e.stack : String(e) });
    return 0;
  }
}
