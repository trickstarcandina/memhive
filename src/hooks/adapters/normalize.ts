import type { Host, HookEvent, HookEventKind, SessionSource } from '../types.js';
import { sanitizePrompt, sanitizeToolPayload } from '../sanitize.js';

const KIND: Record<string, HookEventKind> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  PostToolUseFailure: 'tool',
  Stop: 'stop',
  SessionEnd: 'session-end',
};
const SOURCES = new Set<SessionSource>(['startup', 'resume', 'clear', 'compact']);

export function normalizeHookPayload(
  raw: unknown,
  host: Host,
  allowed: ReadonlySet<string>,
  now = new Date()
): HookEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const hostEvent = typeof r.hook_event_name === 'string' ? r.hook_event_name : '';
  const kind = KIND[hostEvent];
  if (!kind || !allowed.has(hostEvent)) return null;
  const hostSessionId = typeof r.session_id === 'string' && r.session_id ? r.session_id : null;
  const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : process.cwd();
  if (!hostSessionId) return null;

  const ev: HookEvent = { host, hostEvent, hostSessionId, cwd, event: kind, at: now.toISOString() };
  if (kind === 'session-start') {
    if (typeof r.source === 'string' && SOURCES.has(r.source as SessionSource)) ev.source = r.source as SessionSource;
  }
  if (kind === 'prompt' && typeof r.prompt === 'string') ev.prompt = sanitizePrompt(r.prompt);
  if (kind === 'tool') {
    const name = typeof r.tool_name === 'string' ? r.tool_name : 'unknown';
    const failed = hostEvent === 'PostToolUseFailure';
    const output = failed ? { error: r.error, is_interrupt: r.is_interrupt === true } : r.tool_response;
    const state = { depth: 0 }; // shared: a private block opened in the input also hides the output
    ev.tool = {
      name,
      input: sanitizeToolPayload(r.tool_input, undefined, state),
      output: sanitizeToolPayload(output, undefined, state),
      failed,
    };
  }
  return ev;
}

export function formatHookContext(event: HookEvent, context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event.hostEvent, additionalContext: context } });
}
