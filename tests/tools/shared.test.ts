import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSeed, emit, IMAGE_SIZES, sharedImageSchema } from '../../src/tools/shared.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-shared-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('IMAGE_SIZES', () => {
  it('includes 512 as the first entry (Flash-only 0.5K size)', () => {
    expect(IMAGE_SIZES).toContain('512');
    expect(IMAGE_SIZES[0]).toBe('512');
  });

  it('includes the full set 512, 1K, 2K, 4K', () => {
    expect(IMAGE_SIZES).toEqual(['512', '1K', '2K', '4K']);
  });

  it('sharedImageSchema image_size enum accepts 512', () => {
    const result = sharedImageSchema.image_size.parse('512');
    expect(result).toBe('512');
  });
});

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

describe('emit with meta', () => {
  it('merges meta into the disk-path result', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { output_dir: dir }, { model: 'gemini-3-pro-image', seed: 42 });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.model).toBe('gemini-3-pro-image');
    expect(parsed.seed).toBe(42);
    expect(parsed.images).toHaveLength(1);
  });

  it('prepends a text block for inline mode when meta present', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { inline: true }, { model: 'gemini-3-pro-image', seed: 99 });
    expect(res.content[0].type).toBe('text');
    const meta = JSON.parse((res.content[0] as { type: string; text: string }).text);
    expect(meta.seed).toBe(99);
    expect(res.content[1].type).toBe('image');
  });

  it('does not prepend text block for inline mode when no meta', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { inline: true });
    expect(res.content[0].type).toBe('image');
  });
});
