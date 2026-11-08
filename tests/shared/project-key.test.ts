import { describe, it, expect } from 'vitest';
import { normalizeRemote, projectKeyFor } from '../../src/shared/project-key.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:kalix-vn/memhive.git', 'github.com/kalix-vn/memhive'],
    ['https://user@github.com/Kalix-VN/MemHive.git/', 'github.com/kalix-vn/memhive'],
    ['ssh://git@gitlab.com:2222/team/app.git', 'gitlab.com/team/app'],
    ['http://10.0.0.5/repo', '10.0.0.5/repo'],
    ['git@host:123/repo.git', 'host/repo'],   // kept as before so existing project keys stay stable
    ['host:2222/team/app', 'host/team/app'],
    ['https://host:8443/team/app', 'host/team/app'],
    ['', null],
    ['not a url', null],
  ])('%s -> %s', (input, expected) => expect(normalizeRemote(input)).toBe(expected));
});

describe('projectKeyFor', () => {
  it('uses the git remote when present', () => {
    const r = projectKeyFor('/tmp/x', { gitRemote: () => 'git@github.com:a/b.git', gitTopLevel: () => '/tmp/x' });
    expect(r).toEqual({ key: 'github.com/a/b', name: 'b' });
  });
  it('falls back to a path hash without remote', () => {
    const r = projectKeyFor('/home/me/proj', { gitRemote: () => null, gitTopLevel: () => null });
    expect(r.key).toMatch(/^path:[0-9a-f]{16}$/);
    expect(r.name).toBe('proj');
  });
});
