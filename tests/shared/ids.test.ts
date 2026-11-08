import { describe, it, expect } from 'vitest';
import { newId, shortId } from '../../src/shared/ids.js';

describe('ids', () => {
  it('newId is a UUID v7', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('shortId differs for back-to-back ids', () => {
    const a = newId(), b = newId();
    expect(shortId(a)).toHaveLength(8);
    expect(shortId(a)).not.toBe(shortId(b));
  });
});
