import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * tmp + rename, so a crash never leaves a truncated file and readers see the old or the new content. The temp file is
 * created exclusively (wx) with `mode` from the first byte: never written through a file or symlink planted at its
 * predictable name.
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a leftover from a crash (or a planted symlink) would make the exclusive create fail
  try {
    writeFileSync(tmp, data, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) chmodSync(tmp, mode); // the create mode is narrowed by umask only; be exact before the rename
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
