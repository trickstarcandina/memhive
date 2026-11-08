import { OBSERVATION_TYPES, type ObservationType } from '../store/types.js';
import { safeJsonParse } from '../shared/json.js';

export interface ObservationDraft { type: ObservationType; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[]; filesRead: string[]; filesModified: string[] }
export interface SummaryDraft { request: string; learned: string; completed: string; nextSteps: string }

function extractJson(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const direct = safeJsonParse(candidate);
  if (direct !== undefined) return direct;
  const start = candidate.indexOf('{'); const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? safeJsonParse(candidate.slice(start, end + 1)) : undefined;
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);

export function parseObservations(text: string): ObservationDraft[] | null {
  const j = extractJson(text) as any;
  if (!j || !Array.isArray(j.observations)) return null;
  const out: ObservationDraft[] = [];
  for (const o of j.observations) {
    if (!o || typeof o !== 'object') continue;
    const title = str(o.title, 200);
    if (!title || !OBSERVATION_TYPES.includes(o.type)) continue;
    out.push({ type: o.type, title, subtitle: str(o.subtitle, 300), facts: strs(o.facts), narrative: str(o.narrative, 2000), concepts: strs(o.concepts), filesRead: strs(o.files_read), filesModified: strs(o.files_modified) });
  }
  return out;
}

export function parseSummary(text: string): SummaryDraft | null {
  const j = extractJson(text) as any;
  if (!j || typeof j !== 'object') return null;
  const s: SummaryDraft = { request: str(j.request, 1000), learned: str(j.learned, 2000), completed: str(j.completed, 2000), nextSteps: str(j.next_steps ?? j.nextSteps, 1000) };
  return s.request || s.learned || s.completed || s.nextSteps ? s : null;
}
