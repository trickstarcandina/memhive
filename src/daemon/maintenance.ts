import type { DaemonContext } from './context.js';
import { OBSERVATION_TYPES, type ObservationType } from '../store/types.js';

const DAY = 864e5;
export const PROMPTS_PER_SESSION = 5; // only the latest prompt is ever read; a few more cover a summary retry
export const PROMPT_TTL_DAYS = 7;

/** Periodic housekeeping; every step is best effort so one failure never stops the rest. */
export function runMaintenance(
  ctx: Pick<DaemonContext, 'store' | 'logger'> & { settings?: Pick<DaemonContext['settings'], 'retentionDays'> },
  now = Date.now()
): void {
  try {
    const n = ctx.store.prunePrompts(PROMPTS_PER_SESSION, new Date(now - PROMPT_TTL_DAYS * DAY).toISOString());
    if (n) ctx.logger.info('prompts pruned', { count: n });
  } catch (e) {
    ctx.logger.warn('prompt pruning failed', { error: String(e) });
  }
  const r = ctx.settings?.retentionDays;
  if (r) {
    try {
      const cutoffs: Partial<Record<ObservationType, string>> = {};
      for (const t of OBSERVATION_TYPES) {
        const d = r[t] !== undefined ? r[t] : r.default;
        if (d) cutoffs[t] = new Date(now - d * DAY).toISOString();
      }
      const n = ctx.store.deleteExpired(cutoffs);
      if (n) ctx.logger.info('observations expired by retentionDays', { count: n });
    } catch (e) {
      ctx.logger.warn('retention failed', { error: String(e) });
    }
  }
}
