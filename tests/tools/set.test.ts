import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerSetTools } from '../../src/tools/set.js';
import { client } from '../../src/client.js';
import { __resetJobRegistry } from '../../src/jobs.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-set-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); __resetJobRegistry(); });

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

describe('gemini_generate_set timeout_risk hint', () => {
  it('always surfaces meta.timeout_risk — a set is master + N scenes in one call (multi-image)', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'a cartoon fox named Rusty',
      scenes: ['Rusty waving', 'Rusty eating an apple'],
      output_dir: dir, // Flash + default size, yet 3 images ⇒ still timeout-prone
    });
    const data = parseToolResult<{ images: string[]; timeout_risk?: string }>(res);
    expect(data.images).toHaveLength(3);
    expect(data.timeout_risk).toContain('count=3');
    await h.close();
  });
});

describe('gemini_generate_set idempotency', () => {
  it('reuses the recorded set for a repeat idempotency_key (whole batch not re-run)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return Promise.resolve({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    });
    const h = await createTestHarness(registerSetTools);
    const args = { master_prompt: 'a fox', scenes: ['waving'], output_dir: dir, idempotency_key: 'sk' };
    const r1 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_generate_set', args));
    const r2 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_generate_set', args));
    expect(calls).toBe(2); // master + 1 scene, generated ONCE (not 4)
    expect(r2.reused).toBe(true);
    expect(r2.images).toEqual(r1.images);
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

describe('gemini_generate_set from_clipboard', () => {
  it('passes clipboard image as master input when from_clipboard:true', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', {
      master_prompt: 'fox',
      scenes: ['waving'],
      from_clipboard: true,
      output_dir: dir,
    });
    expect(res.isError).toBeFalsy();
    // First (master) call should have clipboard image as input
    expect(spy.mock.calls[0][0].images).toEqual(
      expect.arrayContaining([expect.objectContaining({ mimeType: 'image/jpeg' })]),
    );
    await h.close();
  });
});

describe('timeout_ms passthrough', () => {
  it('gemini_generate_set passes timeout_ms to every client.generate call', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerSetTools);
    await h.callTool('gemini_generate_set', { master_prompt: 'a fox', count: 2, timeout_ms: 80_000, output_dir: dir });
    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) {
      expect(call[0]).toMatchObject({ timeoutMs: 80_000 });
    }
    await h.close();
  });
});
