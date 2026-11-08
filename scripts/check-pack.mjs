// Asserts the npm package holds exactly what memhive needs at runtime.
//
// The plugin templates live in dot-directories, which are the first thing to silently drop out
// when `files` or an .npmignore changes; sources, tests and sourcemaps must never ship.
//
// node scripts/check-pack.mjs              checks `npm pack --dry-run` of the working tree
// node scripts/check-pack.mjs <file.tgz>   checks a packed tarball (what CI publishes)
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const EXACT = ['LICENSE', 'README.md', 'dist/memhive.cjs', 'package.json'];
const TREES = ['plugin/', 'plugin-marketplace/'];
// Each must contain at least one file.
const REQUIRED_DIRS = [
  'plugin/.claude-plugin/',
  'plugin/.codex-plugin/',
  'plugin/hooks/',
  'plugin/skills/',
  'plugin-marketplace/.agents/',
  'plugin-marketplace/.claude-plugin/',
];

/** Returns a list of problems; empty means the file list is right. */
export function checkPackFiles(files) {
  const problems = [];
  for (const f of files) {
    if (!EXACT.includes(f) && !TREES.some((t) => f.startsWith(t))) problems.push(`unexpected file: ${f}`);
  }
  for (const f of EXACT) if (!files.includes(f)) problems.push(`missing file: ${f}`);
  for (const d of REQUIRED_DIRS) if (!files.some((f) => f.startsWith(d))) problems.push(`missing directory: ${d}`);
  return problems;
}

function run(cmd, args) {
  // npm is npm.cmd on Windows, which only spawns through a shell.
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

export function listFiles(tarball) {
  if (tarball) {
    return run('tar', ['-tzf', tarball])
      .split(/\r?\n/)
      .filter((l) => l && !l.endsWith('/'))
      .map((l) => l.replace(/^package\//, ''));
  }
  return JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']))[0].files.map((f) => f.path);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = listFiles(process.argv[2]);
  const problems = checkPackFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`package contents ok (${files.length} files)`);
}
