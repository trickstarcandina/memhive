import { shortId } from '../shared/ids.js';
import type { Observation } from '../store/types.js';

const est = (o: Observation) => Math.ceil((o.title.length + o.subtitle.length + o.narrative.length + o.facts.join(' ').length) / 4);
// Stored text is data: keep each field on one line (control chars incl. newlines become spaces).
const line = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

export function formatIndex(obs: Observation[]): string {
  if (obs.length === 0) return 'No observations found.';
  const rows = obs.map((o) => `| #${shortId(o.id)} | ${o.createdAt.slice(0, 16).replace('T', ' ')} | ${line(o.type)} | ${line(o.title).replace(/\|/g, '/')} | ${line(o.userId).replace(/\|/g, '/')} | ~${est(o)} |`);
  return ['| ID | Time | Type | Title | User | ~tokens |', '|----|------|------|-------|------|---------|', ...rows].join('\n');
}

export function formatFull(obs: Observation[]): string {
  if (obs.length === 0) return 'No observations found.';
  return obs.map((o) => [`## #${shortId(o.id)} · ${line(o.type)} · ${line(o.title)}`, o.subtitle && `_${line(o.subtitle)}_`, `${o.createdAt} · ${line(o.userId)}`,
    o.facts.length && ['', 'Facts:', ...o.facts.map((f) => `- ${f}`)].join('\n'), o.narrative && `\n${o.narrative}`,
    o.concepts.length && `\nConcepts: ${o.concepts.join(', ')}`, o.filesModified.length && `Files modified: ${o.filesModified.join(', ')}`, o.filesRead.length && `Files read: ${o.filesRead.join(', ')}`]
    .filter(Boolean).join('\n')).join('\n\n---\n\n');
}
