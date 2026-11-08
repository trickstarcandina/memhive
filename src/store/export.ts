import { z } from 'zod';
import { OBSERVATION_TYPES } from './types.js';
import { MAX_ITEM, MAX_LIST, MAX_LONG, MAX_SHORT, isIso } from '../hub/wire.js';

// One line of `memhive export --format jsonl`, read back by `memhive import`. The file may come from anywhere, so every
// field is checked; projectId and syncedAt are never taken from it (the import decides both).
const id = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i).transform((s) => s.toLowerCase());
const iso = z.string().refine(isIso);
const short = z.string().max(MAX_SHORT);
const long = z.string().max(MAX_LONG);
const list = z.array(z.string().max(MAX_ITEM)).max(MAX_LIST);
const origin = z.enum(['local', 'hub']).default('local');
const user = z.string().min(1).max(200);

export const ExportRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), key: short, name: short.optional() }),
  z.object({ kind: z.literal('session'), id, userId: user, host: short, hostSessionId: short, cwd: short.default(''), startedAt: iso, endedAt: iso.nullable().default(null), origin, branch: short.nullable().optional() }),
  z.object({
    kind: z.literal('observation'), id, sessionId: id, userId: user, type: z.enum(OBSERVATION_TYPES), title: short, subtitle: short.default(''), facts: list, narrative: long.default(''),
    concepts: list.default([]), filesRead: list.default([]), filesModified: list.default([]), createdAt: iso, origin, pinned: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('summary'), id, sessionId: id, userId: user, request: long, learned: long, completed: long, nextSteps: long, createdAt: iso, origin }),
]);
export type ExportRow = z.infer<typeof ExportRowSchema>;
export const EXPORT_TABLES = { session: 'sessions', observation: 'observations', summary: 'summaries' } as const;
