import { COMMANDS } from './help.js';

/** cmd: flags listed as boolean in that command's help entry never take the next argument as their value. */
export function parseArgs(argv: string[], cmd?: string): { positional: string[]; flags: Record<string, string | boolean> } {
  const bool = new Set(cmd ? COMMANDS[cmd]?.bool : []);
  const positional: string[] = []; const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (!bool.has(a.slice(2)) && next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}
