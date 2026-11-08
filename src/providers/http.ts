import { ProviderError, type ProviderErrorKind } from './types.js';
import { MAX_RESPONSE_BYTES, readBodyCapped } from '../shared/http.js';

export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status === 402) return 'quota';
  if (status >= 500) return 'transport';
  return 'other';
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'error',
    });
    const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } catch (e) {
    throw new ProviderError(`request failed: ${e instanceof Error ? e.message : String(e)}`, 'transport');
  } finally {
    clearTimeout(t);
  }
}

/** Error-body excerpt for messages; strips the key in case the server echoes it back. */
export function errorDetail(json: any, secret?: string): string {
  let s = JSON.stringify(json?.error ?? json) ?? '';
  if (secret) s = s.split(secret).join('[redacted]');
  return s.slice(0, 300);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
