import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** tmp + rename, so a crash never leaves a truncated file and readers see the old or the new content. */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode); // the create mode is narrowed by umask only; be exact before the rename
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
