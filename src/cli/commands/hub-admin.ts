import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { createHubStore } from '../../hub/server.js';
import type { HubStore } from '../../hub/store/types.js';

/** Opens the hub DB from DATABASE_URL (like serve, minus the dims guard), migrates, runs fn, and always closes. */
export async function withHubStore(
  cmd: string,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  fn: (store: HubStore) => Promise<number>
): Promise<number> {
  let store: HubStore;
  try {
    store = createHubStore(env, 'admin');
  } catch (e) {
    io.stderr(`memhive ${cmd}: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  try {
    await store.migrate();
    return await fn(store);
  } catch (e) {
    io.stderr(`memhive ${cmd}: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  } finally {
    await store.close();
  }
}
export const printJson = (io: CliIo, v: unknown) => io.stdout(JSON.stringify(v, null, 2) + '\n');

export async function userCommand(args: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positional, flags } = parseArgs(args, 'user');
  const sub = positional[0];
  const json = !!flags.json;
  if (sub !== 'list' && sub !== 'remove') {
    io.stderr('usage: memhive user <list | remove <name>> [--json]\n');
    return 2;
  }
  if (sub === 'remove' && !positional[1]) {
    io.stderr('usage: memhive user remove <name> [--json]\n');
    return 2;
  }
  return withHubStore('user', io, env, async (store) => {
    if (sub === 'list') {
      const users = await store.listUsers();
      if (json) printJson(io, users);
      else
        for (const u of users)
          io.stdout(
            `${u.name.padEnd(16)}  ${String(u.activeKeys).padStart(3)} keys  ${String(u.observations).padStart(7)} observations  last seen ${u.lastSeen ?? 'never'}\n`
          );
      return 0;
    }
    const name = positional[1];
    const r = await store.removeUser(name);
    if (!r) {
      io.stderr(`memhive user: no user "${name}"\n`);
      return 1;
    }
    if (json) printJson(io, { user: name, ...r });
    else
      io.stdout(
        `revoked ${r.revokedKeys} key(s) of ${name}. Kept on the hub: ${r.sessions} sessions, ${r.observations} observations, ${r.summaries} summaries (still visible to the team).\n`
      );
    return 0;
  });
}

export async function projectCommand(args: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positional, flags } = parseArgs(args, 'project');
  if (positional[0] !== 'list') {
    io.stderr('usage: memhive project list [--json]\n');
    return 2;
  }
  return withHubStore('project', io, env, async (store) => {
    const projects = await store.listProjects();
    if (flags.json) printJson(io, projects);
    else
      for (const p of projects)
        io.stdout(
          `${p.key}  (${p.name})  ${p.observations} observations, ${p.sessions} sessions, ${p.summaries} summaries, last activity ${p.lastActivity ?? 'never'}\n`
        );
    return 0;
  });
}
