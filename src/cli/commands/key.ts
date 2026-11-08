import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { generateApiKey } from '../../hub/auth.js';
import { printJson, withHubStore } from './hub-admin.js';

const USAGE = 'usage: memhive key <create --user <name> [--label <text>] | list | revoke <id> | rotate <id|user>> [--json]\n';

export async function keyCommand(args: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0]; const json = !!flags.json;
  if (!['create', 'list', 'revoke', 'rotate'].includes(sub)) { io.stderr(USAGE); return 1; }
  return withHubStore('key', io, env, async (store) => {
    if (sub === 'create') {
      const user = typeof flags.user === 'string' ? flags.user : ''; if (!user) { io.stderr('usage: memhive key create --user <name> [--label <text>] [--json]\n'); return 1; }
      await store.createUser(user);
      const k = generateApiKey(); const row = await store.createApiKey(user, typeof flags.label === 'string' ? flags.label : 'default', k.hash);
      if (json) printJson(io, { ...row, key: k.raw }); else io.stdout(`Created key ${row.id} for ${user}. Key (shown once):\n  ${k.raw}\n`);
      return 0;
    }
    if (sub === 'list') {
      const keys = await store.listApiKeys();
      if (json) printJson(io, keys);
      else for (const k of keys) io.stdout(`${k.id}  ${k.userName.padEnd(16)}  ${k.label.padEnd(16)}  ${k.createdAt}${k.revokedAt ? '  REVOKED' : ''}\n`);
      return 0;
    }
    const target = positional[1]; if (!target) { io.stderr(sub === 'revoke' ? 'usage: memhive key revoke <id> [--json]\n' : 'usage: memhive key rotate <id|user> [--json]\n'); return 1; }
    if (sub === 'revoke') {
      const done = await store.revokeApiKey(target);
      if (json) printJson(io, { id: target, revoked: done }); else io.stdout(done ? `revoked ${target}\n` : `no active key ${target}\n`);
      return 0;
    }
    // rotate: a key id, or a user name when that user has exactly one active key
    const active = (await store.listApiKeys()).filter((k) => !k.revokedAt);
    const byUser = active.filter((k) => k.userName === target);
    const old = active.find((k) => k.id === target) ?? (byUser.length === 1 ? byUser[0] : undefined);
    if (!old) { io.stderr(byUser.length > 1 ? `memhive key: ${target} has ${byUser.length} active keys; rotate one by id: ${byUser.map((k) => k.id).join(', ')}\n` : `memhive key: no active key or user ${target}\n`); return 1; }
    const k = generateApiKey(); const row = await store.rotateApiKey(old.id, k.hash);
    if (!row) { io.stderr(`memhive key: key ${old.id} was revoked meanwhile\n`); return 1; }
    if (json) printJson(io, { ...row, key: k.raw, revoked: old.id }); else io.stdout(`Rotated ${old.id} (revoked) to ${row.id} for ${row.userName}. Key (shown once):\n  ${k.raw}\n`);
    return 0;
  });
}
