import type { Settings } from '../shared/settings.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { OpenAICompatEmbedder } from './embedder.js';
import { ProviderError, type Embedder, type LlmProvider } from './types.js';

export function createProvider(s: Settings, fetchImpl?: typeof fetch): LlmProvider {
  if (s.llm.provider === 'anthropic') {
    if (!s.llm.apiKey) throw new ProviderError('MEMHIVE_ANTHROPIC_API_KEY not set', 'auth');
    return new AnthropicProvider({ apiKey: s.llm.apiKey, model: s.llm.model, fetch: fetchImpl });
  }
  if (!s.llm.baseUrl) throw new ProviderError('MEMHIVE_LLM_BASE_URL not set', 'other');
  return new OpenAICompatProvider({
    baseUrl: s.llm.baseUrl,
    apiKey: s.llm.apiKey,
    model: s.llm.model,
    fetch: fetchImpl,
  });
}

export function createEmbedder(s: Settings, fetchImpl?: typeof fetch): Embedder | null {
  if (!s.embed || !s.embed.baseUrl || !s.embed.model || !s.embed.dims) return null;
  return new OpenAICompatEmbedder({
    baseUrl: s.embed.baseUrl,
    apiKey: s.embed.apiKey,
    model: s.embed.model,
    dims: s.embed.dims,
    fetch: fetchImpl,
  });
}
