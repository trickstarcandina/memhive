import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export default defineConfig({
  define: { __MEMHIVE_VERSION__: JSON.stringify(version) },
  test: {
    include: ['tests/**/*.test.ts'], testTimeout: 15000,
    globalSetup: ['tests/helpers/global-setup.ts'], setupFiles: ['tests/helpers/no-spawn.ts'],
    // `npm run test:coverage`; no threshold, the numbers are reported only
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text-summary', 'text', 'json-summary'], reportsDirectory: 'coverage' },
  },
});
