import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerInteractTools } from '../../src/tools/interact.js';
import { registerMusicTools } from '../../src/tools/music.js';
import { GeminiClient, type GeminiClient as GeminiClientType } from '../../src/client.js';
import { createDiskSink, createR2Sink, type MediaBucket, type MediaSink } from '../../src/storage/media.js';
import { SessionState } from '../../src/session.js';

/**
 * The hosted connector runs on a Cloudflare Worker: no filesystem, so no disk
 * output, no `<image>.json` sidecar, no local-path image inputs, no clipboard,
 * and no streamed Files API upload. These tests pin the two halves of that:
 *
 *  1. the disk path is UNCHANGED (highest-risk part of the sink refactor), and
 *  2. the hosted path fails *gracefully and honestly* instead of crashing or
 *     claiming a file it never wrote.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MP3 = Buffer.from('fake-mp3').toString('base64');

/** Concatenate a tool result's text blocks (errors arrive as text content). */
function errorText(res: { content: Array<Record<string, unknown>> }): string {
  return res.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

function bucket(): MediaBucket & { keys: string[] } {
  const keys: string[] = [];
  return { keys, async put(key) { keys.push(key); return {}; } };
}

/**
 * The description a registrar registers a tool with. Captured off a recording
 * stub server — `createTestHarness().listTools()` returns names only.
 */
function describeTool(register: (server: never, client: never) => void, client: GeminiClientType, name: string): string {
  const seen = new Map<string, string>();
  const server = {
    registerTool: (toolName: string, config: { description?: string }) => {
      seen.set(toolName, config.description ?? '');
    },
  };
  register(server as never, client as never);
  return seen.get(name) ?? '';
}

/** A client stub carrying an explicit sink, as the Worker's buildClient does. */
function stub(sink: MediaSink, methods: Record<string, unknown> = {}): GeminiClientType {
  // Every stub gets its OWN session — the connector builds one per
  // authenticated user, and the registrars read `client.session`.
  return { mediaSink: sink, session: new SessionState(), ...methods } as unknown as GeminiClientType;
}

describe('media sink threading', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-hosted-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('defaults a client with no explicit sink to the disk sink (stdio unchanged)', () => {
    expect(new GeminiClient().mediaSink.kind).toBe('disk');
    expect(new GeminiClient().mediaSink.persistsFiles).toBe(true);
  });

  it('keeps the disk result shape byte-identical: `images` are absolute paths, no storage note', async () => {
    const client = stub(createDiskSink(), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_image_generate', { prompt: 'a cat', output_dir: dir }),
    );
    await h.close();

    expect(body.images).toEqual([join(dir, 'a-cat.png')]);
    expect(existsSync(join(dir, 'a-cat.png'))).toBe(true);
    expect(body.storage).toBeUndefined();
    expect(body.storage_note).toBeUndefined();
  });

  it('routes generated images to R2 and labels them honestly as URLs, not paths', async () => {
    const b = bucket();
    const client = stub(createR2Sink(b, { publicBaseUrl: 'https://media.example.com' }), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_image_generate', { prompt: 'a cat' }),
    );
    await h.close();

    expect(b.keys).toHaveLength(1);
    expect((body.images as string[])[0]).toBe(`https://media.example.com/${b.keys[0]}`);
    expect(body.storage).toBe('r2');
    expect(String(body.storage_note)).toMatch(/not local file paths|NOT fetchable/i);
  });

  it('routes image_set and music through the same sink', async () => {
    const b = bucket();
    const sink = createR2Sink(b, { publicBaseUrl: 'https://media.example.com' });

    const setClient = stub(sink, { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h1 = await createTestHarness((s) => registerSetTools(s, setClient));
    const set = parseToolResult<Record<string, unknown>>(
      await h1.callTool('gemini_image_set', { master_prompt: 'a cat', scenes: ['sitting'] }),
    );
    await h1.close();
    expect((set.images as string[]).every((u) => u.startsWith('https://media.example.com/'))).toBe(true);

    const musicClient = stub(sink, { generateMusic: vi.fn().mockResolvedValue({ id: 'm1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] }) });
    const h2 = await createTestHarness((s) => registerMusicTools(s, musicClient));
    const music = parseToolResult<Record<string, unknown>>(
      await h2.callTool('gemini_music_generate', { prompt: 'lo-fi beat' }),
    );
    await h2.close();
    expect((music.audios as string[])[0]).toMatch(/^https:\/\/media\.example\.com\/.*\.mp3$/);
  });

  it('still supports inline output on the hosted connector (nothing is put to R2)', async () => {
    const b = bucket();
    const client = stub(createR2Sink(b, {}), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a cat', inline: true });
    await h.close();

    expect(res.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
    expect(b.keys).toHaveLength(0);
  });
});

describe('sidecars are gated on a real filesystem', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-hosted-sc-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an <image>.json sidecar on disk (unchanged)', async () => {
    const client = stub(createDiskSink(), {
      interact: vi.fn().mockResolvedValue({ id: 'interactions/abc', images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    const body = parseToolResult<{ images: string[] }>(await h.callTool('gemini_interact', { input: 'a cat', output_dir: dir }));
    await h.close();

    expect(existsSync(`${body.images[0]}.json`)).toBe(true);
  });

  it('does NOT claim a sidecar on R2, and says so instead', async () => {
    const b = bucket();
    const client = stub(createR2Sink(b, { publicBaseUrl: 'https://media.example.com' }), {
      interact: vi.fn().mockResolvedValue({ id: 'interactions/abc', images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_interact', { input: 'a cat' }));
    await h.close();

    expect(body.interaction_id).toBe('interactions/abc');
    expect(body.sidecar_error).toBeUndefined();
    // The result must not tell the caller to go look for a sidecar that no
    // filesystem exists to hold.
    expect(String(body.storage_note)).toMatch(/no <image>\.json sidecar/i);
    expect(String(body.hint)).not.toMatch(/sidecar/i);
  });

  it('does not advertise sidecar recovery in the gemini_interact DESCRIPTION on R2', () => {
    const diskDesc = describeTool(registerInteractTools as never, stub(createDiskSink()), 'gemini_interact');
    const hostedDesc = describeTool(registerInteractTools as never, stub(createR2Sink(bucket(), {})), 'gemini_interact');

    expect(diskDesc).toMatch(/sidecar recording its interaction id land in the output dir/);
    expect(hostedDesc).not.toMatch(/land in the output dir|re-anchors itself/);
    expect(hostedDesc).toMatch(/no output dir and no `<image>\.json` sidecar/);
  });

  it('omits the sidecar/disk-recovery advice from timeout_risk when there is no disk', async () => {
    const b = bucket();
    const client = stub(createR2Sink(b, {}), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_image_generate', { prompt: 'a cat', model: 'gemini-3-pro-image' }),
    );
    await h.close();

    expect(body.timeout_risk).toBeTruthy();
    // It may *mention* the sidecar/output dir — but only to say there is none.
    expect(String(body.timeout_risk)).toMatch(/no output dir and no <image>\.json sidecar/i);
    expect(String(body.timeout_risk)).not.toMatch(/still written to disk|look in the output dir/i);
    expect(String(body.timeout_risk)).toMatch(/async/i);
  });
});

describe('disk-only INPUTS fail gracefully on the hosted connector', () => {

  const hosted = () => createR2Sink(bucket(), {});

  it('rejects local image paths with an actionable error, not a crash', async () => {
    const generate = vi.fn();
    const client = stub(hosted(), { generate });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'x', images: ['/etc/passwd'], confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    const text = errorText(res);
    expect(text).toMatch(/hosted connector/i);
    expect(text).toMatch(/images_base64/);
    // Must fail BEFORE any billable upstream call.
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects from_clipboard without ever importing child_process', async () => {
    const client = stub(hosted(), { generate: vi.fn() });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'x', from_clipboard: true });
    await h.close();

    expect(res.isError).toBe(true);
    const text = errorText(res);
    expect(text).toMatch(/clipboard/i);
    expect(text).toMatch(/hosted connector/i);
  });

  it('rejects video_path (Files API upload streams from disk) and points at video_url', async () => {
    const uploadVideo = vi.fn();
    const client = stub(hosted(), { generate: vi.fn(), uploadVideo });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'x', video_path: '/tmp/clip.mp4', confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    const text = errorText(res);
    expect(text).toMatch(/video_url/);
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('rejects master_images on gemini_image_set', async () => {
    const client = stub(hosted(), { generate: vi.fn() });
    const h = await createTestHarness((s) => registerSetTools(s, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'x', count: 1, master_images: ['/etc/passwd'], confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/hosted connector/i);
  });

  it('rejects local image paths on gemini_interact', async () => {
    const interact = vi.fn();
    const client = stub(hosted(), { interact });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    const res = await h.callTool('gemini_interact', { input: 'x', images: ['/etc/passwd'], confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    expect(interact).not.toHaveBeenCalled();
  });

  it('leaves base64 inputs and video_url working', async () => {
    const generate = vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const client = stub(hosted(), { generate });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', {
      prompt: 'x',
      images_base64: [PNG],
      video_url: 'https://www.youtube.com/watch?v=abc',
      inline: true,
    });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(generate).toHaveBeenCalled();
  });

  it('does not gate any of this on the stdio (disk) sink', async () => {
    const client = stub(createDiskSink(), { generate: vi.fn() });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    // A local path that does not exist must still produce the ORIGINAL
    // "Image not found" error, not the hosted-connector one.
    const res = await h.callTool('gemini_image_generate', { prompt: 'x', images: ['/nope/missing.png'], confirm: true });
    await h.close();

    const text = errorText(res);
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(/hosted connector/i);
  });
});
