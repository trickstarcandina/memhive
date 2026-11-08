import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolvePaths } from './paths.js';
import { safeJsonParse } from './json.js';

export interface LlmSettings { provider: 'anthropic' | 'openai-compat'; model: string; baseUrl?: string; apiKey?: string }
export interface EmbedSettings { baseUrl: string; apiKey?: string; model: string; dims: number }
export interface Settings { llm: LlmSettings; embed: EmbedSettings | null; contextTokens: number }

export const DEFAULT_SETTINGS: Settings = {
  llm: { provider: 'anthropic', model: 'claude-haiku-5-5' },
  embed: null,
  contextTokens: 2000,
};

export function loadSettings(home: string, env: NodeJS.ProcessEnv = process.env): Settings {
  const p = resolvePaths(home);
  const file = existsSync(p.settings) ? (safeJsonParse(readFileSync(p.settings, 'utf8')) as Partial<Settings> | undefined) ?? {} : {};
  const llm: LlmSettings = { ...DEFAULT_SETTINGS.llm, ...(file.llm ?? {}) };
  if (env.MEMHUB_LLM_PROVIDER === 'anthropic' || env.MEMHUB_LLM_PROVIDER === 'openai-compat') llm.provider = env.MEMHUB_LLM_PROVIDER;
  if (llm.provider === 'anthropic') {
    if (env.MEMHUB_ANTHROPIC_API_KEY) llm.apiKey = env.MEMHUB_ANTHROPIC_API_KEY;
    if (env.MEMHUB_ANTHROPIC_MODEL) llm.model = env.MEMHUB_ANTHROPIC_MODEL;
  } else {
    if (env.MEMHUB_LLM_BASE_URL) llm.baseUrl = env.MEMHUB_LLM_BASE_URL;
    if (env.MEMHUB_LLM_API_KEY) llm.apiKey = env.MEMHUB_LLM_API_KEY;
    if (env.MEMHUB_LLM_MODEL) llm.model = env.MEMHUB_LLM_MODEL;
  }
  let embed: EmbedSettings | null = file.embed ?? null;
  if (env.MEMHUB_EMBED_BASE_URL || env.MEMHUB_EMBED_MODEL || env.MEMHUB_EMBED_DIMS) {
    embed = {
      baseUrl: env.MEMHUB_EMBED_BASE_URL ?? embed?.baseUrl ?? '',
      apiKey: env.MEMHUB_EMBED_API_KEY ?? embed?.apiKey,
      model: env.MEMHUB_EMBED_MODEL ?? embed?.model ?? '',
      dims: Number(env.MEMHUB_EMBED_DIMS ?? embed?.dims ?? 0),
    };
  }
  const contextTokens = Number(env.MEMHUB_CONTEXT_TOKENS ?? file.contextTokens ?? DEFAULT_SETTINGS.contextTokens);
  return { llm, embed, contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_SETTINGS.contextTokens };
}

export function saveSettings(home: string, settings: Settings): void {
  const p = resolvePaths(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(p.settings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}
