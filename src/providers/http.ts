import { ProviderError, type ProviderErrorKind } from './types.js';

export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status === 402) return 'quota';
  if (status >= 500) return 'transport';
  return 'other';
}

export async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json };
  } catch (e) {
    throw new ProviderError(`request failed: ${e instanceof Error ? e.message : String(e)}`, 'transport');
  } finally { clearTimeout(t); }
}

export function joinUrl(base: string, path: string): string { return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''); }
