import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerSetTools } from '../../src/tools/set.js';
import { client } from '../../src/client.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-set-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); client.session.reset(); });

describe('gemini_image_set (master mode)', () => {
  it('generates a master then one image per scene referencing the master', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'x' });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('rejects an empty scenes array (would otherwise silently yield only a master)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'x', scenes: [] });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // rejected at schema validation, no master generated
    await h.close();
  });
});

describe('gemini_image_set timeout_risk hint', () => {
  it('always surfaces meta.timeout_risk — a set is master + N scenes in one call (multi-image)', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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

describe('gemini_image_set idempotency', () => {
  it('reuses the recorded set for a repeat idempotency_key (whole batch not re-run)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return Promise.resolve({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const args = { master_prompt: 'a fox', scenes: ['waving'], output_dir: dir, idempotency_key: 'sk' };
    const r1 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_image_set', args));
    const r2 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_image_set', args));
    expect(calls).toBe(2); // master + 1 scene, generated ONCE (not 4)
    expect(r2.reused).toBe(true);
    expect(r2.images).toEqual(r1.images);
    await h.close();
  });
});

describe('gemini_image_set master_images_base64', () => {
  it('passes master_images_base64 as input images to the master generate call', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
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

describe('gemini_image_set reference reuse (one fetch/upload for the whole set)', () => {
  it('fetches a master_images_url ONCE and reuses it on the master and every scene', async () => {
    const gen = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const fetchRemote = vi.spyOn(client, 'fetchRemoteImage').mockResolvedValue({
      bytes: Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
      mimeType: 'image/png',
      size: 68,
      finalUrl: 'https://cdn.example.com/rusty.png',
      requestedUrl: 'https://cdn.example.com/rusty.png',
    });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
      master_prompt: 'a cartoon fox named Rusty',
      scenes: ['waving', 'eating an apple', 'asleep'],
      master_images_url: ['https://cdn.example.com/rusty.png'],
      output_dir: dir,
    });
    await h.close();

    // One download for master + 3 scenes — not four.
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(gen).toHaveBeenCalledTimes(4);
    // Every scene call carries the same reference alongside the master image,
    // which is what keeps the subject consistent scene to scene.
    for (const call of gen.mock.calls.slice(1)) {
      expect(call[0].images).toHaveLength(2);
      expect(call[0].images?.[1]).toMatchObject({ mimeType: 'image/png' });
    }
  });

  it('reuses a single Files API reference across master + scenes without re-uploading', async () => {
    const gen = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const getFile = vi.spyOn(client, 'getFile').mockResolvedValue({
      name: 'files/rusty1',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/rusty1',
      mimeType: 'image/png',
    });
    const uploadBytes = vi.spyOn(client, 'uploadBytes');
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
      master_prompt: 'a cartoon fox named Rusty',
      scenes: ['waving', 'eating an apple'],
      master_images_file_uris: ['files/rusty1'],
      output_dir: dir,
    });
    await h.close();

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(uploadBytes).not.toHaveBeenCalled();
    // Passed BY REFERENCE — no bytes on any of the three requests.
    for (const call of gen.mock.calls) {
      const byRef = call[0].images?.filter((i) => i.uri);
      expect(byRef).toHaveLength(1);
      expect(byRef?.[0].base64).toBeUndefined();
    }
    expect(parseToolResult<{ image_inputs?: { file_uris?: string[] } }>(res).image_inputs?.file_uris).toEqual(['files/rusty1']);
  });

  it('keeps master_images_base64 master-only (pre-existing behaviour unchanged)', async () => {
    const gen = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
      master_prompt: 'a fox',
      scenes: ['waving'],
      master_images_base64: [PNG],
      output_dir: dir,
    });
    await h.close();

    expect(gen.mock.calls[0][0].images).toHaveLength(1);
    // The scene still sees only the generated master, as before.
    expect(gen.mock.calls[1][0].images).toHaveLength(1);
  });
});

describe('gemini_image_set metadata', () => {
  it('includes model and seed in result', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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

describe('gemini_image_set basename param', () => {
  it('uses caller-supplied basename instead of slugified master_prompt', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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

describe('gemini_image_set google_search passthrough', () => {
  it('passes google_search:true to client.generate as googleSearch', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
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
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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
describe('gemini_image_set (chain mode + count)', () => {
  it('chain mode references the previous image each step', async () => {
    let n = 0;
    const spy = vi.spyOn(client, 'generate').mockImplementation(async () => {
      n += 1;
      return { images: [{ base64: PNG, mimeType: `image/png;n=${n}` }] };
    });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
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
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'fox', count: 3, output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(4); // master + 3
    expect(spy.mock.calls.slice(1).every((c) => c[0].prompt === 'fox')).toBe(true);
    await h.close();
  });
});

describe('gemini_image_set from_clipboard', () => {
  it('passes clipboard image as master input when from_clipboard:true', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
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
  it('gemini_image_set passes timeout_ms to every client.generate call', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', { master_prompt: 'a fox', count: 2, timeout_ms: 80_000, output_dir: dir });
    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) {
      expect(call[0]).toMatchObject({ timeoutMs: 80_000 });
    }
    await h.close();
  });
});

/**
 * A set is N+1 billed generations in one tools/call. `Promise.all` rejected the
 * whole batch on the first scene failure — losing the master and every scene
 * that HAD succeeded — and surfaced as an opaque "Error occurred during tool
 * execution" naming neither the scene nor the cause.
 */
describe('gemini_image_set partial failure', () => {
  it('keeps the master and the scenes that worked, and names what failed', async () => {
    let call = 0;
    vi.spyOn(client, 'generate').mockImplementation(async () => {
      call += 1;
      // call 1 = master, 2 = scene 1, 3 = scene 2 (fails), 4 = scene 3
      if (call === 3) throw new Error('Gemini returned no image: blocked by a safety filter');
      return { images: [{ base64: PNG, mimeType: 'image/png' }] };
    });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', {
      master_prompt: 'a cartoon fox',
      scenes: ['waving', 'eating', 'asleep'],
      output_dir: dir,
    });
    await h.close();

    expect(res.isError).toBeFalsy();
    const body = parseToolResult<{ images: string[]; failed_scenes?: Array<Record<string, unknown>>; partial?: string }>(res);
    // master + 2 surviving scenes, rather than nothing at all.
    expect(body.images).toHaveLength(3);
    expect(body.failed_scenes).toHaveLength(1);
    expect(body.failed_scenes?.[0]).toMatchObject({ scene: 2, prompt: 'eating' });
    expect(String(body.failed_scenes?.[0].error)).toMatch(/safety filter/);
    expect(String(body.partial)).toMatch(/1 of 3 scene\(s\) failed/);
  });

  it('chain mode keeps anchoring on the last image that actually exists', async () => {
    let call = 0;
    const spy = vi.spyOn(client, 'generate').mockImplementation(async () => {
      call += 1;
      if (call === 3) throw new Error('transient 503');
      return { images: [{ base64: PNG, mimeType: `image/png;n=${call}` }] };
    });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    await h.callTool('gemini_image_set', {
      master_prompt: 'fox',
      scenes: ['s1', 's2', 's3'],
      reference_mode: 'chain',
      output_dir: dir,
    });
    await h.close();

    // Scene 3 must chain from scene 1's output (n=2), NOT from the failure.
    expect(spy.mock.calls[3][0].images?.[0].mimeType).toBe('image/png;n=2');
  });

  it('still reports nothing when every scene succeeds', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'fox', scenes: ['a'], output_dir: dir });
    await h.close();

    const body = parseToolResult<Record<string, unknown>>(res);
    expect(body.failed_scenes).toBeUndefined();
    expect(body.partial).toBeUndefined();
  });
});
