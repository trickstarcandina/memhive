import { shortId } from '../shared/ids.js';

export interface ForgetRow {
  id: string;
  kind: 'observation' | 'summary';
  type: string;
  title: string;
  userId: string;
  createdAt: string;
  local_only?: boolean;
}
export interface ForgetResult {
  deleted: ForgetRow[];
  not_owner: ForgetRow[];
  not_found: string[];
  propagates: boolean | null;
}
const line = (r: ForgetRow) => `#${shortId(r.id)} · ${r.type} · ${r.title.replace(/\s+/g, ' ').slice(0, 200)}`;
export function formatForget(r: ForgetResult, verb = 'Forgot'): string {
  const out: string[] = [];
  if (r.deleted.length) out.push(`${verb} ${r.deleted.length}:`, ...r.deleted.map(line));
  else out.push('Nothing was forgotten.');
  if (r.not_owner.length)
    out.push(
      'Not forgotten (recorded by someone else; only rows recorded on this machine can be forgotten):',
      ...r.not_owner.map(line)
    );
  if (r.not_found.length)
    out.push(
      `Not found in this project: ${r.not_found.map((x) => x.replace(/[^0-9a-f#-]/gi, '?').slice(0, 64)).join(', ')}`
    );
  const forced = r.deleted.filter((x) => x.local_only);
  if (forced.length)
    out.push(
      `${forced.length} of them (someone else's, --force) removed from this machine only; the hub and teammates keep them.`
    );
  if (forced.length < r.deleted.length)
    out.push(
      r.propagates === true
        ? 'The deletion is pushed to the hub and removed from teammates on their next pull.'
        : r.propagates === null
          ? 'The hub could not be reached; the deletion is queued and pushed once the hub answers (protocol 2 or later).'
          : 'Removed from this machine only (project not linked to a hub, or the hub is older than protocol 2: the deletion stays queued).'
    );
  return out.join('\n');
}
