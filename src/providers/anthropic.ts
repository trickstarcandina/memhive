import { ProviderError, type CompleteRequest, type LlmProvider } from './types.js';
import { classifyStatus, postJson } from './http.js';

export class AnthropicProvider implements LlmProvider {
  private fetchImpl: typeof fetch; private timeoutMs: number;
  constructor(private opts: { apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string }) {
    this.fetchImpl = opts.fetch ?? fetch; this.timeoutMs = opts.timeoutMs ?? 60000;
  }
  async complete(req: CompleteRequest): Promise<string> {
    const { status, json } = await postJson(this.fetchImpl, (this.opts.baseUrl ?? 'https://api.anthropic.com') + '/v1/messages',
      { 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.opts.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] }, this.timeoutMs);
    if (status !== 200) throw new ProviderError(`anthropic ${status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`, classifyStatus(status), status);
    const text = (json?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    if (!text) throw new ProviderError('anthropic: empty response', 'bad_response', status);
    return text;
  }
}
