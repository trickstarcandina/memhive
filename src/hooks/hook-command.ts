import { getAdapter } from './adapters/index.js';
import { readStdin as defaultReadStdin, STDIN_LIMIT } from './stdin.js';
import { ensureDaemon as defaultEnsureDaemon } from '../daemon/ensure.js';
import { DaemonClient } from '../daemon/client.js';
import { createLogger } from '../shared/logger.js';
import { resolvePaths } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';

export interface HookDeps { readStdin(): Promise<string>; ensureDaemon: typeof defaultEnsureDaemon; fetchImpl: typeof fetch; stdout(s: string): void; home: string; now(): Date }

const EVENT_TIMEOUT_MS = 250;
const START_TIMEOUT_MS = 5000;

export async function runHook(args: string[], deps: Partial<HookDeps> = {}): Promise<number> {
  const d: HookDeps = { readStdin: defaultReadStdin, ensureDaemon: defaultEnsureDaemon, fetchImpl: fetch, stdout: (s) => process.stdout.write(s), home: resolvePaths().home, now: () => new Date(), ...deps };
  const log = createLogger(d.home, 'hook');
  try {
    const [host, hostEvent] = args;
    const adapter = getAdapter(host ?? '');
    if (!adapter) { log.warn('unknown host', { host }); return 0; }
    const raw = await d.readStdin();
    if (!raw.trim()) { log.warn('empty stdin', { host, hostEvent }); return 0; }
    if (raw.length > STDIN_LIMIT) { log.warn('stdin too large', { host, hostEvent, bytes: raw.length }); return 0; }
    const payload = safeJsonParse(raw);
    if (payload === undefined) { log.warn('invalid JSON on stdin', { host, hostEvent, bytes: raw.length }); return 0; }
    const ev = adapter.parse(payload, d.now());
    if (!ev) { log.debug('event ignored', { host, hostEvent }); return 0; }

    if (ev.event === 'session-start') {
      const info = await d.ensureDaemon(d.home, { wait: true, fetchImpl: d.fetchImpl });
      if (!info) { log.error('daemon unavailable for session-start'); return 0; }
      const r = await new DaemonClient(info, d.fetchImpl).request<{ context: string }>('POST', '/v1/sessions/start', ev, START_TIMEOUT_MS);
      if (r.context) d.stdout(adapter.formatContext(ev, r.context));
      return 0;
    }

    const info = await d.ensureDaemon(d.home, { wait: false, fetchImpl: d.fetchImpl });
    if (!info) { log.debug('daemon not ready, event skipped', { event: ev.event }); return 0; }
    await new DaemonClient(info, d.fetchImpl).request('POST', '/v1/events', ev, EVENT_TIMEOUT_MS).catch((e) => log.debug('event delivery failed', { event: ev.event, error: String(e) }));
    return 0;
  } catch (e) {
    log.error('hook failed', { error: e instanceof Error ? e.stack : String(e) });
    return 0;
  }
}
