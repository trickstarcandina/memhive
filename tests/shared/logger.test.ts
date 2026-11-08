import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../../src/shared/logger.js';

describe('logger', () => {
  it('appends JSON lines and skips debug unless MEMHIVE_DEBUG', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const log = createLogger(home, 'hook', {});
    log.info('hello', { a: 1 });
    log.debug('hidden');
    const lines = readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
  });
  it('rotates at 5 MB', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const log = createLogger(home, 'hook', {}, { maxBytes: 100 });
    for (let i = 0; i < 10; i++) log.info('x'.repeat(40));
    expect(existsSync(path.join(home, 'logs', 'hook.log.1'))).toBe(true);
  });
  it('another process holding the rotation lock means no rotation here (no clobbered .1)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    mkdirSync(path.join(home, 'logs'), { recursive: true });
    writeFileSync(path.join(home, 'logs', 'hook.log.1'), 'old rotated\n');
    writeFileSync(path.join(home, 'logs', 'hook.log.rotate'), String(process.pid));
    const log = createLogger(home, 'hook', {}, { maxBytes: 100 });
    for (let i = 0; i < 10; i++) log.info('x'.repeat(40));
    expect(readFileSync(path.join(home, 'logs', 'hook.log.1'), 'utf8')).toBe('old rotated\n');
    expect(readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8').split('\n').length).toBeGreaterThan(10);
  });
});

describe('logger robustness', () => {
  it('still appends when the rotation rename fails', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    mkdirSync(path.join(home, 'logs', 'hook.log.1', 'busy'), { recursive: true }); // rename onto a non-empty dir fails
    writeFileSync(path.join(home, 'logs', 'hook.log'), 'x'.repeat(200) + '\n');
    const log = createLogger(home, 'hook', {}, { maxBytes: 100 });
    log.info('kept');
    expect(readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8')).toContain('"msg":"kept"');
  });
  it.skipIf(process.platform === 'win32')('tightens a log file left 0644 by an older build', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    mkdirSync(path.join(home, 'logs'), { recursive: true });
    writeFileSync(path.join(home, 'logs', 'hook.log'), 'old\n', { mode: 0o644 });
    createLogger(home, 'hook', {}).info('x');
    expect(statSync(path.join(home, 'logs', 'hook.log')).mode & 0o777).toBe(0o600);
  });
});

describe('logger field order', () => {
  it('lets fixed fields win over caller data', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const log = createLogger(home, 'hook', {});
    log.info('real', { msg: 'fake', level: 'fake', t: 'fake' });
    const row = JSON.parse(readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8').trim());
    expect(row).toMatchObject({ level: 'info', msg: 'real' });
    expect(row.t).not.toBe('fake');
  });
});
