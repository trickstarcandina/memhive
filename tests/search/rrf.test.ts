import { it, expect } from 'vitest';
import { rrf } from '../../src/search/rrf.js';
it('fuses ranks, items in both lists win', () => {
  const out = rrf([
    [
      { id: 'a', score: 9 },
      { id: 'b', score: 8 },
    ],
    [
      { id: 'b', score: 1 },
      { id: 'c', score: 0.5 },
    ],
  ]);
  expect(out.map((h) => h.id)).toEqual(['b', 'a', 'c']);
});
it('handles empty lists', () => expect(rrf([[], []])).toEqual([]));
