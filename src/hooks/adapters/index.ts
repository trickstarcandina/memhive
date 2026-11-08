import type { HostAdapter } from '../types.js';
import { normalizeHookPayload, formatHookContext } from './normalize.js';

const CLAUDE_CODE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']);
// No PostCompact: Codex ignores its plain stdout and refuses unknown JSON fields; it re-runs SessionStart (source compact) instead.
const CODEX_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);

export const claudeCodeAdapter: HostAdapter = {
  host: 'claude-code',
  parse: (raw, now) => normalizeHookPayload(raw, 'claude-code', CLAUDE_CODE_EVENTS, now),
  formatContext: formatHookContext,
};
export const codexAdapter: HostAdapter = {
  host: 'codex',
  parse: (raw, now) => normalizeHookPayload(raw, 'codex', CODEX_EVENTS, now),
  formatContext: formatHookContext,
};

export function getAdapter(host: string): HostAdapter | null {
  if (host === 'claude-code') return claudeCodeAdapter;
  if (host === 'codex') return codexAdapter;
  return null;
}
