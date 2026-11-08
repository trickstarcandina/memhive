import type { Store, Project } from '../store/types.js';
import type { Observer, SessionCtx } from '../observer/observer.js';
import type { Embedder } from '../providers/types.js';
import type { Settings } from '../shared/settings.js';
import type { Logger } from '../shared/logger.js';
import type { HookEvent } from '../hooks/types.js';
import type { ProjectInfo } from '../shared/project-key.js';

export interface SyncHooks {
  pull(project: Project, timeoutMs: number): Promise<number>;
  /** Session start: pulls in the background; waits briefly only for a project that was never pulled. Never throws. */
  startPull(project: Project): Promise<void>;
  schedulePush(projectId: string): void;
  /** Project ids whose push keeps failing with a 404 or a bare 4xx. */
  blockedProjects?(): string[];
  /** Hubs this client refuses to sync with (protocol newer than ours). */
  hubErrors?(): Array<{ hub: string; error: string }>;
  /** The linked hub's sync protocol, or null when unknown (decides whether a forget reaches the team). */
  hubProtocol?(project: Project): Promise<number | null>;
  syncNow(project: Project): Promise<{ pushed: { accepted: { sessions: number; observations: number; summaries: number }; rejected: Array<{ id: string; reason: string }> } | null; pulled: number; error?: string }>;
  close(): void | Promise<void>;
}
export interface DaemonContext {
  home: string; store: Store; observer: Observer; embedder: Embedder | null; settings: Settings; logger: Logger; userId: string;
  sync: SyncHooks | null;
  /** null: memhive is paused or disabled, or the project is excluded; the event must not be recorded. */
  resolveSession(ev: HookEvent): { ctx: SessionCtx; project: Project; branch: string | null } | null;
  /** Epoch ms the pause ends (Infinity: until resume), or null; MEMHIVE_DISABLED in the daemon's env counts as Infinity. */
  pausedUntil(): number | null;
  /** Exclusion by settings.excludeProjects or `.memhive.json` for a working directory (spawns git). */
  excludedCwd(cwd: string): boolean;
  excludedInfo(info: ProjectInfo): boolean;   // same, for a key already resolved
  /** The user of the hub the project is linked to; else the default user (`userId`). */
  userFor(project: Project): string;
}
