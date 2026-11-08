import { it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs script without type declarations
import { toWeeks, niceStep, renderChart, THEMES } from '../../scripts/download-chart.mjs';

const days = (n: number) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), downloads: 1 }));

it('groups days into weeks counted back from the last day', () => {
  const w = toWeeks(days(10));
  expect(w.map((x: { downloads: number }) => x.downloads)).toEqual([3, 7]);
  expect(w[1]).toMatchObject({ start: '2026-10-04', end: '2026-10-10' });
});

it('picks round axis steps', () => {
  expect([niceStep(0), niceStep(7), niceStep(130), niceStep(4000)]).toEqual([1, 2, 50, 1000]);
});

it('renders an empty chart, and escapes text in a full one', () => {
  expect(renderChart({ weeks: [], releases: [], updated: '2026-11-08' }, THEMES.light)).toContain('No downloads recorded yet');
  const svg = renderChart({ weeks: toWeeks(days(21)), releases: [{ version: '1.0.0<x>', date: '2026-10-10' }], updated: '2026-10-21' }, THEMES.dark);
  expect(svg).toContain('21 total');
  expect(svg).toContain('v1.0.0&#60;x&#62;');
  expect(svg).not.toContain('<x>');
});
