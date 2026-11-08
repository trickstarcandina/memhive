import { z } from 'zod';
import { OBSERVATION_TYPES, TOMBSTONE_TABLES } from '../store/types.js';

// Bumped on any incompatible change to these shapes, so a client can refuse a hub it does not speak to.
// 2: push carries tombstones (the owner deletes a row), pull relays them.
export const HUB_PROTOCOL = 2;

// Caps bound what one key can make every teammate's pull carry; a single row stays far below the default body limit.
export const MAX_SHORT = 1000;
export const MAX_LONG = 20_000;
export const MAX_LIST = 100;
export const MAX_ITEM = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const isIso = (v: unknown): v is string =>
  typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

// Lowercased: ids are compared as strings (tombstones, ownership), so `ABCD…` must not slip past a tombstone for `abcd…`.
const uuid = z
  .string()
  .regex(UUID_RE)
  .transform((s) => s.toLowerCase());
const iso = z.string().refine(isIso);
const short = z.string().max(MAX_SHORT);
const long = z.string().max(MAX_LONG);
const list = z.array(z.string().max(MAX_ITEM)).max(MAX_LIST);
const vector = z.array(z.number()).max(16_000); // zod 4 numbers are finite; the cap (pgvector's max dims) runs before the elements are checked
const origin = z.enum(['local', 'hub']);

// Fields the hub overwrites on push are never a reason to reject a row: any value is accepted and replaced.
const ignored = <T>(v: T) => z.unknown().transform((): T => v);
const pushOwned = { projectId: ignored(''), userId: ignored(''), syncedAt: ignored<string | null>(null) };

export const PushSessionSchema = z.object({
  id: uuid,
  ...pushOwned,
  origin: origin.optional().catch(undefined),
  host: short,
  hostSessionId: short,
  cwd: z.unknown().optional(), // cwd: older clients send it; never validated, stored or relayed
  startedAt: iso,
  endedAt: iso.nullable().optional(),
});
const obsFields = {
  id: uuid,
  sessionId: uuid,
  type: z.enum(OBSERVATION_TYPES),
  title: short,
  subtitle: short,
  facts: list,
  narrative: long,
  concepts: list,
  filesRead: list,
  filesModified: list,
  createdAt: iso,
};
export const PushObservationSchema = z.object({
  ...obsFields,
  ...pushOwned,
  origin: ignored<'local' | 'hub'>('local'),
  embeddingModel: short.nullable().default(null),
  embedding: vector.nullable().default(null),
});
const sumFields = {
  id: uuid,
  sessionId: uuid,
  request: long,
  learned: long,
  completed: long,
  nextSteps: long,
  createdAt: iso,
};
export const PushSummarySchema = z.object({ ...sumFields, ...pushOwned, origin: ignored<'local' | 'hub'>('local') });
export const PushTombstoneSchema = z.object({ id: uuid, tbl: z.enum(TOMBSTONE_TABLES), deleted_at: iso });
export const PushBodySchema = z.object({
  projectKey: short.min(1),
  projectName: short.optional(),
  sessions: z.array(PushSessionSchema).default([]),
  observations: z.array(PushObservationSchema).default([]),
  summaries: z.array(PushSummarySchema).default([]),
  tombstones: z.array(PushTombstoneSchema).default([]),
});
export const PushResultSchema = z.object({
  accepted: z.object({
    sessions: z.number(),
    observations: z.number(),
    summaries: z.number(),
    tombstones: z.number().optional(),
  }), // tombstones: protocol 2
  rejected: z.array(z.object({ id: z.string(), reason: z.string(), field: z.string().optional() })),
});

// Pull rows: the hub sends cwd as '' (older clients require the field); vectors=0 omits embedding.
export const HubSessionSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  userId: z.string(),
  host: z.string(),
  hostSessionId: z.string(),
  cwd: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  syncedAt: z.string().nullable().optional(),
});
export const HubObservationSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  sessionId: z.string(),
  userId: z.string(),
  type: z.enum(OBSERVATION_TYPES),
  title: z.string(),
  subtitle: z.string(),
  facts: z.array(z.string()),
  narrative: z.string(),
  concepts: z.array(z.string()),
  filesRead: z.array(z.string()),
  filesModified: z.array(z.string()),
  createdAt: z.string(),
  embeddingModel: z.string().nullable(),
  origin: origin.optional(),
  syncedAt: z.string().nullable().optional(),
  embedding: vector.nullable().optional(),
});
export const HubSummarySchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  sessionId: z.string(),
  userId: z.string(),
  request: z.string(),
  learned: z.string(),
  completed: z.string(),
  nextSteps: z.string(),
  createdAt: z.string(),
  origin: origin.optional(),
  syncedAt: z.string().nullable().optional(),
});
export const HubTombstoneSchema = z.object({ id: z.string(), tbl: z.enum(TOMBSTONE_TABLES), deleted_at: z.string() });
// max_seq: highest seq of the project, so a client whose cursor is past it knows the hub was reset; epoch: the hub project id,
// new when the hub was recreated (even one already past the client's cursor)
export const PullResultSchema = z.object({
  sessions: z.array(HubSessionSchema),
  observations: z.array(HubObservationSchema),
  summaries: z.array(HubSummarySchema),
  tombstones: z.array(HubTombstoneSchema).default([]),
  next_seq: z.number(),
  has_more: z.boolean(),
  max_seq: z.number(),
  epoch: z.string().optional(),
});
export const HubConfigInfoSchema = z.object({
  version: z.string(),
  protocol: z.number(),
  embedding_model: z.string().nullable(),
  embedding_dims: z.number().nullable(),
  body_limit: z.number(),
});
export const SearchResultSchema = z.object({ observations: z.array(HubObservationSchema.omit({ embedding: true })) });
export const MeResultSchema = z.object({ user: z.string() });
export const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type PushBody = z.infer<typeof PushBodySchema>;
export type PushResult = z.infer<typeof PushResultSchema>;
export type PullResult = z.infer<typeof PullResultSchema>;
export type HubConfigInfo = z.infer<typeof HubConfigInfoSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type MeResult = z.infer<typeof MeResultSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
