import { afterAll } from 'vitest';
import { setDefaultSpawn } from '../../src/daemon/ensure.js';

// Every test file: a CLI command or hook that reaches ensureDaemon's default spawn would start a detached
// `node <vitest entry> daemon run`. Record it instead and fail the file, so each such test injects its own spawn.
const spawned: string[] = [];
setDefaultSpawn((bundle, home) => { spawned.push(`${bundle} daemon run (MEMHIVE_HOME=${home})`); });
afterAll(() => {
  if (spawned.length) throw new Error(`a test reached the default daemon spawn ${spawned.length} time(s); inject spawn instead:\n${spawned.join('\n')}`);
});
