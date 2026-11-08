import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { createHubStore } from '../../hub/server.js';
import { generateApiKey } from '../../hub/auth.js';

export async function keyCommand(args: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];
  let store; try { store = createHubStore(env); } catch (e) { io.stderr(`memhub key: ${e instanceof Error ? e.message : e}\n`); return 1; }
  try {
    await store.migrate();
    if (sub === 'create') {
      const user = typeof flags.user === 'string' ? flags.user : ''; if (!user) { io.stderr('usage: memhub key create --user <name> [--label <text>]\n'); return 1; }
      await store.createUser(user);
      const k = generateApiKey(); const row = await store.createApiKey(user, typeof flags.label === 'string' ? flags.label : 'default', k.hash);
      io.stdout(`Created key ${row.id} for ${user}. Key (shown once):\n  ${k.raw}\n`); return 0;
    }
    if (sub === 'list') { for (const k of await store.listApiKeys()) io.stdout(`${k.id}  ${k.userName.padEnd(16)}  ${k.label.padEnd(16)}  ${k.createdAt}${k.revokedAt ? '  REVOKED' : ''}\n`); return 0; }
    if (sub === 'revoke') { const id = positional[1]; if (!id) { io.stderr('usage: memhub key revoke <id>\n'); return 1; } io.stdout((await store.revokeApiKey(id)) ? `revoked ${id}\n` : `no active key ${id}\n`); return 0; }
    io.stderr('usage: memhub key <create|list|revoke>\n'); return 1;
  } catch (e) { io.stderr(`memhub key: ${e instanceof Error ? e.message : e}\n`); return 1; }
  finally { await store.close(); }
}
