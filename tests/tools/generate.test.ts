import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { client } from '../../src/client.js';
import { __resetJobRegistry } from '../../src/jobs.js';

// Mock clipboard so from_clipboard tests don't shell out
vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-gen-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); __resetJobRegistry(); });

describe('tool descriptions steer iterative refinement to gemini_interact', () => {
  it('gemini_image_generate points at gemini_interact for iterative work', async () => {
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const { tools } = await h.client.listTools();
    const desc = tools.find((t) => t.name === 'gemini_image_generate')?.description ?? '';
    expect(desc).toContain('gemini_interact');
    await h.close();
  });

  it('gemini_image_edit points at gemini_interact for successive edits, itself for one-offs/composition', async () => {
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const { tools } = await h.client.listTools();
    const desc = tools.find((t) => t.name === 'gemini_image_edit')?.description ?? '';
    expect(desc).toMatch(/series of successive edits/i);
    expect(desc).toContain('gemini_interact');
    expect(desc).toMatch(/one-off/i);
    await h.close();
  });
});

describe('refinement hints in results', () => {
  it('gemini_image_generate result includes a hint steering follow-up edits to gemini_interact', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir });
    const data = parseToolResult<{ hint?: string }>(res);
    expect(data.hint).toContain('gemini_interact');
    expect(data.hint).toContain('previous_interaction_id');
    await h.close();
  });

  it('gemini_image_edit result includes a hint steering follow-up edits to gemini_interact', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'brighter', images_base64: [PNG], output_dir: dir });
    const data = parseToolResult<{ hint?: string }>(res);
    expect(data.hint).toContain('gemini_interact');
    expect(data.hint).toContain('previous_interaction_id');
    await h.close();
  });
});

describe('gemini_image_generate', () => {
  it('writes a file and returns its path', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(data.images).toHaveLength(1);
    expect(existsSync(data.images[0])).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a red leaf' }));
    await h.close();
  });

  it('count makes N calls each with a DISTINCT seed (not N duplicates)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', count: 3, seed: 100, output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
    const seeds = spy.mock.calls.map((c) => c[0].seed);
    expect(seeds).toEqual([100, 101, 102]); // seed + i — distinct per image
    await h.close();
  });

  it('inline returns meta text block then image content blocks, writes nothing', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', inline: true });
    // With Feature D, meta is always emitted; content[0] = text meta, content[1] = image
    expect(res.content[0].type).toBe('text');
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await h.close();
  });
});

describe('gemini_image_generate metadata', () => {
  it('includes model and seed in result', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir, seed: 7 });
    const data = parseToolResult<{ images: string[]; seed: number; model: string }>(res);
    expect(data.seed).toBe(7);
    expect(typeof data.model).toBe('string');
    await h.close();
  });
});

describe('gemini_image_generate timeout_risk hint', () => {
  it('surfaces meta.timeout_risk for a 4K (slow) config', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', image_size: '4K', output_dir: dir });
    const data = parseToolResult<{ timeout_risk?: string }>(res);
    expect(data.timeout_risk).toContain('-32001');
    await h.close();
  });

  it('omits meta.timeout_risk for the default fast (Flash, 1-image) config', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir });
    const data = parseToolResult<{ timeout_risk?: string }>(res);
    expect(data.timeout_risk).toBeUndefined();
    await h.close();
  });

  it('surfaces meta.timeout_risk on gemini_image_edit for a 4K config, omits it otherwise', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const slow = parseToolResult<{ timeout_risk?: string }>(
      await h.callTool('gemini_image_edit', { prompt: 'brighter', images_base64: [PNG], image_size: '4K', output_dir: dir }),
    );
    expect(slow.timeout_risk).toContain('-32001');
    const fast = parseToolResult<{ timeout_risk?: string }>(
      await h.callTool('gemini_image_edit', { prompt: 'brighter', images_base64: [PNG], output_dir: dir }),
    );
    expect(fast.timeout_risk).toBeUndefined();
    await h.close();
  });
});

describe('gemini_image_generate idempotency', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it('dedups two in-flight identical calls — generate runs once, the second is reused', async () => {
    let calls = 0;
    let resolveGen!: (v: { images: { base64: string; mimeType: string }[] }) => void;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return new Promise((res) => { resolveGen = res; });
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'a red leaf', output_dir: dir };
    const p1 = h.callTool('gemini_image_generate', args);
    await tick(); // let the first call register + reach the (pending) generate
    const p2 = h.callTool('gemini_image_generate', args);
    await tick(); // let the second call attach to the in-flight job
    resolveGen({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const m1 = parseToolResult<{ reused?: boolean }>(await p1);
    const m2 = parseToolResult<{ reused?: boolean }>(await p2);
    expect(calls).toBe(1); // second call did NOT bill a new generation
    expect([m1.reused, m2.reused].filter(Boolean)).toHaveLength(1);
    await h.close();
  });

  it('returns the recorded result for a repeat idempotency_key (no second generation)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return Promise.resolve({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'a red leaf', output_dir: dir, idempotency_key: 'k1' };
    const r1 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_image_generate', args));
    const r2 = parseToolResult<{ images: string[]; reused?: boolean; reused_job_id?: string }>(await h.callTool('gemini_image_generate', args));
    expect(calls).toBe(1);
    expect(r1.reused).toBeUndefined();
    expect(r2.reused).toBe(true);
    expect(typeof r2.reused_job_id).toBe('string');
    expect(r2.images).toEqual(r1.images);
    await h.close();
  });

  it('does not dedup two sequential identical calls without a key (intentional variation)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return Promise.resolve({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'a red leaf', output_dir: dir };
    await h.callTool('gemini_image_generate', args);
    await h.callTool('gemini_image_generate', args);
    expect(calls).toBe(2);
    await h.close();
  });
});

describe('gemini_image_generate with reference inputs', () => {
  it('passes images_base64 as input images to generate', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'style transfer', images_base64: [PNG], output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]) }));
    await h.close();
  });
});

describe('gemini_image_generate filename param', () => {
  it('uses caller-supplied filename as the base name', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', {
      prompt: 'a red leaf',
      filename: 'my-custom.png',
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('my-custom.png');
    await h.close();
  });

  it('falls back to slugified prompt when no filename given', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'red leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('red-leaf.png');
    await h.close();
  });
});

describe('gemini_image_generate text capture', () => {
  it('includes model text in meta when client returns text', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }], text: 'A nice leaf.' });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[]; text?: string }>(res);
    expect(data.text).toBe('A nice leaf.');
    await h.close();
  });

  it('omits text from meta when client returns no text', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[]; text?: string }>(res);
    expect(data.text).toBeUndefined();
    await h.close();
  });
});

describe('gemini_image_generate thinking_level passthrough', () => {
  it('passes thinking_level to client.generate as thinkingLevel', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'leaf', thinking_level: 'minimal', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'minimal' }));
    await h.close();
  });

  it('omits thinkingLevel from generate call when thinking_level not provided', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'leaf', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({ thinkingLevel: expect.anything() }));
    await h.close();
  });
});

describe('gemini_image_edit idempotency', () => {
  it('returns the recorded result for a repeat idempotency_key (no second generation)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generate').mockImplementation(() => {
      calls++;
      return Promise.resolve({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'brighter', images_base64: [PNG], output_dir: dir, idempotency_key: 'ek' };
    const r1 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_image_edit', args));
    const r2 = parseToolResult<{ images: string[]; reused?: boolean }>(await h.callTool('gemini_image_edit', args));
    expect(calls).toBe(1);
    expect(r2.reused).toBe(true);
    expect(r2.images).toEqual(r1.images);
    await h.close();
  });
});

describe('gemini_image_edit images_base64 + optional images', () => {
  it('accepts images_base64 without images', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', images_base64: [PNG], output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]) }));
    await h.close();
  });

  it('throws when neither images nor images_base64 provided', async () => {
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', output_dir: dir });
    expect(res.isError).toBe(true);
    await h.close();
  });
});

describe('gemini_image_generate google_search + video_url passthrough', () => {
  it('passes google_search:true to client.generate as googleSearch', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'leaf', google_search: true, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ googleSearch: true }));
    await h.close();
  });

  it('passes video_url to client.generate as videoUrl', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'leaf', video_url: 'https://www.youtube.com/watch?v=abc', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'https://www.youtube.com/watch?v=abc' }));
    await h.close();
  });

  it('surfaces meta.grounding when client returns grounding', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({
      images: [{ base64: PNG, mimeType: 'image/png' }],
      grounding: { queries: ['SF weather'], sources: [{ uri: 'https://weather.com', title: 'Weather' }] },
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', google_search: true, output_dir: dir });
    const data = parseToolResult<{ grounding?: { queries?: string[]; sources?: unknown[] } }>(res);
    expect(data.grounding?.queries).toEqual(['SF weather']);
    expect(data.grounding?.sources).toHaveLength(1);
    await h.close();
  });

  it('omits meta.grounding when client returns no grounding', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'leaf', output_dir: dir });
    const data = parseToolResult<{ grounding?: unknown }>(res);
    expect(data.grounding).toBeUndefined();
    await h.close();
  });
});

describe('gemini_image_edit google_search passthrough', () => {
  it('passes google_search:true to client.generate as googleSearch', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_edit', { prompt: 'make it blue', images_base64: [PNG], google_search: true, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ googleSearch: true }));
    await h.close();
  });

  it('surfaces meta.grounding on edit when client returns grounding', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({
      images: [{ base64: PNG, mimeType: 'image/png' }],
      grounding: { queries: ['blue color'], sources: [] },
    });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', images_base64: [PNG], google_search: true, output_dir: dir });
    const data = parseToolResult<{ grounding?: { queries?: string[] } }>(res);
    expect(data.grounding?.queries).toEqual(['blue color']);
    await h.close();
  });
});

describe('gemini_image_edit', () => {
  it('reads input images, passes them to generate, returns a path', async () => {
    const inPath = join(dir, 'src.png');
    writeFileSync(inPath, Buffer.from(PNG, 'base64'));
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', images: [inPath], confirm: true, output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    );
    await h.close();
  });

  it('uses caller-supplied filename as the base name', async () => {
    const inPath = join(dir, 'src.png');
    writeFileSync(inPath, Buffer.from(PNG, 'base64'));
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', {
      prompt: 'make it blue',
      images: [inPath],
      filename: 'edited-output',
      confirm: true,
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('edited-output.png');
    await h.close();
  });
});

describe('gemini_image_edit from_clipboard guard', () => {
  it('accepts from_clipboard:true with no images/images_base64 — passes the guard', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', from_clipboard: true, output_dir: dir });
    expect(res.isError).toBeFalsy();
    await h.close();
  });

  it('from_clipboard passes the clipboard image to generate', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_edit', { prompt: 'make it blue', from_clipboard: true, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/jpeg' })]),
    }));
    await h.close();
  });
});

describe('gemini_image_generate input-dir resolution via GEMINI_INPUT_DIR', () => {
  afterEach(() => { delete process.env.GEMINI_INPUT_DIR; });

  it('resolves a bare filename against GEMINI_INPUT_DIR and passes the image to generate', async () => {
    const imgPath = join(dir, 'ref.png');
    writeFileSync(imgPath, Buffer.from(PNG, 'base64'));
    process.env.GEMINI_INPUT_DIR = dir;

    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'style transfer', images: ['ref.png'], confirm: true, output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]),
    }));
    await h.close();
  });
});

describe('gemini_image_edit input-dir resolution via GEMINI_INPUT_DIR', () => {
  afterEach(() => { delete process.env.GEMINI_INPUT_DIR; });

  it('resolves a bare filename against GEMINI_INPUT_DIR for edit', async () => {
    const imgPath = join(dir, 'edit-src.png');
    writeFileSync(imgPath, Buffer.from(PNG, 'base64'));
    process.env.GEMINI_INPUT_DIR = dir;

    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it blue', images: ['edit-src.png'], confirm: true, output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]),
    }));
    await h.close();
  });
});

describe('gemini_image_generate video_path (Files API upload)', () => {
  const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
  const uploaded = { name: 'files/abc123', uri: FILE_URI, mimeType: 'video/mp4', expirationTime: '2026-06-14T15:26:39Z' };

  it('uploads the local video then generates with the returned files/ uri', async () => {
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('vid'));
    const up = vi.spyOn(client, 'uploadVideo').mockResolvedValue(uploaded);
    const gen = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'flag', video_path: videoPath, confirm: true, output_dir: dir });
    expect(up).toHaveBeenCalledWith(videoPath, 'video/mp4');
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: FILE_URI, videoMimeType: 'video/mp4' }));
    // meta surfaces the uploaded file so callers can reuse the uri (48h TTL)
    const data = parseToolResult<{ video_file: { uri: string; expires?: string } }>(res);
    expect(data.video_file).toMatchObject({ uri: FILE_URI });
    await h.close();
  });

  it('uploads ONCE for count > 1', async () => {
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('vid'));
    const up = vi.spyOn(client, 'uploadVideo').mockResolvedValue(uploaded);
    const gen = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'flag', video_path: videoPath, count: 3, confirm: true, output_dir: dir });
    expect(up).toHaveBeenCalledTimes(1);
    expect(gen).toHaveBeenCalledTimes(3);
    await h.close();
  });

  it('rejects video_path together with video_url', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', {
      prompt: 'flag',
      video_path: '/tmp/clip.mp4',
      video_url: 'https://www.youtube.com/watch?v=abc',
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not both/i);
    expect(up).not.toHaveBeenCalled();
    await h.close();
  });

  it('errors before uploading when the video file does not exist', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'flag', video_path: '/nonexistent/clip.mp4' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Video not found/);
    expect(up).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('timeout_ms passthrough', () => {
  const PNG_IMG = { base64: PNG, mimeType: 'image/png' };

  it('gemini_image_generate passes timeout_ms to client.generate as timeoutMs', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [PNG_IMG] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'circle', timeout_ms: 90_000, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90_000 }));
    await h.close();
  });

  it('gemini_image_edit passes timeout_ms to client.generate as timeoutMs', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [PNG_IMG] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_edit', { prompt: 'crop it', images_base64: [PNG], timeout_ms: 45_000, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
    await h.close();
  });
});
