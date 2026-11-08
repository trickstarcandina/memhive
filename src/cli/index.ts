import { VERSION } from '../shared/version.js';

declare const require: any;
declare const module: any;

export interface CliIo { stdout: (s: string) => void; stderr: (s: string) => void }
const defaultIo: CliIo = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };

const USAGE = `memhub ${VERSION}
usage: memhub <command>
  install | uninstall | doctor
  hook <claude-code|codex> <event>
  daemon <run|start|stop|status>
  mcp
  search <query> [--type t] [--limit n]
  embed [--missing|--rebuild]
  serve
  key <create|list|revoke>
  login <hub-url> [--key-stdin]
  link <hub-url> | unlink | sync
  version
`;

const SUB_USAGE: Record<string, string> = {
  install: 'usage: memhub install [--yes] [--host claude-code,codex] [--provider anthropic|openai-compat] [--no-ping]\n',
  uninstall: 'usage: memhub uninstall\n',
  doctor: 'usage: memhub doctor\n',
  hook: 'usage: memhub hook <claude-code|codex> <event>\n',
  daemon: 'usage: memhub daemon <run|start|stop|status>\n',
  mcp: 'usage: memhub mcp\n',
  search: 'usage: memhub search <query> [--type t] [--user u] [--since 7d] [--limit n]\n',
  embed: 'usage: memhub embed [--missing|--rebuild]\n',
  serve: 'usage: memhub serve   (env: DATABASE_URL, PORT, MEMHUB_EMBED_MODEL, MEMHUB_EMBED_DIMS)\n',
  key: 'usage: memhub key <create --user <name> [--label <text>] | list | revoke <id>>\n',
  login: 'usage: memhub login <hub-url> [--key-stdin]   (prompts for the API key without echo; --key-stdin reads it from stdin)\n',
  link: 'usage: memhub link <hub-url>   (links the current project to a hub you are logged in to)\n',
  unlink: 'usage: memhub unlink   (stops syncing the current project)\n',
  sync: 'usage: memhub sync   (push and pull the current project now)\n',
};

export async function main(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const { stdout, stderr } = { ...defaultIo, ...io };
  const [cmd, ...rest] = argv;
  // --help/-h never reaches a subcommand, so it cannot spawn or write anything.
  if (cmd && cmd in SUB_USAGE && rest.some((a) => a === '--help' || a === '-h')) { stdout(SUB_USAGE[cmd]); return 0; }
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': stdout(USAGE); return 0;
    case 'version': case '--version': case '-v': stdout(`${VERSION}\n`); return 0;
    case 'hook': return (await import('../hooks/hook-command.js')).runHook(rest);
    case 'daemon': return (await import('./commands/daemon.js')).daemonCommand(rest, { stdout, stderr });
    case 'mcp': return (await import('../mcp/server.js')).runMcp();
    case 'search': return (await import('./commands/search.js')).searchCommand(rest, { stdout, stderr });
    case 'embed': return (await import('./commands/embed.js')).embedCommand(rest, { stdout, stderr });
    case 'doctor': return (await import('./commands/doctor.js')).doctorCommand(rest, { stdout, stderr });
    case 'install': return (await import('./commands/install.js')).installCommand(rest, { stdout, stderr });
    case 'serve': return (await import('./commands/serve.js')).serveCommand(rest, { stdout, stderr });
    case 'key': return (await import('./commands/key.js')).keyCommand(rest, { stdout, stderr });
    case 'login': return (await import('./commands/login.js')).loginCommand(rest, { stdout, stderr });
    case 'link': return (await import('./commands/link.js')).linkCommand(rest, { stdout, stderr });
    case 'unlink': return (await import('./commands/link.js')).linkCommand(rest, { stdout, stderr }, { unlink: true });
    case 'sync': return (await import('./commands/sync.js')).syncCommand(rest, { stdout, stderr });
    case 'uninstall': return (await import('./commands/uninstall.js')).uninstallCommand(rest, { stdout, stderr });
    default: stderr(`memhub: unknown command "${cmd}"\n${USAGE}`); return 1;
  }
}

const isEntry = typeof require !== 'undefined' && require.main === module;
if (isEntry || process.env.MEMHUB_FORCE_MAIN === '1') {
  const argv = process.argv.slice(2);
  // daemon run, serve and mcp are long-lived; everything else must not linger on open handles.
  const longLived = argv[0] === 'mcp' || (argv[0] === 'daemon' && argv[1] === 'run') || argv[0] === 'serve';
  const finish = (code: number) => { process.exitCode = code; if (!longLived) process.stdout.write('', () => process.exit(code)); };
  main(argv).then(finish, (err) => {
    process.stderr.write(`memhub: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    finish(1);
  });
}
