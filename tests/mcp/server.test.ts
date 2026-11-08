import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { formatIndex } from '../../src/mcp/format.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
let h: Awaited<ReturnType<typeof startDaemon>>; let client: Client;

beforeAll(async () => {
  h = await startDaemon(createDaemonContext(home, { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' }), { port: 0 });
  const server = createMcpServer({ client: new DaemonClient(h.info), cwd: home });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});
afterAll(async () => { await client.close(); await h.close(); });

const text = (r: any) => r.content[0].text as string;

describe('mcp', () => {
  it('lists the four tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_observations', 'save_memory', 'search', 'timeline']);
  });
  it('save_memory then search, timeline and get_observations round trip', async () => {
    const saved = text(await client.callTool({ name: 'save_memory', arguments: { text: 'Use pnpm, not npm, in this repo', title: 'Package manager' } }));
    expect(saved).toMatch(/#[0-9a-f]{8}/);
    const idx = text(await client.callTool({ name: 'search', arguments: { query: 'pnpm' } }));
    expect(idx).toContain('| ID |'); expect(idx).toContain('Package manager');
    const id8 = idx.match(/#([0-9a-f]{8})/)![1];
    const tl = text(await client.callTool({ name: 'timeline', arguments: { anchor_id: id8 } }));
    expect(tl).toContain('Package manager');
    const full = text(await client.callTool({ name: 'get_observations', arguments: { ids: [id8] } }));
    expect(full).toContain('Use pnpm, not npm');
  });
  it('search with no hits says so', async () => {
    expect(text(await client.callTool({ name: 'search', arguments: { query: 'zzzz-nothing' } }))).toContain('No observations');
  });
  it('index keeps each row on one line', () => {
    const o: any = { id: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001', createdAt: '2026-01-01T10:20:00Z', type: 'decision', title: 'a\nb | c\r\n## x', subtitle: '', narrative: '', facts: [], userId: 'u' };
    expect(formatIndex([o]).split('\n')).toHaveLength(3);
    expect(formatIndex([o])).toContain('#ffff0001');
  });
});
