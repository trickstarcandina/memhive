import type { Readable } from 'node:stream';

// Room for a large Read or Write result: the adapter cuts every field to 16 000 characters, so what reaches the daemon
// stays small. Past this the event is dropped.
export const STDIN_LIMIT = 16 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 3000;

// Reads at most `limit + 1` bytes (the extra byte tells the caller the input was over the limit); the rest is
// discarded. A host that never closes stdin gets what arrived within `timeoutMs` (then usually invalid JSON, logged).
export function readStdin(
  limit = STDIN_LIMIT,
  input: Readable = process.stdin,
  timeoutMs = STDIN_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    if ((input as { isTTY?: boolean }).isTTY) return resolve('');
    const done = (text: string) => {
      clearTimeout(timer);
      input.removeAllListeners('data');
      resolve(text);
    };
    const timer = setTimeout(() => {
      done(Buffer.concat(chunks).toString('utf8'));
      input.destroy();
    }, timeoutMs);
    timer.unref?.();
    input.on('data', (c: Buffer) => {
      if (size <= limit) {
        const part = c.subarray(0, limit + 1 - size);
        chunks.push(part);
        size += part.length;
      }
    });
    input.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    input.on('error', () => done(''));
  });
}
