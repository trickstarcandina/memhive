import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureHomeDir, resolvePaths } from './paths.js';
import { safeJsonParse } from './json.js';
import { OBSERVATION_TYPES, type ObservationType } from '../store/types.js';

export interface LlmSettings { provider: 'anthropic' | 'openai-compat'; model: string; baseUrl?: string; apiKey?: string }
export interface EmbedSettings { baseUrl: string; apiKey?: string; model: string; dims: number }
/** 'mine': only the local user's rows go into the session-start context; 'team' (default): teammates' pulled rows too. */
export interface ContextSettings { scope: 'team' | 'mine' }
export interface Settings {
  llm: LlmSettings; embed: EmbedSettings | null; contextTokens: number; context: ContextSettings;
  /** Project keys or globs (`*` one segment, `**` any) never recorded; also matched against the repo's root path. */
  excludeProjects: string[];
  /** Days to keep observations, per type, else `default`; null keeps forever. Pinned rows are always kept. */
  retentionDays: RetentionDays;
  /** Project keys or globs MCP `search` may read besides the current project (default none). */
  mcp: { allowProjects: string[] };
}
export type RetentionDays = { default: number | null } & Partial<Record<ObservationType, number | null>>;

export const DEFAULT_MODELS: Record<LlmSettings['provider'], string> = { anthropic: 'claude-haiku-5-5', 'openai-compat': 'qwen2.5:7b' };

export const DEFAULT_SETTINGS: Settings = {
  llm: { provider: 'anthropic', model: 'claude-haiku-5-5' },
  embed: null,
  contextTokens: 2000,
  context: { scope: 'team' },
  excludeProjects: [],
  retentionDays: { default: null, discovery: 180 },
  mcp: { allowProjects: [] },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return (typeof v === 'number' || typeof v === 'string') && Number.isInteger(n) && n > 0 ? n : undefined;
};

export function loadSettings(home: string, env: NodeJS.ProcessEnv = process.env): Settings {
  const p = resolvePaths(home);
  const parsed = existsSync(p.settings) ? safeJsonParse(readFileSync(p.settings, 'utf8')) : undefined;
  const file: Partial<Settings> = isObj(parsed) ? (parsed as Partial<Settings>) : {};
  const fl: Partial<LlmSettings> = isObj(file.llm) ? (file.llm as Partial<LlmSettings>) : {};
  const llm: LlmSettings = { ...DEFAULT_SETTINGS.llm, ...fl };
  if (env.MEMHIVE_LLM_PROVIDER === 'anthropic' || env.MEMHIVE_LLM_PROVIDER === 'openai-compat') llm.provider = env.MEMHIVE_LLM_PROVIDER;
  if (llm.provider !== 'anthropic' && llm.provider !== 'openai-compat') llm.provider = DEFAULT_SETTINGS.llm.provider;
  // The file's model belongs to the file's provider; another provider (env switch, or none saved) gets its own default.
  if (!fl.model || (fl.provider ?? DEFAULT_SETTINGS.llm.provider) !== llm.provider) llm.model = DEFAULT_MODELS[llm.provider];
  if (llm.provider === 'anthropic') {
    if (env.MEMHIVE_ANTHROPIC_API_KEY) llm.apiKey = env.MEMHIVE_ANTHROPIC_API_KEY;
    if (env.MEMHIVE_ANTHROPIC_MODEL) llm.model = env.MEMHIVE_ANTHROPIC_MODEL;
  } else {
    if (env.MEMHIVE_LLM_BASE_URL) llm.baseUrl = env.MEMHIVE_LLM_BASE_URL;
    if (env.MEMHIVE_LLM_API_KEY) llm.apiKey = env.MEMHIVE_LLM_API_KEY;
    if (env.MEMHIVE_LLM_MODEL) llm.model = env.MEMHIVE_LLM_MODEL;
  }
  const fe: Partial<EmbedSettings> = isObj(file.embed) ? (file.embed as Partial<EmbedSettings>) : {};
  // An empty env url/model wins (that disables embeddings); a config missing url, model or a positive dims is none.
  const dims = posInt(env.MEMHIVE_EMBED_DIMS) ?? posInt(fe.dims);
  const baseUrl = env.MEMHIVE_EMBED_BASE_URL ?? fe.baseUrl ?? '';
  const model = env.MEMHIVE_EMBED_MODEL ?? fe.model ?? '';
  const embed: EmbedSettings | null = dims === undefined || typeof baseUrl !== 'string' || !baseUrl || typeof model !== 'string' || !model ? null
    : { baseUrl, apiKey: env.MEMHIVE_EMBED_API_KEY ?? fe.apiKey, model, dims };
  const contextTokens = Number(env.MEMHIVE_CONTEXT_TOKENS ?? file.contextTokens ?? DEFAULT_SETTINGS.contextTokens);
  const fc = isObj(file.context) ? (file.context as Record<string, unknown>) : {};
  const isScope = (v: unknown): v is ContextSettings['scope'] => v === 'team' || v === 'mine';
  // Deprecated alias from 0.2 pre-releases: includeOtherUsers (MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS); false means scope 'mine'.
  const envOthers = env.MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS;
  const scope: ContextSettings['scope'] = isScope(env.MEMHIVE_CONTEXT_SCOPE) ? env.MEMHIVE_CONTEXT_SCOPE
    : envOthers !== undefined && envOthers !== '' ? (['0', 'false', 'no', 'off'].includes(envOthers.toLowerCase()) ? 'mine' : 'team')
    : isScope(fc.scope) ? fc.scope : fc.includeOtherUsers === false ? 'mine' : 'team';
  const list = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : undefined;
  const excludeProjects = env.MEMHIVE_EXCLUDE_PROJECTS !== undefined ? env.MEMHIVE_EXCLUDE_PROJECTS.split(',').map((x) => x.trim()).filter(Boolean) : list(file.excludeProjects) ?? [];
  const fr = isObj(file.retentionDays) ? (file.retentionDays as Record<string, unknown>) : {};
  const days = (v: unknown): number | null | undefined => (v === null ? null : posInt(v));
  const retentionDays: RetentionDays = { ...DEFAULT_SETTINGS.retentionDays };
  for (const k of ['default', ...OBSERVATION_TYPES] as const) { const d = days(fr[k]); if (d !== undefined) retentionDays[k] = d; }
  if (env.MEMHIVE_RETENTION_DAYS !== undefined && env.MEMHIVE_RETENTION_DAYS !== '') retentionDays.default = posInt(env.MEMHIVE_RETENTION_DAYS) ?? null;   // 0 or junk: keep forever
  const fm = isObj(file.mcp) ? (file.mcp as Record<string, unknown>) : {};
  const allowProjects = env.MEMHIVE_MCP_ALLOW_PROJECTS !== undefined ? env.MEMHIVE_MCP_ALLOW_PROJECTS.split(',').map((x) => x.trim()).filter(Boolean) : list(fm.allowProjects) ?? [];
  return { llm, embed, contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_SETTINGS.contextTokens, context: { scope }, excludeProjects, retentionDays, mcp: { allowProjects } };
}

export function saveSettings(home: string, settings: Settings): void {
  const p = resolvePaths(home);
  ensureHomeDir(home);
  writeFileSync(p.settings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p.settings, 0o600); // writeFileSync mode applies only on create
}
