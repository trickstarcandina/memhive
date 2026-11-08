import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getAdapter } from '../../src/hooks/adapters/index.js';

const fx = (host: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${host}/${name}.json`, import.meta.url), 'utf8'));
const now = new Date('2026-11-08T10:00:00Z');

describe('claude-code adapter', () => {
  const a = getAdapter('claude-code')!;
  it('session start', () => {
    expect(a.parse(fx('claude-code', 'session-start'), now)).toEqual({
      host: 'claude-code',
      hostEvent: 'SessionStart',
      hostSessionId: 'cc-1',
      cwd: '/work/app',
      event: 'session-start',
      source: 'startup',
      at: now.toISOString(),
    });
  });
  it('prompt is sanitized', () => {
    expect(a.parse(fx('claude-code', 'user-prompt-submit'), now)!.prompt).toBe('fix login bug');
  });
  it('tool use', () => {
    const e = a.parse(fx('claude-code', 'post-tool-use'), now)!;
    expect(e.event).toBe('tool');
    expect(e.tool).toEqual({
      name: 'Edit',
      input: { file_path: '/work/app/src/auth.ts', old_string: 'a', new_string: 'b' },
      output: { success: true },
      failed: false,
    });
  });
  it('a private block opened in tool_input hides tool_response up to its close', () => {
    const e = a.parse(
      {
        session_id: 's',
        cwd: '/w',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo <private>' },
        tool_response: { stdout: 'secret</private> ok' },
      },
      now
    )!;
    expect(e.tool).toMatchObject({ input: { command: 'echo ' }, output: { '': ' ok' } }); // the key is inside the block too
  });
  it('tool failure', () => {
    const e = a.parse(fx('claude-code', 'post-tool-use-failure'), now)!;
    expect(e.tool).toEqual({
      name: 'Bash',
      input: { command: 'npm test' },
      output: { error: 'exit 1', is_interrupt: false },
      failed: true,
    });
  });
  it('stop and session-end', () => {
    expect(a.parse(fx('claude-code', 'stop'), now)!.event).toBe('stop');
    expect(a.parse(fx('claude-code', 'session-end'), now)!.event).toBe('session-end');
  });
  it('rejects missing session_id, unknown event, non-object', () => {
    expect(a.parse({ cwd: '/x', hook_event_name: 'Stop' }, now)).toBeNull();
    expect(a.parse({ session_id: 's', cwd: '/x', hook_event_name: 'PreToolUse' }, now)).toBeNull();
    expect(a.parse('nope', now)).toBeNull();
    expect(a.parse(null, now)).toBeNull();
  });
  it('formats context for SessionStart', () => {
    const e = a.parse(fx('claude-code', 'session-start'), now)!;
    expect(JSON.parse(a.formatContext(e, 'CTX'))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CTX' },
    });
  });
});

describe('codex adapter', () => {
  const a = getAdapter('codex')!;
  it('PostCompact is ignored: Codex re-runs SessionStart with source compact after compacting', () => {
    expect(a.parse(fx('codex', 'post-compact'), now)).toBeNull();
    const e = a.parse(
      { session_id: 'cx-1', cwd: '/work/app', hook_event_name: 'SessionStart', source: 'compact' },
      now
    )!;
    expect(e.event).toBe('session-start');
    expect(e.source).toBe('compact');
    expect(JSON.parse(a.formatContext(e, 'C')).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
  it('apply_patch tool use', () => {
    const e = a.parse(fx('codex', 'post-tool-use'), now)!;
    expect(e.tool!.name).toBe('apply_patch');
    expect(e.tool!.failed).toBe(false);
  });
  it('ignores events Codex does not send', () => {
    expect(a.parse({ session_id: 's', cwd: '/x', hook_event_name: 'SessionEnd' }, now)).toBeNull();
  });
});

it('getAdapter returns null for unknown host', () => expect(getAdapter('vim')).toBeNull());
