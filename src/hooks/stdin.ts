export const STDIN_LIMIT = 2 * 1024 * 1024;

// Reads at most `limit` bytes; the rest is discarded (the truncated JSON then fails to parse and is logged by the caller).
export function readStdin(limit = STDIN_LIMIT): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let size = 0;
    if (process.stdin.isTTY) return resolve('');
    process.stdin.on('data', (c: Buffer) => { if (size < limit) { chunks.push(c.subarray(0, limit - size)); size += c.length; } });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}
