import type { Observation, Summary } from '../store/types.js';
import { shortId } from '../shared/ids.js';

export interface ContextInput { projectName: string; observationCount: number; sessionCount: number; lastActivity: string | null; summaries: Summary[]; observations: Observation[]; budgetTokens: number; now?: Date }

const FOOTER = ['Use the memhub MCP tools before re-discovering past work: search(query) → timeline(anchor_id) → get_observations(ids).', 'Observation ids above are 8-char short ids; pass them as-is.'];
const day = (iso: string) => iso.slice(0, 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function buildContext(input: ContextInput): string {
  const now = input.now ?? new Date();
  const budgetChars = input.budgetTokens * 4;
  const header = `memhub · ${input.projectName} · ${input.observationCount} observations · ${input.sessionCount} sessions${input.lastActivity ? ` · last ${day(input.lastActivity)}` : ''}`;
  const lines: string[] = [header];

  const summaries = input.summaries.slice(0, 3);
  if (summaries.length) {
    lines.push('', 'Recent sessions:');
    for (const s of summaries) lines.push(`- [${day(s.createdAt)}] ${clip(s.request, 300)}${s.nextSteps ? ` → next: ${clip(s.nextSteps, 300)}` : ''}`);
  }

  const weekAgo = now.getTime() - 7 * 864e5;
  const recent = (o: Observation) => Date.parse(o.createdAt) >= weekAgo;
  const important = (o: Observation) => o.type === 'decision' || o.type === 'bugfix';
  const byDate = (a: Observation, b: Observation) => b.createdAt.localeCompare(a.createdAt);
  const ordered = [
    ...input.observations.filter((o) => recent(o) && important(o)).sort(byDate),
    ...input.observations.filter((o) => recent(o) && !important(o)).sort(byDate),
    ...input.observations.filter((o) => !recent(o)).sort(byDate),
  ].slice(0, 30);

  const footerText = ['', ...FOOTER].join('\n');
  let used = lines.join('\n').length + footerText.length;
  if (ordered.length) {
    const title = '\nObservations (newest and most important first):';
    if (used + title.length < budgetChars) { lines.push(title); used += title.length + 1; }
    for (const o of ordered) {
      const line = `#${shortId(o.id)} · ${o.type} · ${clip(o.title, 90)} · ${day(o.createdAt)} · ${o.userId}`;
      if (used + line.length + 1 > budgetChars) break;
      lines.push(line); used += line.length + 1;
    }
  }
  return lines.join('\n') + footerText;
}
