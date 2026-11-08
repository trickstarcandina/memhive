import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeRemote, projectKeyFor } from '../../src/shared/project-key.js';
import { envDisabled, globMatch, parseDuration } from '../../src/shared/optout.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:kalix-vn/memhive.git', 'github.com/kalix-vn/memhive'],
    ['https://user@github.com/Kalix-VN/MemHive.git/', 'github.com/kalix-vn/memhive'],
    ['ssh://git@gitlab.com:2222/team/app.git', 'gitlab.com/team/app'],
    ['http://10.0.0.5/repo', '10.0.0.5/repo'],
    ['git@host:123/repo.git', 'host/repo'], // kept as before so existing project keys stay stable
    ['host:2222/team/app', 'host/team/app'],
    ['https://host:8443/team/app', 'host/team/app'],
    ['', null],
    ['not a url', null],
  ])('%s -> %s', (input, expected) => expect(normalizeRemote(input)).toBe(expected));
});

describe('projectKeyFor', () => {
  it('uses the git remote when present', () => {
    const r = projectKeyFor('/tmp/x', {
      gitRemote: () => 'git@github.com:a/b.git',
      gitRevParse: () => ({ top: '/tmp/x', branch: 'main' }),
      readRepoConfig: () => ({}),
    });
    expect(r).toEqual({ key: 'github.com/a/b', name: 'b', top: '/tmp/x', branch: 'main', disabled: false });
  });
  it('falls back to a path hash without remote', () => {
    const r = projectKeyFor('/home/me/proj', {
      gitRemote: () => null,
      gitRevParse: () => ({ top: null, branch: null }),
      readRepoConfig: () => ({}),
    });
    expect(r.key).toMatch(/^path:[0-9a-f]{16}$/);
    expect(r.name).toBe('proj');
  });
  it('.memhive.json can narrow the key (monorepo package) and disable capture', () => {
    const deps = (cfg: object) => ({
      gitRemote: () => 'git@github.com:a/mono.git',
      gitRevParse: () => ({ top: '/r', branch: null }),
      readRepoConfig: () => cfg,
    });
    expect(projectKeyFor('/r', deps({ project: 'github.com/a/mono/packages/web' }))).toMatchObject({
      key: 'github.com/a/mono/packages/web',
      name: 'web',
    });
    expect(projectKeyFor('/r', deps({ disabled: true })).disabled).toBe(true);
  });
  it('.memhive.json cannot point the repo at another project key', () => {
    const r = projectKeyFor('/r', {
      gitRemote: () => 'git@github.com:evil/repo.git',
      gitRevParse: () => ({ top: '/r', branch: null }),
      readRepoConfig: () => ({ project: 'github.com/acme/secret' }),
    });
    expect(r.key).toBe('github.com/evil/repo');
  });
  it('reads .memhive.json from the real repo root and the branch with one git call', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mh-pk-'));
    spawnSync('git', ['init', '-q', '-b', 'trunk', dir]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:a/mono.git']);
    writeFileSync(path.join(dir, '.memhive.json'), JSON.stringify({ project: 'github.com/a/mono/svc' }));
    mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    mkdirSync(path.join(dir, 'pkg'));
    writeFileSync(path.join(dir, 'pkg', '.memhive.json'), JSON.stringify({ project: 'github.com/a/mono/pkg' }));
    expect(projectKeyFor(path.join(dir, 'pkg')).key).toBe('github.com/a/mono/pkg'); // nearest file wins
    const r = projectKeyFor(path.join(dir, 'sub', 'deep'));
    expect(r.key).toBe('github.com/a/mono/svc');
    expect(r.branch).toBeNull(); // no commit yet: HEAD does not resolve, the top level still does
    expect(realpathSync(r.top)).toBe(realpathSync(dir));
  });
});

describe('opt-out helpers', () => {
  it('glob: * stays in a segment, ** crosses them, the rest is literal', () => {
    expect(globMatch('github.com/acme/*', 'github.com/acme/app')).toBe(true);
    expect(globMatch('github.com/acme/*', 'github.com/acme/app/x')).toBe(false);
    expect(globMatch('github.com/**', 'github.com/acme/app/x')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(globMatch('exact/key', 'exact/key')).toBe(true);
  });
  it('MEMHIVE_DISABLED and durations', () => {
    expect(envDisabled({ MEMHIVE_DISABLED: '1' })).toBe(true);
    expect(envDisabled({ MEMHIVE_DISABLED: '0' })).toBe(false);
    expect(envDisabled({})).toBe(false);
    expect([
      parseDuration('30m'),
      parseDuration('1h'),
      parseDuration('2d'),
      parseDuration('x'),
      parseDuration('0h'),
    ]).toEqual([18e5, 36e5, 1728e5, null, null]);
  });
});
