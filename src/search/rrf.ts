import type { SearchHit } from '../store/types.js';
export function rrf(lists: SearchHit[][], k = 60): SearchHit[] {
  const fused = new Map<string, number>();
  for (const list of lists)
    list.forEach((h, rank) => {
      fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (k + rank + 1));
    });
  return [...fused.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
