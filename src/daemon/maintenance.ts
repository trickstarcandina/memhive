import type { DaemonContext } from './context.js';

const DAY = 864e5;
export const PROMPTS_PER_SESSION = 5;   // only the latest prompt is ever read; a few more cover a summary retry
export const PROMPT_TTL_DAYS = 7;

/** Periodic housekeeping; every step is best effort so one failure never stops the rest. */
export function runMaintenance(ctx: Pick<DaemonContext, 'store' | 'logger'>, now = Date.now()): void {
  try {
    const n = ctx.store.prunePrompts(PROMPTS_PER_SESSION, new Date(now - PROMPT_TTL_DAYS * DAY).toISOString());
    if (n) ctx.logger.info('prompts pruned', { count: n });
  } catch (e) { ctx.logger.warn('prompt pruning failed', { error: String(e) }); }
}
