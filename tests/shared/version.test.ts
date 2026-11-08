import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/shared/version.js';
import { main } from '../../src/cli/index.js';

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
  it('main --version prints version and returns 0', async () => {
    const out: string[] = [];
    const code = await main(['--version'], { stdout: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toContain(VERSION);
  });
});
