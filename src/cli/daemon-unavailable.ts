import { resolvePaths } from '../shared/paths.js';
import { DatabaseNewerThanBinary, schemaStatus } from '../store/sqlite/store.js';

/** What a CLI command prints when no daemon could be reached; names the real cause when the database is too new. */
export function daemonUnavailableMessage(home: string): string {
  try {
    const st = schemaStatus(resolvePaths(home).db);
    if (st && st.version > st.known) return `memhive: ${new DatabaseNewerThanBinary(st.version, st.known).message}\n`;
  } catch {
    /* unreadable: generic message */
  }
  return 'memhive: daemon unavailable (see logs/daemon.log)\n';
}
