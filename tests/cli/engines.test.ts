import { it, expect } from 'vitest';
import { nodeVersionError } from '../../src/cli/index.js';

it('accepts Node 22 and later', () => {
  expect(nodeVersionError('22.0.0')).toBeNull();
  expect(nodeVersionError('24.11.1')).toBeNull();
});

it('rejects Node older than 22 with the found version', () => {
  expect(nodeVersionError('20.19.0')).toBe('memhive requires Node.js >= 22 (found v20.19.0)\n');
  expect(nodeVersionError('18.0.0')).toContain('>= 22');
});
