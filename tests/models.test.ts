import { describe, it, expect } from 'vitest';
import { DEFAULT_IMAGE_MODEL, resolveModel, filterImageModels } from '../src/models.js';

describe('resolveModel', () => {
  it('prefers per-call over env over default', () => {
    expect(resolveModel('a', 'b')).toBe('a');
    expect(resolveModel(undefined, 'b')).toBe('b');
    expect(resolveModel(undefined, undefined)).toBe(DEFAULT_IMAGE_MODEL);
  });
  it('treats blank strings as unset', () => {
    expect(resolveModel('  ', '')).toBe(DEFAULT_IMAGE_MODEL);
  });
});

describe('filterImageModels', () => {
  it('keeps only image models and strips the models/ prefix', () => {
    const raw = [
      { name: 'models/gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' },
      { name: 'models/gemini-2.5-flash', displayName: 'Flash', description: 'text' },
      { name: 'models/gemini-3.1-flash-image', displayName: 'Flash Image', description: 'fast' },
    ];
    const out = filterImageModels(raw);
    expect(out.map((m) => m.id)).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
    expect(out[0]).toEqual({ id: 'gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' });
  });
});
