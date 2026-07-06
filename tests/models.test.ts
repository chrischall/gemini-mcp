import { describe, it, expect } from 'vitest';
import { DEFAULT_IMAGE_MODEL, resolveModel, filterImageModels } from '../src/models.js';

describe('DEFAULT_IMAGE_MODEL', () => {
  it('defaults to the generalist workhorse (Nano Banana 2), not the premium Pro model', () => {
    expect(DEFAULT_IMAGE_MODEL).toBe('gemini-3.1-flash-image');
  });
});

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
  it('keeps only Gemini image models and strips the models/ prefix', () => {
    const raw = [
      { name: 'models/gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' },
      { name: 'models/gemini-2.5-flash', displayName: 'Flash', description: 'text' },
      { name: 'models/gemini-3.1-flash-image', displayName: 'Flash Image', description: 'fast' },
    ];
    const out = filterImageModels(raw);
    expect(out.map((m) => m.id)).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
    expect(out[0]).toEqual({ id: 'gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' });
  });

  it('excludes imagen-* models (substring "image" but a different :predict API)', () => {
    const raw = [
      { name: 'models/gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' },
      { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', description: 'imagen' },
      { name: 'models/imagen-4.0-ultra-generate-001', displayName: 'Imagen 4 Ultra', description: 'imagen' },
    ];
    expect(filterImageModels(raw).map((m) => m.id)).toEqual(['gemini-3-pro-image']);
  });
});
