import { describe, it, expect } from 'vitest';
import { buildContext } from '../../src/context/builder.js';
import { obs } from '../store/store-contract.js';
import type { Summary } from '../../src/store/types.js';

const now = new Date('2026-11-08T12:00:00Z');
const base = { projectName: 'app', observationCount: 0, sessionCount: 0, lastActivity: null, summaries: [] as Summary[], observations: [] as any[], budgetTokens: 2000, now };

describe('buildContext', () => {
  it('first session: header and footer only', () => {
    const c = buildContext(base);
    expect(c).toContain('memhub · app · 0 observations · 0 sessions');
    expect(c).toContain('search');
    expect(c.split('\n').length).toBeLessThan(8);
  });
  it('prioritizes decision/bugfix within 7 days, then the rest by date', () => {
    const o = (type: any, title: string, daysAgo: number) => obs({ projectId: 'p', sessionId: 's', type, title, createdAt: new Date(now.getTime() - daysAgo * 864e5).toISOString() });
    const c = buildContext({ ...base, observationCount: 4, sessionCount: 2, lastActivity: now.toISOString(), observations: [o('discovery', 'D-new', 1), o('bugfix', 'B-old', 20), o('decision', 'A-dec', 2), o('feature', 'F-mid', 5)] });
    const idx = (t: string) => c.indexOf(t);
    expect(idx('A-dec')).toBeLessThan(idx('D-new'));
    expect(idx('D-new')).toBeLessThan(idx('F-mid'));
    expect(idx('F-mid')).toBeLessThan(idx('B-old'));
    expect(c).toMatch(/#[0-9a-f]{8} · decision · A-dec · 2026-11-06 · local/);
  });
  it('respects the token budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => obs({ projectId: 'p', sessionId: 's', title: `title number ${i} ` + 'x'.repeat(60) }));
    const c = buildContext({ ...base, observationCount: 200, sessionCount: 9, observations: many, budgetTokens: 300 });
    expect(c.length).toBeLessThanOrEqual(300 * 4);
    expect(c).toContain('search');
  });
  it('includes up to 3 summaries with request and next steps', () => {
    const s = (i: number): Summary => ({ id: `s${i}`, projectId: 'p', sessionId: 's', userId: 'local', request: `req ${i}`, learned: '', completed: '', nextSteps: `next ${i}`, createdAt: now.toISOString(), origin: 'local', syncedAt: null });
    const c = buildContext({ ...base, summaries: [s(1), s(2), s(3), s(4)] });
    expect(c).toContain('req 1'); expect(c).toContain('next 3'); expect(c).not.toContain('req 4');
  });
});
