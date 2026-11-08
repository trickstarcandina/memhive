// package.json is the only place the version is written: esbuild (bundle) and vitest (tests)
// both inline it through `define`.
declare const __MEMHIVE_VERSION__: string;
export const VERSION: string = __MEMHIVE_VERSION__;
