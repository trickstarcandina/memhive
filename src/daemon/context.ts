import type { Store, Project } from '../store/types.js';
import type { Observer, SessionCtx } from '../observer/observer.js';
import type { Embedder } from '../providers/types.js';
import type { Settings } from '../shared/settings.js';
import type { Logger } from '../shared/logger.js';
import type { HookEvent } from '../hooks/types.js';

export interface SyncHooks {
  pull(project: Project, timeoutMs: number): Promise<number>;
  schedulePush(projectId: string): void;
  syncNow(project: Project): Promise<{ pushed: { accepted: { sessions: number; observations: number; summaries: number }; rejected: Array<{ id: string; reason: string }> } | null; pulled: number }>;
  close(): void;
}
export interface DaemonContext {
  home: string; store: Store; observer: Observer; embedder: Embedder | null; settings: Settings; logger: Logger; userId: string;
  sync: SyncHooks | null;
  resolveSession(ev: HookEvent): { ctx: SessionCtx; project: Project };
  /** The user of the hub the project is linked to; else the default user (`userId`). */
  userFor(project: Project): string;
}
