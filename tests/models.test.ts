import { describe, it, expect } from 'vitest';
import { DEFAULT_IMAGE_MODEL, resolveModel, filterImageModels } from '../src/models.js';

describe('DEFAULT_IMAGE_MODEL', () => {
  it('defaults to the generalist workhorse (Nano Banana 2.1), not the premium Pro model', () => {
    // gemini-3.1-flash-image (Nano Banana 2) was deprecated 2026-10-06 in
    // favour of gemini-nano-banana-2.1.
    expect(DEFAULT_IMAGE_MODEL).toBe('gemini-nano-banana-2.1');
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

  it('keeps nano-banana ids, which carry no "image" substring', () => {
    // gemini-nano-banana-2.1 is the DEFAULT model: a filter that keys on
    // "image" alone would hide it from gemini_list_models.
    const raw = [
      { name: 'models/gemini-nano-banana-2.1', displayName: 'Nano Banana 2.1', description: 'nb' },
      { name: 'models/gemini-3.8-flash', displayName: 'Flash', description: 'text' },
    ];
    expect(filterImageModels(raw).map((m) => m.id)).toEqual(['gemini-nano-banana-2.1']);
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
