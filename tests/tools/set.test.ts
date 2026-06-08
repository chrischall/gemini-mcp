import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerSetTools } from '../../src/tools/set.js';
import { client } from '../../src/client.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-set-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_generate_set (master mode)', () => {
  it('generates a master then one image per scene referencing the master', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'a cartoon fox named Rusty, orange fur, blue scarf',
      scenes: ['Rusty waving', 'Rusty eating an apple'],
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(data.images).toHaveLength(3); // master + 2 scenes
    expect(data.images.map((p) => basename(p))).toEqual(
      expect.arrayContaining([expect.stringContaining('-master.'), expect.stringContaining('-01.'), expect.stringContaining('-02.')]),
    );
    // master generated with no reference image; each scene references exactly the master
    expect(spy.mock.calls[0][0].images).toBeUndefined();
    expect(spy.mock.calls[1][0].images).toHaveLength(1);
    expect(spy.mock.calls[2][0].images).toHaveLength(1);
    await h.close();
  });

  it('rejects when neither scenes nor count provided', async () => {
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', { master_prompt: 'x' });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('rejects an empty scenes array (would otherwise silently yield only a master)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', { master_prompt: 'x', scenes: [] });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // rejected at schema validation, no master generated
    await h.close();
  });
});

describe('gemini_generate_set master_images_base64', () => {
  it('passes master_images_base64 as input images to the master generate call', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    await h.callTool('gemini_generate_set', {
      master_prompt: 'a cartoon fox',
      scenes: ['waving'],
      master_images_base64: [PNG],
      output_dir: dir,
    });
    // First call (master) should have images; subsequent scene calls also have images (the master output)
    expect(spy.mock.calls[0][0].images).toHaveLength(1);
    await h.close();
  });
});

describe('gemini_generate_set metadata', () => {
  it('includes model and seed in result', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'fox',
      scenes: ['waving'],
      output_dir: dir,
      seed: 100,
    });
    const data = parseToolResult<{ images: string[]; seed: number; model: string }>(res);
    expect(data.seed).toBe(100);
    expect(typeof data.model).toBe('string');
    await h.close();
  });
});

describe('gemini_generate_set basename param', () => {
  it('uses caller-supplied basename instead of slugified master_prompt', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'a cartoon fox',
      scenes: ['scene 1'],
      basename: 'my-fox-set',
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    // master file should use basename
    expect(basename(data.images[0])).toContain('my-fox-set-master');
    expect(basename(data.images[1])).toContain('my-fox-set-01');
    await h.close();
  });
});

describe('gemini_generate_set google_search passthrough', () => {
  it('passes google_search:true to client.generate as googleSearch', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    await h.callTool('gemini_generate_set', {
      master_prompt: 'fox',
      scenes: ['waving'],
      google_search: true,
      output_dir: dir,
    });
    // All calls (master + scene) should have googleSearch
    for (const call of spy.mock.calls) {
      expect(call[0]).toMatchObject({ googleSearch: true });
    }
    await h.close();
  });

  it('surfaces meta.grounding from master call when client returns grounding', async () => {
    let callCount = 0;
    vi.spyOn(client, 'generate').mockImplementation(async () => {
      callCount++;
      // Only master (first call) returns grounding
      const grounding = callCount === 1
        ? { queries: ['fox facts'], sources: [{ uri: 'https://example.com', title: 'Foxes' }] }
        : undefined;
      return { images: [{ base64: PNG, mimeType: 'image/png' }], grounding };
    });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'fox',
      scenes: ['waving'],
      google_search: true,
      output_dir: dir,
    });
    const data = parseToolResult<{ grounding?: { queries?: string[] } }>(res);
    expect(data.grounding?.queries).toEqual(['fox facts']);
    await h.close();
  });
});

// Task 13: lock chain-mode referencing + count-variation behavior
describe('gemini_generate_set (chain mode + count)', () => {
  it('chain mode references the previous image each step', async () => {
    let n = 0;
    const spy = vi.spyOn(client, 'generate').mockImplementation(async () => {
      n += 1;
      return { images: [{ base64: PNG, mimeType: `image/png;n=${n}` }] };
    });
    const h = await createTestHarness(registerSetTools);
    await h.callTool('gemini_generate_set', {
      master_prompt: 'fox',
      scenes: ['s1', 's2'],
      reference_mode: 'chain',
      output_dir: dir,
    });
    // call 0 = master (no ref); call 1 refs master; call 2 refs image from call 1
    expect(spy.mock.calls[1][0].images?.[0].mimeType).toBe('image/png;n=1'); // master
    expect(spy.mock.calls[2][0].images?.[0].mimeType).toBe('image/png;n=2'); // scene 1's output
    await h.close();
  });

  it('count generates N variations of the master prompt', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', { master_prompt: 'fox', count: 3, output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(4); // master + 3
    expect(spy.mock.calls.slice(1).every((c) => c[0].prompt === 'fox')).toBe(true);
    await h.close();
  });
});
