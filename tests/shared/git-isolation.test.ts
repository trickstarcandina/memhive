import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectKeyFor } from '../../src/shared/project-key.js';

describe('test-run git isolation', () => {
  it('a temp dir never resolves to a repo above the run dir', () => {
    // a repo around the run dir (as if /tmp lived inside a checkout) must not be seen from a test's temp dir
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(tmpdir());
    const dir = mkdtempSync(path.join(tmpdir(), 'mh-git-'));
    expect(projectKeyFor(dir).key).toMatch(/^path:/);
  });
  it('a fixture repo inside the run dir is still found', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mh-git-')); const sub = path.join(dir, 'a', 'b'); mkdirSync(sub, { recursive: true });
    spawnSync('git', ['init', '-q', dir]); spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/a/iso.git']);
    expect(projectKeyFor(sub).key).toBe('github.com/a/iso');
  });
});
