import type { Store, Project } from '../store/types.js';
import type { Observer, SessionCtx } from '../observer/observer.js';
import type { Embedder } from '../providers/types.js';
import type { Settings } from '../shared/settings.js';
import type { Logger } from '../shared/logger.js';
import type { HookEvent } from '../hooks/types.js';

export interface SyncHooks { pull(project: Project, timeoutMs: number): Promise<void>; schedulePush(projectId: string): void }
export interface DaemonContext {
  home: string; store: Store; observer: Observer; embedder: Embedder | null; settings: Settings; logger: Logger; userId: string;
  sync: SyncHooks | null;
  resolveSession(ev: HookEvent): { ctx: SessionCtx; project: Project };
}
