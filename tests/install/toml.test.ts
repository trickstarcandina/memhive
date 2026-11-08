import { it, expect } from 'vitest';
import { setTomlBoolean } from '../../src/install/toml.js';
it('appends a table when missing', () => expect(setTomlBoolean('model = "x"\n', '[features]', 'hooks', true)).toBe('model = "x"\n\n[features]\nhooks = true\n'));
it('updates an existing key in place and keeps the rest', () => {
  const src = '[features]\nhooks = false # keep\nother = 1\n\n[plugins."memhub@memhub-local"]\nenabled = false\n';
  const out = setTomlBoolean(setTomlBoolean(src, '[features]', 'hooks', true), '[plugins."memhub@memhub-local"]', 'enabled', true);
  expect(out).toBe('[features]\nhooks = true\nother = 1\n\n[plugins."memhub@memhub-local"]\nenabled = true\n');
});
it('inserts a key into an existing table without the key', () => expect(setTomlBoolean('[features]\nx = 1\n', '[features]', 'hooks', true)).toBe('[features]\nhooks = true\nx = 1\n'));
