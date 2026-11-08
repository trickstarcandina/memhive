import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export default defineConfig({
  define: { __MEMHIVE_VERSION__: JSON.stringify(version) },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    globalSetup: ['tests/helpers/global-setup.ts'],
    setupFiles: ['tests/helpers/no-spawn.ts'],
    // isolation stays on (tests mutate process.env and process.stdin); VITEST_SHUFFLE=1 flushes out order dependence
    sequence: { shuffle: process.env.VITEST_SHUFFLE === '1' },
    // `npm run test:coverage`; no threshold, the numbers are reported only
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
