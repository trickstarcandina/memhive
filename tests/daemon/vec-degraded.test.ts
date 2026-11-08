import { it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('sqlite-vec', () => ({ load: () => { throw new Error('no extension'); } }));
const { createDaemonContext } = await import('../../src/daemon/server.js');

it('does not call the embedder while sqlite-vec is degraded', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  const ctx = createDaemonContext(home, { MEMHUB_EMBED_BASE_URL: 'http://127.0.0.1:9', MEMHUB_EMBED_MODEL: 'm', MEMHUB_EMBED_DIMS: '4' });
  try { expect(ctx.embedder).toBeNull(); } finally { ctx.store.close(); }
});
