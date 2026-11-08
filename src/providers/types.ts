export interface CompleteRequest { system: string; user: string; maxTokens: number }
export interface LlmProvider { complete(req: CompleteRequest): Promise<string> }
export interface Embedder { readonly model: string; readonly dims: number; embed(texts: string[]): Promise<number[][]> }
export type ProviderErrorKind = 'auth' | 'quota' | 'transport' | 'bad_response' | 'other';
export class ProviderError extends Error {
  constructor(message: string, public readonly kind: ProviderErrorKind, public readonly status: number | null = null) { super(message); this.name = 'ProviderError'; }
}
