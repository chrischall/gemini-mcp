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
    // …and it must offer the recovery route this runtime actually has. That is
    // `max_wait_ms`, NOT `async: true`: an immediate hand-off releases the
    // request, and the open request is the only thing keeping the executor
    // alive here (src/job-store.ts). Recommending async recommended the bug.
    expect(String(body.timeout_risk)).toMatch(/max_wait_ms/);
    expect(String(body.timeout_risk)).not.toMatch(/`async: true`/);
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
    // The remediation must lead with the routes that keep bytes out of model
    // context, and name base64 only as the fallback it is.
    expect(text).toMatch(/images_url/);
    expect(text).toMatch(/gemini_upload_file/);
    expect(text).toMatch(/POST \/upload/);
    expect(text).toMatch(/images_base64/);
    expect(text.indexOf('images_url')).toBeLessThan(text.indexOf('images_base64'));
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

  it('accepts images_url on the hosted connector — the server does the fetching', async () => {
    const generate = vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
      mimeType: 'image/png',
      size: 68,
      finalUrl: 'https://cdn.example.com/a.png',
      requestedUrl: 'https://cdn.example.com/a.png',
    });
    const client = stub(hosted(), { generate, fetchRemoteImage });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_edit', {
      prompt: 'make it night',
      images_url: ['https://cdn.example.com/a.png'],
      inline: true,
    });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(generate.mock.calls[0][0].images).toHaveLength(1);
  });

  it('accepts images_file_uris on the hosted connector without moving any bytes', async () => {
    const generate = vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const getFile = vi.fn().mockResolvedValue({ name: 'files/a1', uri: 'https://g/v1beta/files/a1', mimeType: 'image/png' });
    const client = stub(hosted(), { generate, getFile });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it night', images_file_uris: ['files/a1'], inline: true });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(generate.mock.calls[0][0].images).toEqual([{ uri: 'https://g/v1beta/files/a1', mimeType: 'image/png' }]);
  });

  it('gemini_image_edit accepts a URL as its required input (not just paths/base64)', async () => {
    const generate = vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const client = stub(hosted(), { generate, getFile: vi.fn().mockResolvedValue({ name: 'files/a', uri: 'https://g/files/a', mimeType: 'image/png' }) });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));

    const missing = await h.callTool('gemini_image_edit', { prompt: 'x' });
    expect(missing.isError).toBe(true);
    expect(errorText(missing)).toMatch(/images_url/);

    const ok = await h.callTool('gemini_image_edit', { prompt: 'x', images_file_uris: ['files/a'], inline: true });
    expect(ok.isError).toBeFalsy();
    await h.close();
  });

  it('gives gemini_music_generate a non-base64 image route — it IS served here', async () => {
    // Music is registered on the connector, so before it shared the one input
    // funnel its `images` paths were rejected and `images_base64` was the only
    // way left to pass a reference image — the exact problem images_url exists
    // to solve, still live on a connector-served tool.
    const generateMusic = vi.fn().mockResolvedValue({ id: 'm1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    const getFile = vi.fn().mockResolvedValue({ name: 'files/a1', uri: 'https://g/v1beta/files/a1', mimeType: 'image/png' });
    const client = stub(hosted(), { generateMusic, getFile });
    const h = await createTestHarness((s) => registerMusicTools(s, client));
    const res = await h.callTool('gemini_music_generate', {
      prompt: 'something like this picture',
      images_file_uris: ['files/a1'],
      inline: true,
    });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(generateMusic.mock.calls[0][0].images).toEqual([{ uri: 'https://g/v1beta/files/a1', mimeType: 'image/png' }]);
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

/**
 * The bug this all exists for: on the hosted connector a generation billed
 * successfully and the user never saw the image. `inline: true` returned MCP
 * image blocks the chat client does not render; `inline: false` returned
 * `r2://bucket/key`, which is not fetchable by anything.
 *
 * The contract now is simple enough to state in one line: **every generation
 * comes back with a URL a human can open**, configured or not.
 */
describe('every hosted generation returns an openable URL', () => {
  const signed = (b: MediaBucket) =>
    createR2Sink(b, {
      signedBaseUrl: 'https://connector.example.com/media',
      sign: async (key, exp) => `sig${key.length}x${exp}`,
      urlTtlMs: 48 * 60 * 60 * 1000,
      now: () => new Date('2026-07-29T12:00:00Z'),
    });

  it('gemini_image_generate: url + r2_key + expires_at, with NO config set', async () => {
    const b = bucket();
    const client = stub(signed(b), { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat' }));
    await h.close();

    const media = body.media as Array<Record<string, string>>;
    expect(media).toHaveLength(1);
    expect(media[0].url).toMatch(/^https:\/\/connector\.example\.com\/media\/gen\/.*\?exp=\d+&sig=/);
    expect(media[0].r2_key).toBe(b.keys[0]);
    expect(media[0].expires_at).toBe('2026-07-31T12:00:00.000Z');
    // A ready-to-run download command, named after the HUMAN filename (the
    // key's uniqueness prefix stripped) — the download-then-attach flow is how
    // an end user actually sees the image in a chat client.
    expect(media[0].curl_hint).toBe(`curl -sS -o ${b.keys[0].split('/').pop()!.replace(/^[0-9a-f]{6,12}-/i, '')} "${media[0].url}"`);
    // The flat list stays the primary field, and now holds the same URL.
    expect((body.images as string[])[0]).toBe(media[0].url);
  });

  it('honours MEDIA_PUBLIC_BASE_URL when an operator HAS configured a served bucket', async () => {
    const b = bucket();
    const client = stub(createR2Sink(b, { publicBaseUrl: 'https://media.example.com' }), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat' }));
    await h.close();

    expect((body.images as string[])[0]).toBe(`https://media.example.com/${b.keys[0]}`);
    expect((body.media as Array<Record<string, string>>)[0].r2_key).toBe(b.keys[0]);
  });

  it('applies to edit, set, interact and music too — not just generate', async () => {
    const results: Record<string, string[]> = {};

    const editClient = stub(signed(bucket()), { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h1 = await createTestHarness((s) => registerGenerateTools(s, editClient));
    results.edit = parseToolResult<{ images: string[] }>(await h1.callTool('gemini_image_edit', { prompt: 'x', images_base64: [PNG] })).images;
    await h1.close();

    const setClient = stub(signed(bucket()), { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h2 = await createTestHarness((s) => registerSetTools(s, setClient));
    results.set = parseToolResult<{ images: string[] }>(await h2.callTool('gemini_image_set', { master_prompt: 'x', count: 1 })).images;
    await h2.close();

    const interactClient = stub(signed(bucket()), { interact: vi.fn().mockResolvedValue({ id: 'i1', images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h3 = await createTestHarness((s) => registerInteractTools(s, interactClient));
    results.interact = parseToolResult<{ images: string[] }>(await h3.callTool('gemini_interact', { input: 'x' })).images;
    await h3.close();

    const musicClient = stub(signed(bucket()), { generateMusic: vi.fn().mockResolvedValue({ id: 'm1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] }) });
    const h4 = await createTestHarness((s) => registerMusicTools(s, musicClient));
    results.music = parseToolResult<{ audios: string[] }>(await h4.callTool('gemini_music_generate', { prompt: 'x' })).audios;
    await h4.close();

    for (const [tool, refs] of Object.entries(results)) {
      expect(refs.length, tool).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref, tool).toMatch(/^https:\/\/connector\.example\.com\/media\//);
        expect(ref, tool).not.toMatch(/^r2:\/\//);
      }
    }
  });

  it('audio gets the full media contract too — url, r2_key, expires_at, curl_hint on an .mp3', async () => {
    // The r2_key lifecycle (sign_media, r2_key re-upload, replay refresh) is
    // keyed on media[], so music must emit the same fields as images.
    const b = bucket();
    const client = stub(signed(b), { generateMusic: vi.fn().mockResolvedValue({ id: 'm1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] }) });
    const h = await createTestHarness((s) => registerMusicTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_music_generate', { prompt: 'x' }));
    await h.close();

    const media = body.media as Array<Record<string, string>>;
    expect(media[0].r2_key).toBe(b.keys[0]);
    expect(media[0].r2_key).toMatch(/\.mp3$/);
    expect(media[0].expires_at).toBe('2026-07-31T12:00:00.000Z');
    expect(media[0].curl_hint).toMatch(/^curl -sS -o \S+\.mp3 "https:\/\/connector\.example\.com\/media\//);
  });

  it('returns an ABSOLUTE https URL from every configured sink — not merely "not r2://"', async () => {
    // Asserting only the absence of `r2://` let a bare object key pass, which
    // reads as a relative file path in `images[]`. The contract is a URL.
    for (const sink of [signed(bucket()), createR2Sink(bucket(), { publicBaseUrl: 'https://m.example.com' })]) {
      const client = stub(sink, { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
      const h = await createTestHarness((s) => registerGenerateTools(s, client));
      const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat' }));
      await h.close();
      expect((body.images as string[])[0]).toMatch(/^https:\/\//);
      expect(body.media_url_unavailable).toBeUndefined();
    }
  });

  it('says so LOUDLY if no URL could be minted, rather than passing a key off as a path', async () => {
    // Unreachable through the Worker (it always supplies its own origin), so
    // this is a misconfiguration. It must not look like a filename.
    const client = stub(createR2Sink(bucket(), {}), {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat' }));
    await h.close();

    expect(String(body.media_url_unavailable)).toMatch(/no public URL.*not links/is);
    expect(String(body.media_url_unavailable)).toMatch(/MEDIA_PUBLIC_BASE_URL/);
  });

  it('tells the caller the links are openable without an auth header', async () => {
    const client = stub(signed(bucket()), { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat' }));
    await h.close();

    expect(String(body.storage_note)).toMatch(/no auth header is needed/i);
    expect(String(body.storage_note)).toMatch(/expire/i);
  });

  it('leaves the stdio disk result shape untouched — no media[] array, no storage note', async () => {
    const client = stub(createDiskSink(), { generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }) });
    const dir = mkdtempSync(join(tmpdir(), 'gemini-urls-'));
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_image_generate', { prompt: 'a cat', output_dir: dir }));
    await h.close();
    rmSync(dir, { recursive: true, force: true });

    expect(body.images).toEqual([join(dir, 'a-cat.png')]);
    expect(body.media).toBeUndefined();
    expect(body.storage).toBeUndefined();
  });
});
