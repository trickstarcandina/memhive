import { ProviderError, type Embedder } from './types.js';
import { classifyStatus, joinUrl, postJson } from './http.js';

export class OpenAICompatEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  constructor(
    private opts: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      dims: number;
      fetch?: typeof fetch;
      timeoutMs?: number;
    }
  ) {
    this.model = opts.model;
    this.dims = opts.dims;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
    const { status, json } = await postJson(
      this.fetchImpl,
      joinUrl(this.opts.baseUrl, 'embeddings'),
      headers,
      { model: this.model, input: texts },
      this.timeoutMs
    );
    if (status !== 200) throw new ProviderError(`embed ${status}`, classifyStatus(status), status);
    const data: any[] = Array.isArray(json?.data) ? [...json.data].sort((a, b) => a.index - b.index) : [];
    if (data.length !== texts.length) throw new ProviderError('embed: wrong result count', 'bad_response', status);
    return data.map((d) => {
      if (!Array.isArray(d.embedding) || d.embedding.length !== this.dims)
        throw new ProviderError(
          `embed: expected ${this.dims} dims, got ${d.embedding?.length}`,
          'bad_response',
          status
        );
      return d.embedding as number[];
    });
  }
}
