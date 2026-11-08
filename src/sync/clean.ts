import { MAX_ITEM, MAX_LIST, MAX_LONG, MAX_SHORT } from '../hub/wire.js';
import { redactSecrets, stripPrivate } from '../hooks/sanitize.js';

// Rows that come from elsewhere (a hub pull, an import file) pass through here before they are stored: redacted, private
// blocks dropped, and clipped to the hub's caps rather than rejected, so an older hub's longer rows still arrive.
export const safeText = (v: string, n: number) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, n);
// The author name is shown in context and MCP output: no control characters, bounded.
export const cleanUser = (v: string) => safeText(redactSecrets(v), 200);
export const cut = (v: string, n: number) => redactSecrets(stripPrivate(v)).slice(0, n);
export const cutList = (l: string[]) => l.slice(0, MAX_LIST).map((v) => cut(v, MAX_ITEM));

export const cleanSession = <T extends { userId: string; host: string; hostSessionId: string }>(s: T): T => ({
  ...s,
  userId: cleanUser(s.userId),
  host: cut(s.host, MAX_SHORT),
  hostSessionId: cut(s.hostSessionId, MAX_SHORT),
});
export const cleanObservation = <
  T extends {
    userId: string;
    title: string;
    subtitle: string;
    narrative: string;
    facts: string[];
    concepts: string[];
    filesRead: string[];
    filesModified: string[];
  },
>(
  o: T
): T => ({
  ...o,
  userId: cleanUser(o.userId),
  title: cut(o.title, MAX_SHORT),
  subtitle: cut(o.subtitle, MAX_SHORT),
  narrative: cut(o.narrative, MAX_LONG),
  facts: cutList(o.facts),
  concepts: cutList(o.concepts),
  filesRead: cutList(o.filesRead),
  filesModified: cutList(o.filesModified),
});
export const cleanSummary = <
  T extends { userId: string; request: string; learned: string; completed: string; nextSteps: string },
>(
  m: T
): T => ({
  ...m,
  userId: cleanUser(m.userId),
  request: cut(m.request, MAX_LONG),
  learned: cut(m.learned, MAX_LONG),
  completed: cut(m.completed, MAX_LONG),
  nextSteps: cut(m.nextSteps, MAX_LONG),
});
