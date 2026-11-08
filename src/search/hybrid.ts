import type { Embedder } from '../providers/types.js';
import type { SearchFilters, SearchResult, Store } from '../store/types.js';
import { rrf } from './rrf.js';

/** Observations (FTS + vectors) and session summaries (FTS), fused into one ranking by reciprocal rank fusion. */
export async function hybridSearch(store: Store, embedder: Embedder | null, query: string, f: SearchFilters): Promise<SearchResult[]> {
  const wide = { ...f, limit: Math.max(f.limit, 50) };
  const fts = store.searchObservationsFts(query, wide);
  let vec: typeof fts = [];
  if (embedder && query.trim()) {
    try { const [v] = await embedder.embed([query]); vec = store.searchObservationsVector(v, wide); } catch { vec = []; }
  }
  const sums = f.type ? [] : store.searchSummariesFts(query, wide);   // summaries have no type
  const ids = rrf([fts, vec, sums]).slice(0, f.limit).map((h) => h.id);
  const obs = new Map(store.getObservations(ids).map((o) => [o.id, { ...o, kind: 'observation' as const }]));
  const sum = new Map(store.getSummaries(ids.filter((id) => !obs.has(id))).map((s) => [s.id, { ...s, kind: 'summary' as const }]));
  return ids.map((id) => obs.get(id) ?? sum.get(id)).filter((r): r is SearchResult => !!r);
}
