import { createServer } from 'node:net';

/** A loopback port that was free a moment ago and is closed now: connecting fails fast, unlike relying on port 9. */
export async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** A dead LLM/embedding endpoint for test daemons, one per test file. */
export const deadUrl = `http://127.0.0.1:${await closedPort()}`;
