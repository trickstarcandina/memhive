import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../../src/shared/logger.js';

describe('logger', () => {
  it('appends JSON lines and skips debug unless MEMHUB_DEBUG', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const log = createLogger(home, 'hook', {});
    log.info('hello', { a: 1 });
    log.debug('hidden');
    const lines = readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
  });
  it('rotates at 5 MB', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const log = createLogger(home, 'hook', {}, { maxBytes: 100 });
    for (let i = 0; i < 10; i++) log.info('x'.repeat(40));
    expect(existsSync(path.join(home, 'logs', 'hook.log.1'))).toBe(true);
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
