import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureHomeDir, resolvePaths } from './paths.js';
import { safeJsonParse } from './json.js';

export interface LlmSettings { provider: 'anthropic' | 'openai-compat'; model: string; baseUrl?: string; apiKey?: string }
export interface EmbedSettings { baseUrl: string; apiKey?: string; model: string; dims: number }
export interface Settings { llm: LlmSettings; embed: EmbedSettings | null; contextTokens: number }

export const DEFAULT_SETTINGS: Settings = {
  llm: { provider: 'anthropic', model: 'claude-haiku-5-5' },
  embed: null,
  contextTokens: 2000,
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
  if (env.MEMHUB_LLM_PROVIDER === 'anthropic' || env.MEMHUB_LLM_PROVIDER === 'openai-compat') llm.provider = env.MEMHUB_LLM_PROVIDER;
  if (llm.provider === 'anthropic') {
    if (env.MEMHUB_ANTHROPIC_API_KEY) llm.apiKey = env.MEMHUB_ANTHROPIC_API_KEY;
    if (env.MEMHUB_ANTHROPIC_MODEL) llm.model = env.MEMHUB_ANTHROPIC_MODEL;
  } else {
    if (env.MEMHUB_LLM_BASE_URL) llm.baseUrl = env.MEMHUB_LLM_BASE_URL;
    if (env.MEMHUB_LLM_API_KEY) llm.apiKey = env.MEMHUB_LLM_API_KEY;
    if (env.MEMHUB_LLM_MODEL) llm.model = env.MEMHUB_LLM_MODEL;
  }
  const fe: Partial<EmbedSettings> = isObj(file.embed) ? (file.embed as Partial<EmbedSettings>) : {};
  const dims = posInt(env.MEMHUB_EMBED_DIMS) ?? posInt(fe.dims);
  const embed: EmbedSettings | null = dims === undefined ? null : {
    baseUrl: env.MEMHUB_EMBED_BASE_URL ?? fe.baseUrl ?? '',
    apiKey: env.MEMHUB_EMBED_API_KEY ?? fe.apiKey,
    model: env.MEMHUB_EMBED_MODEL ?? fe.model ?? '',
    dims,
  };
  const contextTokens = Number(env.MEMHUB_CONTEXT_TOKENS ?? file.contextTokens ?? DEFAULT_SETTINGS.contextTokens);
  return { llm, embed, contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_SETTINGS.contextTokens };
}

export function saveSettings(home: string, settings: Settings): void {
  const p = resolvePaths(home);
  ensureHomeDir(home);
  writeFileSync(p.settings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p.settings, 0o600); // writeFileSync mode applies only on create
}
