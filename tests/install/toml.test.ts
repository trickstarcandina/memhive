import { it, expect } from 'vitest';
import { setTomlBoolean, setTomlBooleanChecked } from '../../src/install/toml.js';
it('appends a table when missing', () =>
  expect(setTomlBoolean('model = "x"\n', '[features]', 'hooks', true)).toBe(
    'model = "x"\n\n[features]\nhooks = true\n'
  ));
it('updates an existing key in place and keeps the rest', () => {
  const src = '[features]\nhooks = false # keep\nother = 1\n\n[plugins."memhive@memhive-local"]\nenabled = false\n';
  const out = setTomlBoolean(
    setTomlBoolean(src, '[features]', 'hooks', true),
    '[plugins."memhive@memhive-local"]',
    'enabled',
    true
  );
  expect(out).toBe('[features]\nhooks = true\nother = 1\n\n[plugins."memhive@memhive-local"]\nenabled = true\n');
});
it('inserts a key into an existing table without the key', () =>
  expect(setTomlBoolean('[features]\nx = 1\n', '[features]', 'hooks', true)).toBe('[features]\nhooks = true\nx = 1\n'));
it('checked: multi-line array with a [ line is preserved', () => {
  const src = '[features]\nlist = [\n  [1, 2],\n]\n';
  expect(setTomlBooleanChecked(src, '[features]', 'hooks', true)).toBe(
    '[features]\nhooks = true\nlist = [\n  [1, 2],\n]\n'
  );
});
it('checked: refuses dotted and inline features forms', () => {
  expect(() => setTomlBooleanChecked('features.hooks = false\n', '[features]', 'hooks', true)).toThrow();
  expect(() => setTomlBooleanChecked('features = { hooks = false }\n', '[features]', 'hooks', true)).toThrow();
});
it('checked: refuses unparseable input', () =>
  expect(() => setTomlBooleanChecked('a = \n', '[features]', 'hooks', true)).toThrow());
it('checked: handles # inside a quoted table name', () => {
  const src = '[plugins."a#b"]\nenabled = false\n\n[plugins."memhive@x"]\nenabled = false\n';
  expect(setTomlBooleanChecked(src, '[plugins."memhive@x"]', 'enabled', true)).toBe(
    '[plugins."a#b"]\nenabled = false\n\n[plugins."memhive@x"]\nenabled = true\n'
  );
  expect(setTomlBooleanChecked(src, '[plugins."a#b"]', 'enabled', true)).toBe(
    '[plugins."a#b"]\nenabled = true\n\n[plugins."memhive@x"]\nenabled = false\n'
  );
});
it('edits a CRLF file whose edited line is the last line with no final newline', () => {
  expect(setTomlBooleanChecked('a = 1\r\n[plugins."m"]\r\nenabled = false', '[plugins."m"]', 'enabled', true)).toBe(
    'a = 1\r\n[plugins."m"]\r\nenabled = true'
  );
  expect(setTomlBooleanChecked('a = 1\r\n[plugins."m"]', '[plugins."m"]', 'enabled', true)).toBe(
    'a = 1\r\n[plugins."m"]\r\nenabled = true'
  );
  expect(setTomlBooleanChecked('[plugins."m"]\nenabled = false', '[plugins."m"]', 'enabled', true)).toBe(
    '[plugins."m"]\nenabled = true'
  );
  expect(setTomlBooleanChecked('a = 1\n[plugins."m"]', '[plugins."m"]', 'enabled', true)).toBe(
    'a = 1\n[plugins."m"]\nenabled = true'
  );
});
it('keeps CRLF line endings when inserting, replacing or appending', () => {
  expect(setTomlBoolean('[features]\r\nx = 1\r\n', '[features]', 'hooks', true)).toBe(
    '[features]\r\nhooks = true\r\nx = 1\r\n'
  );
  expect(setTomlBoolean('[features]\r\nhooks = false\r\n', '[features]', 'hooks', true)).toBe(
    '[features]\r\nhooks = true\r\n'
  );
  expect(setTomlBoolean('model = "x"\r\n', '[features]', 'hooks', true)).toBe(
    'model = "x"\r\n\r\n[features]\r\nhooks = true\r\n'
  );
});
it('refuses an edit that lands inside a multi-line string holding the table header', () => {
  const src = 'notes = """\n[features]\nhooks = true\n"""\n[features]\nhooks = false\n';
  expect(() => setTomlBooleanChecked(src, '[features]', 'hooks', false)).toThrow(/would change more than hooks/);
  // an existing empty table and a quoted header still edit fine
  expect(setTomlBooleanChecked('[features]\n', '[features]', 'hooks', true)).toBe('[features]\nhooks = true\n');
  expect(setTomlBooleanChecked('[plugins."memhive@m"]\nx = 1\n', '[plugins."memhive@m"]', 'enabled', true)).toBe(
    '[plugins."memhive@m"]\nenabled = true\nx = 1\n'
  );
});
