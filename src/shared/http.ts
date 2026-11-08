/** A response body over the caller's cap; the stream is cancelled, so a hostile server cannot fill memory. */
export class ResponseTooLarge extends Error {
  constructor() {
    super('response_too_large');
    this.name = 'ResponseTooLarge';
  }
}

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
