import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../../src/shared/settings.js';

describe('settings', () => {
  it('returns defaults when no file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    expect(loadSettings(home, {})).toEqual(DEFAULT_SETTINGS);
  });
  it('round-trips and is private', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    saveSettings(home, { ...DEFAULT_SETTINGS, contextTokens: 999 });
    expect(loadSettings(home, {}).contextTokens).toBe(999);
    expect(statSync(path.join(home, 'settings.json')).mode & 0o777).toBe(0o600);
  });
  it('env overrides file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const s = loadSettings(home, { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://x/v1', MEMHUB_LLM_MODEL: 'm', MEMHUB_EMBED_BASE_URL: 'http://e/v1', MEMHUB_EMBED_MODEL: 'bge-m3', MEMHUB_EMBED_DIMS: '1024', MEMHUB_CONTEXT_TOKENS: '500' });
    expect(s.llm).toEqual({ provider: 'openai-compat', model: 'm', baseUrl: 'http://x/v1', apiKey: undefined });
    expect(s.embed).toEqual({ baseUrl: 'http://e/v1', apiKey: undefined, model: 'bge-m3', dims: 1024 });
    expect(s.contextTokens).toBe(500);
  });
});
