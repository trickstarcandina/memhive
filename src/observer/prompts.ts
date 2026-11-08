import { OBSERVATION_TYPES } from '../store/types.js';
import type { ToolEvent } from './session-buffer.js';

export const OBSERVER_SYSTEM = `You are a note-taker watching a coding agent work. From a batch of tool calls, write zero or more short observations that a teammate would want to remember next week: decisions and why, bugs and their fixes, discoveries about how the code works, config changes, problems and workarounds.
Rules: skip routine reads and trivial edits; never repeat an observation already listed; one observation per distinct fact; be concrete (file names, function names, values); never include secrets.
Types: ${OBSERVATION_TYPES.join(' | ')}.
Respond with JSON only: {"observations":[{"type":"...","title":"<= 80 chars","subtitle":"<= 120 chars","facts":["..."],"narrative":"1-3 sentences","concepts":["kebab-case tags"],"files_read":[],"files_modified":[]}]}
Return {"observations":[]} when nothing is worth remembering.`;

const cut = (v: unknown, max = 4000): string => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > max ? s.slice(0, max) + `…<${s.length - max} more chars>` : s; };

export function buildObservationPrompt(input: { projectName: string; prompt: string | null; recentTitles: string[]; events: ToolEvent[] }): string {
  const lines = [`<project>${input.projectName}</project>`];
  if (input.prompt) lines.push(`<user_request>${cut(input.prompt, 2000)}</user_request>`);
  if (input.recentTitles.length) lines.push(`<already_observed>\n${input.recentTitles.map((t) => `- ${t}`).join('\n')}\n</already_observed>`);
  lines.push('<tool_calls>');
  for (const e of input.events) lines.push(`<call name="${e.name}" at="${e.at}"${e.failed ? ' failed="true"' : ''}>\n<input>${cut(e.input)}</input>\n<output>${cut(e.output)}</output>\n</call>`);
  lines.push('</tool_calls>');
  return lines.join('\n');
}

export const SUMMARY_SYSTEM = `You summarize one turn of a coding agent for the next session. Respond with JSON only: {"request":"what the user asked, 1 sentence","learned":"key things discovered, <= 3 sentences","completed":"what was done, <= 3 sentences","next_steps":"what remains or is suggested, <= 2 sentences"}. Use empty strings when unknown.`;

export function buildSummaryPrompt(input: { projectName: string; prompt: string | null; observations: Array<{ title: string; facts: string[] }> }): string {
  return [`<project>${input.projectName}</project>`, `<user_request>${cut(input.prompt ?? '', 2000)}</user_request>`,
    '<observations>', ...input.observations.map((o) => `- ${o.title}: ${o.facts.join('; ')}`), '</observations>'].join('\n');
}
