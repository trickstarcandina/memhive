import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
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
  it('tightens the mode of an existing looser file on save', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const file = path.join(home, 'settings.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    saveSettings(home, DEFAULT_SETTINGS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it('defaults the model per provider', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    expect(loadSettings(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://x/v1' }).llm.model).toBe('qwen2.5:7b');
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ llm: { provider: 'anthropic', model: 'claude-haiku-5-5' } }));
    expect(loadSettings(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat' }).llm.model).toBe('qwen2.5:7b');
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ llm: { provider: 'openai-compat', model: 'llama3' } }));
    expect(loadSettings(home, {}).llm.model).toBe('llama3');
    expect(loadSettings(home, { MEMHIVE_LLM_PROVIDER: 'anthropic' }).llm.model).toBe('claude-haiku-5-5');
  });
  it('env overrides file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const s = loadSettings(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://x/v1', MEMHIVE_LLM_MODEL: 'm', MEMHIVE_EMBED_BASE_URL: 'http://e/v1', MEMHIVE_EMBED_MODEL: 'bge-m3', MEMHIVE_EMBED_DIMS: '1024', MEMHIVE_CONTEXT_TOKENS: '500' });
    expect(s.llm).toEqual({ provider: 'openai-compat', model: 'm', baseUrl: 'http://x/v1', apiKey: undefined });
    expect(s.embed).toEqual({ baseUrl: 'http://e/v1', apiKey: undefined, model: 'bge-m3', dims: 1024 });
    expect(s.contextTokens).toBe(500);
  });
  it('ignores non-object sections in the file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), '{"llm":"x","embed":[1]}');
    const s = loadSettings(home, {});
    expect(s.llm).toEqual(DEFAULT_SETTINGS.llm);
    expect(s.embed).toBeNull();
  });
  it('returns defaults when the file is not a JSON object', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), '5');
    expect(loadSettings(home, {})).toEqual(DEFAULT_SETTINGS);
  });
  it('treats a partial embed config as unconfigured (empty url or model, dims 0)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ embed: { baseUrl: 'http://e/v1', model: 'bge-m3', dims: 768 } }));
    expect(loadSettings(home, { MEMHIVE_EMBED_BASE_URL: '' }).embed).toBeNull();
    expect(loadSettings(home, { MEMHIVE_EMBED_MODEL: '' }).embed).toBeNull();
    const h0 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(h0, 'settings.json'), JSON.stringify({ embed: { baseUrl: 'http://e/v1', model: 'bge-m3', dims: 0 } }));
    expect(loadSettings(h0, {}).embed).toBeNull();
    expect(loadSettings(mkdtempSync(path.join(tmpdir(), 'mh-')), { MEMHIVE_EMBED_DIMS: '1024' }).embed).toBeNull();
    expect(loadSettings(home, {}).embed).toMatchObject({ dims: 768 });
  });
  it('treats embed as unconfigured when dims is not a positive integer', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const s = loadSettings(home, { MEMHIVE_EMBED_BASE_URL: 'http://e/v1', MEMHIVE_EMBED_MODEL: 'bge-m3', MEMHIVE_EMBED_DIMS: 'abc' });
    expect(s.embed).toBeNull();
  });
  it('falls back to file dims when env dims is invalid', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ embed: { baseUrl: 'http://e/v1', model: 'bge-m3', dims: 768 } }));
    const s = loadSettings(home, { MEMHIVE_EMBED_DIMS: 'abc' });
    expect(s.embed).toEqual({ baseUrl: 'http://e/v1', apiKey: undefined, model: 'bge-m3', dims: 768 });
  });
  it('context.includeOtherUsers: default true, file key, env 0 disables', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    expect(loadSettings(home, {}).context.includeOtherUsers).toBe(true);
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ context: { includeOtherUsers: false } }));
    expect(loadSettings(home, {}).context.includeOtherUsers).toBe(false);
    expect(loadSettings(home, { MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS: '1' }).context.includeOtherUsers).toBe(true);
    rmSync(path.join(home, 'settings.json'));
    expect(loadSettings(home, { MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS: '0' }).context.includeOtherUsers).toBe(false);
  });
  it('excludeProjects: file list, env comma list wins, junk entries dropped', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ excludeProjects: ['github.com/a/*', 3, ' ', 'x'] }));
    expect(loadSettings(home, {}).excludeProjects).toEqual(['github.com/a/*', 'x']);
    expect(loadSettings(home, { MEMHIVE_EXCLUDE_PROJECTS: ' p/** , q ,' }).excludeProjects).toEqual(['p/**', 'q']);
  });
});
