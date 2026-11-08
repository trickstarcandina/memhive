import { createServer, type IncomingMessage, type Server } from 'node:http';

export type Handler = (method: string, url: URL, body: unknown, headers: IncomingMessage['headers']) => Promise<{ status: number; body: unknown }>;

export function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { if (size - c.length <= limit) reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createJsonServer(handler: Handler, authorize: (url: URL, headers: IncomingMessage['headers']) => boolean = () => true, bodyLimit = 2 * 1024 * 1024, unauthorizedMessage = 'bad daemon token'): Server {
  return createServer(async (req, res) => {
    let status = 500; let payload: unknown = { error: { code: 'internal', message: 'internal error' } };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!authorize(url, req.headers)) { res.writeHead(401, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: { code: 'unauthorized', message: unauthorizedMessage } })); return; }
      const raw = req.method === 'POST' ? await readBody(req, bodyLimit) : '';
      let body: unknown = undefined;
      if (raw) { try { body = JSON.parse(raw); } catch { status = 400; payload = { error: { code: 'bad_json', message: 'invalid JSON body' } }; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); return; } }
      ({ status, body: payload } = await handler(req.method ?? 'GET', url, body, req.headers));
    } catch (e) {
      status = e instanceof Error && e.message === 'body too large' ? 413 : 500;
      payload = { error: { code: status === 413 ? 'too_large' : 'internal', message: status === 413 ? 'body too large' : 'internal error' } };
    }
    res.writeHead(status, status === 413 ? { 'content-type': 'application/json', connection: 'close' } : { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload ?? {}), () => { if (status === 413) req.destroy(); });
  });
}
