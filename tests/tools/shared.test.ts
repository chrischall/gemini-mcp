import { describe, it, expect } from 'vitest';
import { pickSeed } from '../../src/tools/shared.js';

describe('pickSeed', () => {
  it('returns the provided seed when given', () => {
    expect(pickSeed(42)).toBe(42);
    expect(pickSeed(0)).toBe(0);
    expect(pickSeed(2_147_483_646)).toBe(2_147_483_646);
  });

  it('returns a random non-negative integer when not provided', () => {
    const s = pickSeed(undefined);
    expect(typeof s).toBe('number');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2_147_483_647);
  });
});
