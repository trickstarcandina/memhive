import { it, expect, describe } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/index.js';
import { COMMANDS, USAGE } from '../../src/cli/help.js';
import { parseArgs } from '../../src/cli/args.js';

async function run(argv: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-help-'));
  const prev = process.env.MEMHIVE_HOME;
  process.env.MEMHIVE_HOME = home;
  let out = '';
  let err = '';
  try {
    const code = await main(argv, {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });
    return { code, out, err, files: readdirSync(home) };
  } finally {
    if (prev === undefined) delete process.env.MEMHIVE_HOME;
    else process.env.MEMHIVE_HOME = prev;
  }
}

describe('help matrix', () => {
  for (const cmd of Object.keys(COMMANDS)) {
    for (const flag of ['--help', '-h']) {
      it(`${cmd} ${flag} prints its usage and has no side effects`, async () => {
        const r = await run([cmd, flag]);
        expect(r.code).toBe(0);
        expect(r.out).toBe(COMMANDS[cmd].usage);
        expect(r.out).toContain(`memhive ${cmd}`);
        expect(r.err).toBe('');
        expect(r.files).toEqual([]);
      });
    }
    if (cmd === 'hook') continue;
    it(`${cmd} refuses an unknown flag with exit 2 before doing anything`, async () => {
      const r = await run([cmd, '--sinse', '7d']);
      expect(r.code).toBe(2);
      expect(r.err).toBe(`unknown flag --sinse for ${cmd}; see memhive ${cmd} --help\n`);
      expect(r.out).toBe('');
      expect(r.files).toEqual([]);
    });
    for (const f of COMMANDS[cmd].bool)
      it(`${cmd} --${f} is listed in its usage`, () => expect(COMMANDS[cmd].usage).toContain(`--${f}`));
    for (const f of COMMANDS[cmd].value)
      it(`${cmd} --${f} is listed in its usage`, () => expect(COMMANDS[cmd].usage).toContain(`--${f}`));
  }
  it('every command is in the top-level usage', () => {
    for (const cmd of Object.keys(COMMANDS)) expect(USAGE).toContain(cmd);
  });
  it('a value flag without its value is a usage error', async () => {
    const r = await run(['search', 'q', '--since']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--since needs a value');
  });
  it('an unknown command exits 2', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });
  it('hook ignores flags it does not know (the host calls it)', async () => {
    const r = await run(['hook', '--whatever']);
    expect(r.err).not.toContain('unknown flag');
  });
  it('boolean flags of a command never swallow the next argument', () => {
    expect(parseArgs(['--yes', 'abcd1234', '--force', 'ef01'], 'forget')).toEqual({
      positional: ['abcd1234', 'ef01'],
      flags: { yes: true, force: true },
    });
    expect(parseArgs(['--yes', 'abcd1234'])).toEqual({ positional: [], flags: { yes: 'abcd1234' } }); // no command: old behaviour
  });
});
