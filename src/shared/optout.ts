import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureHomeDir, resolvePaths } from './paths.js';
import { safeJsonParse } from './json.js';
import { writeFileAtomic } from './fs.js';

const TRUTHY = ['1', 'true', 'yes', 'on'];
/** MEMHIVE_DISABLED=1: hooks exit at once, MCP tools answer "memhive disabled", the daemon records nothing. */
export const envDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  TRUTHY.includes((env.MEMHIVE_DISABLED ?? '').trim().toLowerCase());

/** `*` matches inside one `/` segment, `**` across segments; everything else is literal. */
export function globMatch(pattern: string, subject: string): boolean {
  // Windows paths use `\`; patterns are written with `/`, so compare both with `/`.
  const s = subject.replace(/\\/g, '/');
  const re = pattern
    .replace(/\\/g, '/')
    .split(/(\*\*|\*)/)
    .map((p) => (p === '**' ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`, 's').test(s);
}
export const matchesAny = (patterns: readonly string[], ...subjects: Array<string | null | undefined>): boolean =>
  patterns.some((p) => subjects.some((s) => typeof s === 'string' && globMatch(p, s)));

/** `.memhive.json` in a repo directory. It is committed with the repo, so it is untrusted input. */
export interface RepoConfig {
  disabled?: boolean;
  project?: string;
}
export function readRepoConfig(dir: string): RepoConfig {
  let j: unknown;
  try {
    j = safeJsonParse(readFileSync(path.join(dir, '.memhive.json'), 'utf8'));
  } catch {
    return {};
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const o = j as Record<string, unknown>;
  const out: RepoConfig = {};
  if (o.disabled === true) out.disabled = true;
  if (typeof o.project === 'string' && o.project.trim() && o.project.length <= 1000 && !/\s/.test(o.project.trim()))
    out.project = o.project.trim();
  return out;
}

/** "30m", "1h", "2d" -> ms; anything else -> null. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(s.trim());
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * (m[2] === 'd' ? 864e5 : m[2] === 'h' ? 36e5 : 6e4);
}

// state.json holds runtime state the CLI writes for the daemon (pause), kept out of settings.json on purpose.
// codexHooksByMemhive: install turned on Codex's [features] hooks (true), found it on (false); absent: unknown (0.1 install).
interface State {
  pausedUntil?: string;
  codexHooksByMemhive?: boolean;
}
const INDEFINITE = 'indefinite';
function readState(home: string): State {
  const p = resolvePaths(home).state;
  const j = existsSync(p) ? safeJsonParse(readFileSync(p, 'utf8')) : undefined;
  return j && typeof j === 'object' && !Array.isArray(j) ? (j as State) : {};
}
/** Epoch ms the pause ends (Infinity: until resume), or null when not paused. */
export function pausedUntil(home: string, now = Date.now()): number | null {
  let v: unknown;
  try {
    v = readState(home).pausedUntil;
  } catch {
    return null;
  }
  if (v === INDEFINITE) return Infinity;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > now ? t : null;
}
export function writePause(home: string, until: number | null): void {
  updateState(home, {
    pausedUntil: until === null ? undefined : until === Infinity ? INDEFINITE : new Date(until).toISOString(),
  });
}
/** Codex hooks ownership recorded at install; undefined when unknown. */
export function codexHooksByMemhive(home: string): boolean | undefined {
  try {
    const v = readState(home).codexHooksByMemhive;
    return typeof v === 'boolean' ? v : undefined;
  } catch {
    return undefined;
  }
}
/** Merges patch into state.json; an undefined value removes the key. */
export function updateState(home: string, patch: Partial<State>): void {
  ensureHomeDir(home);
  let st: State = {};
  try {
    st = readState(home);
  } catch {
    /* unreadable: start fresh */
  }
  st = { ...st, ...patch };
  for (const k of Object.keys(st) as Array<keyof State>) if (st[k] === undefined) delete st[k];
  writeFileAtomic(resolvePaths(home).state, JSON.stringify(st, null, 2) + '\n', 0o600);
}
/** Re-reads state.json at most once per ttl: every hook event asks, the file is read every few seconds. */
export function pauseReader(home: string, ttlMs = 5000): () => number | null {
  let at = -Infinity;
  let cached: number | null = null;
  return () => {
    const now = Date.now();
    if (now - at >= ttlMs) {
      cached = pausedUntil(home, now);
      at = now;
    }
    return cached !== null && cached > now ? cached : null;
  };
}
