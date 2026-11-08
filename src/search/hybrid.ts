import type { Embedder } from '../providers/types.js';
import type { Observation, SearchFilters, Store } from '../store/types.js';
import { rrf } from './rrf.js';

export async function hybridSearch(store: Store, embedder: Embedder | null, query: string, f: SearchFilters): Promise<Observation[]> {
  const wide = { ...f, limit: Math.max(f.limit, 50) };
  const fts = store.searchObservationsFts(query, wide);
  let vec: typeof fts = [];
  if (embedder && query.trim()) {
    try { const [v] = await embedder.embed([query]); vec = store.searchObservationsVector(v, wide); } catch { vec = []; }
  }
  const ids = rrf([fts, vec]).slice(0, f.limit).map((h) => h.id);
  return store.getObservations(ids);
}
