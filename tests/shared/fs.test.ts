import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../src/shared/fs.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { writeDaemonInfo } from '../../src/daemon/info.js';
import { saveSettings, DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import { expectMode } from '../helpers/posix.js';

const mk = () => mkdtempSync(path.join(tmpdir(), 'mh-'));

describe('writeFileAtomic (m6)', () => {
  it('never writes through a file or symlink planted at its temp path, and leaves no temp file', () => {
    const dir = mk();
    const file = path.join(dir, 'secret.json');
    const victim = path.join(mk(), 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, `${file}.${process.pid}.tmp`);
    writeFileAtomic(file, 'key', 0o600);
    expect(readFileSync(file, 'utf8')).toBe('key');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expectMode(file, 0o600);
    expect(readdirSync(dir)).toEqual(['secret.json']);
  });
  it.each([
    ['credentials.json', (home: string) => saveCredentials(home, { hubs: {} })],
    ['daemon.json', (home: string) => writeDaemonInfo(home, { port: 1, pid: 1, token: 't', startedAt: '' })],
    ['settings.json', (home: string) => saveSettings(home, DEFAULT_SETTINGS)],
  ])('%s goes through it', (name, write) => {
    const home = mk();
    const victim = path.join(mk(), 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, path.join(home, `${name}.${process.pid}.tmp`));
    write(home);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expectMode(path.join(home, name), 0o600);
  });
});
