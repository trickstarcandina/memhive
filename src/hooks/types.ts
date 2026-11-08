export type Host = 'claude-code' | 'codex';
export type HookEventKind = 'session-start' | 'prompt' | 'tool' | 'stop' | 'session-end';
export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact';

export interface HookEvent {
  host: Host;
  hostEvent: string;
  hostSessionId: string;
  cwd: string;
  event: HookEventKind;
  source?: SessionSource;
  prompt?: string;
  tool?: { name: string; input: unknown; output?: unknown; failed?: boolean };
  at: string;
}

export interface HostAdapter {
  host: Host;
  parse(raw: unknown, now?: Date): HookEvent | null;
  formatContext(event: HookEvent, context: string): string;
}
