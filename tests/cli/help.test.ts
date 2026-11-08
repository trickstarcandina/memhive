import { it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/index.js';

for (const cmd of ['install', 'uninstall', 'daemon', 'search', 'forget', 'embed', 'doctor', 'hook', 'mcp']) {
  for (const flag of ['--help', '-h']) {
    it(`${cmd} ${flag} prints usage and has no side effects`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'mh-help-'));
      const prev = process.env.MEMHIVE_HOME; process.env.MEMHIVE_HOME = home;
      let out = ''; let err = '';
      try { expect(await main([cmd, flag], { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } })).toBe(0); }
      finally { if (prev === undefined) delete process.env.MEMHIVE_HOME; else process.env.MEMHIVE_HOME = prev; }
      expect(out).toContain(`memhive ${cmd}`);
      expect(err).toBe('');
      expect(readdirSync(home)).toEqual([]);
    });
  }
}
