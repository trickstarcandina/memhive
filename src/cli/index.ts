import { VERSION } from '../shared/version.js';
import { COMMANDS, USAGE, flagError } from './help.js';

// biome-ignore lint/suspicious/noExplicitAny: CommonJS globals of the esbuild bundle, untyped in this ESM source
declare const require: any;
// biome-ignore lint/suspicious/noExplicitAny: see above
declare const module: any;

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}
const defaultIo: CliIo = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };

// engines is advisory to npm; without this an old Node fails with a native ABI or syntax error.
export function nodeVersionError(version: string = process.versions.node): string | null {
  return Number(version.split('.')[0]) >= 22 ? null : `memhive requires Node.js >= 22 (found v${version})\n`;
}

export async function main(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const { stdout, stderr } = { ...defaultIo, ...io };
  const [cmd, ...rest] = argv;
  // --help/-h never reaches a subcommand, so it cannot spawn or write anything.
  if (cmd && cmd in COMMANDS && rest.some((a) => a === '--help' || a === '-h')) {
    stdout(COMMANDS[cmd].usage);
    return 0;
  }
  const bad = cmd ? flagError(cmd, rest) : null;
  if (bad) {
    stderr(bad);
    return 2;
  }
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      stdout(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      stdout(`${VERSION}\n`);
      return 0;
    case 'hook':
      return (await import('../hooks/hook-command.js')).runHook(rest);
    case 'daemon':
      return (await import('./commands/daemon.js')).daemonCommand(rest, { stdout, stderr });
    case 'mcp':
      return (await import('../mcp/server.js')).runMcp();
    case 'search':
      return (await import('./commands/search.js')).searchCommand(rest, { stdout, stderr });
    case 'recent':
      return (await import('./commands/search.js')).searchCommand(rest, { stdout, stderr }, { recent: true });
    case 'show':
      return (await import('./commands/observation.js')).showCommand(rest, { stdout, stderr });
    case 'edit':
      return (await import('./commands/observation.js')).editCommand(rest, { stdout, stderr });
    case 'stats':
      return (await import('./commands/stats.js')).statsCommand(rest, { stdout, stderr });
    case 'backup':
      return (await import('./commands/transfer.js')).backupCommand(rest, { stdout, stderr });
    case 'export':
      return (await import('./commands/transfer.js')).exportCommand(rest, { stdout, stderr });
    case 'import':
      return (await import('./commands/transfer.js')).importCommand(rest, { stdout, stderr });
    case 'forget':
      return (await import('./commands/forget.js')).forgetCommand(rest, { stdout, stderr });
    case 'embed':
      return (await import('./commands/embed.js')).embedCommand(rest, { stdout, stderr });
    case 'doctor':
      return (await import('./commands/doctor.js')).doctorCommand(rest, { stdout, stderr });
    case 'install':
      return (await import('./commands/install.js')).installCommand(rest, { stdout, stderr });
    case 'serve':
      return (await import('./commands/serve.js')).serveCommand(rest, { stdout, stderr });
    case 'key':
      return (await import('./commands/key.js')).keyCommand(rest, { stdout, stderr });
    case 'user':
      return (await import('./commands/hub-admin.js')).userCommand(rest, { stdout, stderr });
    case 'project':
      return (await import('./commands/hub-admin.js')).projectCommand(rest, { stdout, stderr });
    case 'login':
      return (await import('./commands/login.js')).loginCommand(rest, { stdout, stderr });
    case 'link':
      return (await import('./commands/link.js')).linkCommand(rest, { stdout, stderr });
    case 'unlink':
      return (await import('./commands/link.js')).linkCommand(rest, { stdout, stderr }, { unlink: true });
    case 'sync':
      return (await import('./commands/sync.js')).syncCommand(rest, { stdout, stderr });
    case 'pause':
      return (await import('./commands/pause.js')).pauseCommand(rest, { stdout, stderr });
    case 'resume':
      return (await import('./commands/pause.js')).pauseCommand(rest, { stdout, stderr }, { resume: true });
    case 'uninstall':
      return (await import('./commands/uninstall.js')).uninstallCommand(rest, { stdout, stderr });
    default:
      stderr(`memhive: unknown command "${cmd}"\n${USAGE}`);
      return 2;
  }
}

const isEntry = typeof require !== 'undefined' && require.main === module;
const tooOld = isEntry ? nodeVersionError() : null;
if (tooOld) {
  process.stderr.write(tooOld);
  process.exit(1);
}
if (isEntry || process.env.MEMHIVE_FORCE_MAIN === '1') {
  const argv = process.argv.slice(2);
  // daemon run, serve and mcp are long-lived; everything else must not linger on open handles.
  const longLived = argv[0] === 'mcp' || (argv[0] === 'daemon' && argv[1] === 'run') || argv[0] === 'serve';
  const finish = (code: number) => {
    process.exitCode = code;
    if (!longLived) process.stdout.write('', () => process.exit(code));
  };
  main(argv).then(finish, (err) => {
    process.stderr.write(`memhive: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    finish(1);
  });
}
