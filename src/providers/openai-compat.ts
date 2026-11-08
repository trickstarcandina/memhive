import { ProviderError, type CompleteRequest, type LlmProvider } from './types.js';
import { classifyStatus, errorDetail, joinUrl, postJson } from './http.js';

export class OpenAICompatProvider implements LlmProvider {
  private fetchImpl: typeof fetch; private timeoutMs: number; private jsonMode = true;
  constructor(private opts: { baseUrl: string; apiKey?: string; model: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.fetchImpl = opts.fetch ?? fetch; this.timeoutMs = opts.timeoutMs ?? 60000;
  }
  async complete(req: CompleteRequest): Promise<string> {
    const headers: Record<string, string> = this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
    const body: Record<string, unknown> = { model: this.opts.model, max_tokens: req.maxTokens, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] };
    if (this.jsonMode) body.response_format = { type: 'json_object' };
    let { status, json } = await postJson(this.fetchImpl, joinUrl(this.opts.baseUrl, 'chat/completions'), headers, body, this.timeoutMs);
    if (status === 400 && this.jsonMode) {
      this.jsonMode = false; delete body.response_format;
      ({ status, json } = await postJson(this.fetchImpl, joinUrl(this.opts.baseUrl, 'chat/completions'), headers, body, this.timeoutMs));
    }
    if (status !== 200) throw new ProviderError(`llm ${status}: ${errorDetail(json, this.opts.apiKey)}`, classifyStatus(status), status);
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) throw new ProviderError('llm: empty response', 'bad_response', status);
    return text;
  }
}
