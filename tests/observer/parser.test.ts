import { it, expect } from 'vitest';
import { parseObservations, parseSummary } from '../../src/observer/parser.js';
it('parses fenced json and validates types', () => {
  const r = parseObservations(
    '```json\n{"observations":[{"type":"bugfix","title":"t","facts":["a"],"files_modified":["x.ts"]},{"type":"nope","title":"bad"}]}\n```'
  )!;
  expect(r).toHaveLength(1);
  expect(r[0]).toEqual({
    type: 'bugfix',
    title: 't',
    subtitle: '',
    facts: ['a'],
    narrative: '',
    concepts: [],
    filesRead: [],
    filesModified: ['x.ts'],
  });
});
it('returns [] for empty list and null for garbage', () => {
  expect(parseObservations('{"observations":[]}')).toEqual([]);
  expect(parseObservations('not json')).toBeNull();
  expect(parseObservations('{"foo":1}')).toBeNull();
});
it('drops drafts without title', () => expect(parseObservations('{"observations":[{"type":"decision"}]}')).toEqual([]));
it('parses summary', () => {
  expect(parseSummary('{"request":"r","learned":"l","completed":"c","next_steps":"n"}')).toEqual({
    request: 'r',
    learned: 'l',
    completed: 'c',
    nextSteps: 'n',
  });
  expect(parseSummary('{}')).toBeNull();
});
// The prompt escapes & < > in recorded data; a model that copies from it would otherwise store the entities.
it('turns entities copied from the prompt back into text', () => {
  const [o] = parseObservations(
    JSON.stringify({
      observations: [
        {
          type: 'bugfix',
          title: 'Expiry check uses &lt;= not &lt;',
          facts: ['key was &lt;redacted&gt;', 'a &amp;&amp; b', 'literal &amp;lt; stays an entity'],
          narrative: 'x &gt; y',
          files_modified: ['src/a&amp;b.ts'],
        },
      ],
    })
  )!;
  expect(o.title).toBe('Expiry check uses <= not <');
  expect(o.facts).toEqual(['key was <redacted>', 'a && b', 'literal &lt; stays an entity']);
  expect(o.narrative).toBe('x > y');
  expect(o.filesModified).toEqual(['src/a&b.ts']);
  expect(parseSummary('{"request":"fix &lt;T&gt; &amp; co"}')!.request).toBe('fix <T> & co');
});
