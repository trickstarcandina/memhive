import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Windows has no POSIX permission bits: Node reports 0o666 (0o444 read-only) for every file, so mode checks are POSIX-only.
export const posix = process.platform !== 'win32';
export const itPosix = it.skipIf(!posix);
export const describePosix = describe.skipIf(!posix);
export const modeOf = (p: string) => statSync(p).mode & 0o777;
/** Asserts the permission bits of `p`; a no-op on Windows. */
export function expectMode(p: string, mode: number): void {
  if (posix) expect(modeOf(p)).toBe(mode);
}
