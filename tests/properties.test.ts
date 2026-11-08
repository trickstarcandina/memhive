import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mulberry32, seeded, int, pick, chars, ALNUM, type Rng } from './helpers/prng.js';
import { pgTestDb } from './helpers/pg.js';
import { toFtsQuery } from '../src/store/sqlite/fts-query.js';
import { setTomlBooleanChecked } from '../src/install/toml.js';
import { renderPluginDir } from '../src/install/plugin-files.js';
import { normalizeRemote } from '../src/shared/project-key.js';
import { formatFull, formatIndex } from '../src/mcp/format.js';
import { buildContext, estimateTokens } from '../src/context/builder.js';
import { PostgresHubStore } from '../src/hub/store/postgres.js';
import { obs } from './store/store-contract.js';
import { newId } from '../src/shared/ids.js';
import type { Summary } from '../src/store/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
// Hostile text: FTS/tsquery operators, quotes, combining marks, emoji, NUL and other controls, line terminators, markdown.
const HOSTILE = [
  '"',
  "'",
  '*',
  '-',
  ':',
  '^',
  '(',
  ')',
  '&',
  '|',
  '!',
  '<->',
  '\\',
  'NEAR',
  'AND',
  'OR',
  'NOT',
  '́',
  '\u0000',
  '\u0007',
  '\u001b[2J',
  '\r',
  '\n',
  '\r\n',
  ' ',
  ' ',
  '\u0085',
  '\v',
  '\f',
  '#',
  '## ',
  '---',
  '***',
  '<<<narrative',
  'narrative>>>',
  '|',
  '😀',
  '漢字',
  'Đăng',
  ' ',
  '\t',
  '_',
];
const hostile = (r: Rng, n = int(r, 0, 12)) =>
  Array.from({ length: n }, () => (r() < 0.5 ? pick(r, HOSTILE) : chars(r, ALNUM, int(r, 1, 6)))).join(
    r() < 0.5 ? '' : ' '
  );

describe('toFtsQuery against a real FTS5 table', () => {
  it('never makes MATCH throw and quotes every token', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61'); INSERT INTO t VALUES ('hello world'), ('Đăng nhập lỗi'), ('near and or not');"
    );
    const q = db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?');
    const r = seeded(0xf75);
    for (let i = 0; i < 3000; i++) {
      const input = hostile(r);
      for (const op of [' ', ' OR '] as const) {
        const fts = toFtsQuery(input, op);
        if (!fts) continue;
        for (const tok of fts.split(op)) expect(tok, JSON.stringify(input)).toMatch(/^"[^"\s]+"$/);
        expect(() => q.get(fts), JSON.stringify(input)).not.toThrow();
      }
    }
    db.close();
  });
});

const pg = pgTestDb('properties');
describe.skipIf(!pg)('toTsQuery against real to_tsquery', () => {
  it('random hostile queries never make Postgres throw', async () => {
    await pg!.reset();
    const s = new PostgresHubStore(pg!.url, { dims: null });
    await s.migrate();
    try {
      const p = await s.getOrCreateProject('k', 'n');
      const a = {
        id: newId(),
        projectId: p.id,
        userId: 'u',
        host: 'h',
        hostSessionId: 'x',
        cwd: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
        origin: 'local' as const,
        syncedAt: null,
      };
      await s.upsertSessions([a]);
      const r = seeded(0x75);
      for (let i = 0; i < 400; i++) {
        const input = hostile(r);
        await expect(
          s.searchObservationsFts(input, { projectId: p.id, limit: 5 }),
          JSON.stringify(input)
        ).resolves.toBeInstanceOf(Array);
      }
    } finally {
      await s.close();
    }
  });
});

describe('setTomlBooleanChecked on random TOML', () => {
  const key = (r: Rng) => pick(r, ['name', 'model', 'x', 'hooks_extra', 'feature', 'k' + int(r, 0, 9)]);
  const val = (r: Rng): string =>
    pick(r, [
      () => String(int(r, -5, 99)),
      () => (r() < 0.5 ? 'true' : 'false'),
      () => `"a # not a comment ${chars(r, ALNUM, 3)}"`,
      () => `'lit [x] ${chars(r, ALNUM, 2)}'`,
      () => `[1, 2, "three"]`,
      () => `{ y = 1, z = "w" }`,
      () => `"""\n[features]\nhooks = ${r() < 0.5}\n# inside\n"""`,
      () => `'''\n[[srv]]\n'''`,
    ])();
  const block = (r: Rng, used: Set<string>): string => {
    const kv = () => {
      let k = key(r);
      while (used.has(k)) k += '_';
      used.add(k);
      return `${k} = ${val(r)}${r() < 0.3 ? ' # trailing # comment' : ''}`;
    };
    return Array.from({ length: int(r, 0, 3) }, kv).join('\n');
  };
  const doc = (r: Rng): string => {
    const parts: string[] = [];
    const topUsed = new Set<string>();
    parts.push(block(r, topUsed));
    if (r() < 0.3) parts.push(`dotted.k${int(r, 0, 9)} = 1`);
    const tables = new Set<string>();
    for (let i = int(r, 0, 4); i > 0; i--) {
      const kind = int(r, 0, 3);
      if (kind === 0 && !tables.has('features')) {
        tables.add('features');
        parts.push(
          `[features]${r() < 0.3 ? ' # flags' : ''}\n` +
            (r() < 0.5 ? `hooks = ${r() < 0.5}\n` : '') +
            block(r, new Set(['hooks']))
        );
      } else if (kind === 1) parts.push(`[[srv]]\n` + block(r, new Set()));
      else if (kind === 2) {
        const t = 'mcp_servers.m' + int(r, 0, 99);
        if (!tables.has(t)) {
          tables.add(t);
          parts.push(`[${t}]\n` + block(r, new Set()));
        }
      } else parts.push(`# [features] in a comment\n`);
    }
    const s = parts.filter(Boolean).join('\n') + (r() < 0.5 ? '\n' : '');
    return r() < 0.3 ? s.replace(/\n/g, '\r\n') : s;
  };
  it('output parses and equals the input with exactly features.hooks changed, or the call throws', () => {
    const r = seeded(0x7041);
    let edited = 0;
    for (let i = 0; i < 2000; i++) {
      const input = doc(r);
      let before: Record<string, any>;
      try {
        before = parse(input) as Record<string, any>;
      } catch {
        continue;
      } // the generator can make a duplicate key: not valid input
      const value = r() < 0.5;
      let out: string;
      try {
        out = setTomlBooleanChecked(input, '[features]', 'hooks', value);
      } catch {
        continue;
      }
      const want = structuredClone(before);
      want.features = { ...(want.features ?? {}), hooks: value };
      expect(parse(out), JSON.stringify(input)).toEqual(want);
      edited++;
    }
    expect(edited).toBeGreaterThan(500);
  });
});

describe.skipIf(process.platform === 'win32')('rendered hook command through sh -c', () => {
  it('node and bundle paths with quotes, spaces, $, backticks and newlines reach the program unchanged', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'mh-shq-'));
    const printer = path.join(work, 'argv.cjs');
    writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const r = seeded(0x540);
    const nasty = [
      "'",
      ' ',
      '$',
      '$(id)',
      '`id`',
      '\n',
      '"',
      '\\',
      ';',
      '&',
      '|',
      '*',
      '?',
      '!',
      '~',
      '%',
      '{a,b}',
      'é',
      "'\\''",
    ];
    const piece = () =>
      Array.from({ length: int(r, 1, 4) }, () => (r() < 0.5 ? pick(r, nasty) : chars(r, ALNUM, int(r, 1, 4)))).join('');
    for (let i = 0; i < 25; i++) {
      const dir = path.join(work, `c${i}`, piece().replace(/\//g, ''));
      mkdirSync(dir, { recursive: true });
      const node = path.join(dir, piece().replace(/\//g, '') + 'node');
      writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(printer)} "$@"\n`);
      chmodSync(node, 0o755);
      const bundle = path.join(work, piece(), 'memhive ' + piece() + '.cjs');
      const out = path.join(work, `out${i}`);
      renderPluginDir({
        templateRoot: ROOT,
        marketplaceRoot: out,
        nodePath: node,
        bundlePath: bundle,
        version: '0.0.0',
      });
      const hooks = JSON.parse(readFileSync(path.join(out, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8'));
      const cmd: string = hooks.hooks.SessionStart[0].hooks[0].command;
      const res = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
      expect(res.status, JSON.stringify({ node, bundle, err: res.stderr })).toBe(0);
      expect(JSON.parse(res.stdout), JSON.stringify({ node, bundle })).toEqual([
        bundle,
        'hook',
        'codex',
        'SessionStart',
      ]);
    }
  });
});

describe('normalizeRemote fuzz', () => {
  it('every spelling of one repo gives one key, never null', () => {
    const r = seeded(0x6e7);
    const name = () => chars(r, ALNUM + '-_', int(r, 1, 6)) + (r() < 0.3 ? '.' + chars(r, ALNUM, 2) : '');
    for (let i = 0; i < 2000; i++) {
      const host = chars(r, 'abcdefghijklmnopqrstuvwxyz', int(r, 2, 8)) + pick(r, ['.com', '.org', '.example.io', '']);
      // an all-digit owner in scp form reads as a port (host:123/repo); see the shortcut note in normalizeRemote
      const owner = name().replace(/^\d+$/, 'o$&') + (r() < 0.2 ? '/' + name() : '');
      const repo = name();
      const H = r() < 0.3 ? host.toUpperCase() : host;
      const path_ = r() < 0.2 ? `${owner}/${repo}`.toUpperCase() : `${owner}/${repo}`;
      const git = pick(r, ['', '.git', '.git/', '/', '.GIT', '//']);
      const port = r() < 0.4 ? ':' + int(r, 1, 65535) : '';
      const user = pick(r, ['', 'git@', 'user@', 'x-token:abc@']);
      const forms = [
        `https://${user}${H}${port}/${path_}${git}`,
        `ssh://${user || 'git@'}${H}${port}/${path_}${git}`,
        `git@${H}:${path_}${git}`,
        `git+ssh://git@${H}/${path_}${git}`,
        `http://${H}/${path_}${git}`,
        `  https://${H}/${path_}${git}\n`,
      ];
      const want = `${host}/${owner}/${repo}`.toLowerCase();
      for (const f of forms) expect(normalizeRemote(f), f).toBe(want);
    }
  });
});

describe('formatters and context with control characters in stored fields', () => {
  // each it() reseeds, so a case found in a shuffled run reproduces in a default one
  let r = mulberry32(0);
  const seed = (n: number) => {
    r = seeded(n);
  };
  const field = () => hostile(r, int(r, 0, 8));
  const row = () =>
    obs({
      projectId: 'p',
      sessionId: 's',
      title: field(),
      subtitle: field(),
      narrative: Array.from({ length: int(r, 0, 4) }, field).join(pick(r, ['\n', '\r\n', ' ', '\r'])),
      facts: Array.from({ length: int(r, 0, 4) }, field),
      concepts: [field()],
      filesRead: [field()],
      filesModified: [field()],
      userId: r() < 0.5 ? 'alice' : field(),
      createdAt: new Date(Date.UTC(2026, 0, int(r, 1, 28))).toISOString(),
      origin: r() < 0.5 ? 'local' : 'hub',
    });
  const summary = (): Summary => ({
    id: newId(),
    projectId: 'p',
    sessionId: 's',
    userId: 'u',
    request: field(),
    learned: field(),
    completed: field(),
    nextSteps: field(),
    createdAt: new Date().toISOString(),
    origin: 'local',
    syncedAt: null,
  });

  // a CommonMark thematic break or setext underline (3+ of one of - * _, or a run of =)
  const rule = (l: string) => /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(l) || /^ {0,3}=+[ \t]*$/.test(l);
  it('formatFull and formatIndex: data never starts a heading, rule or fence line', () => {
    seed(0xf8);
    for (let i = 0; i < 500; i++) {
      const rows = Array.from({ length: int(r, 1, 4) }, row);
      const sums = Array.from({ length: int(r, 0, 2) }, summary);
      const full = formatFull(rows, sums).split('\n');
      const n = rows.length + sums.length;
      const fenced = rows.filter((o) => o.narrative).length;
      expect(
        full.filter((l) => /^\s*#/.test(l)).every((l) => /^## #[0-9a-f]{8} · /.test(l)),
        JSON.stringify(full)
      ).toBe(true);
      expect(full.filter((l) => /^\s*#/.test(l))).toHaveLength(n);
      expect(full.filter(rule), JSON.stringify(full)).toEqual(Array(n).fill('---')); // one rule after the note, one between rows
      expect(full.filter((l) => /^\s*<<</.test(l))).toEqual(Array(fenced).fill('<<<narrative'));
      expect(full.filter((l) => /^\s*narrative>>>/.test(l))).toEqual(Array(fenced).fill('narrative>>>'));
      const index = formatIndex(rows).split('\n');
      expect(index).toHaveLength(rows.length + 2);
      expect(
        index.every((l) => l.startsWith('|') && l.endsWith('|')),
        JSON.stringify(index)
      ).toBe(true);
    }
  });

  it('buildContext keeps rows on one line and stays within budget', () => {
    seed(0xb17d);
    for (let i = 0; i < 500; i++) {
      const rows = Array.from({ length: int(r, 0, 12) }, row).map((o) => ({ ...o, pinned: r() < 0.2 }));
      const budget = int(r, 100, 1500);
      const c = buildContext({
        projectName: field(),
        observationCount: rows.length,
        sessionCount: 1,
        lastActivity: null,
        summaries: Array.from({ length: int(r, 0, 3) }, summary),
        observations: rows,
        budgetTokens: budget,
        now: new Date('2026-02-01T00:00:00Z'),
      });
      expect(estimateTokens(c)).toBeLessThanOrEqual(budget);
      const lines = c.split('\n');
      const heads = lines.filter((l) => /^\s*#/.test(l));
      expect(
        heads.every((l) => /^#[0-9a-f]{8} · /.test(l)),
        JSON.stringify(c)
      ).toBe(true);
      expect(heads.length).toBeLessThanOrEqual(rows.length);
      expect(
        lines.some((l) => rule(l) || /^\s*(narrative>>>|<<<narrative)/.test(l)),
        JSON.stringify(c)
      ).toBe(false);
    }
  });
});
