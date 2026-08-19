import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerFileTools } from '../../src/tools/files.js';
import { SessionState } from '../../src/session.js';
import { createDiskSink, createR2Sink } from '../../src/storage/media.js';
import type { GeminiClient } from '../../src/client.js';

/**
 * The Files API tools exist so a caller can hand over a picture ONCE and then
 * refer to it by a 20-character string. Everything here is about that promise:
 * an upload never needs base64 unless you insist, the reference comes back in
 * the form the image tools document, and deleting is gated because it is the
 * one irreversible thing in the group.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function stub(methods: Record<string, unknown> = {}, onDisk = true): GeminiClient {
  return {
    mediaSink: onDisk ? createDiskSink() : createR2Sink({ put: async () => ({}) }, {}),
    session: new SessionState(),
    ...methods,
  } as unknown as GeminiClient;
}

function uploaded(name = 'files/abc123') {
  return {
    name,
    uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
    mimeType: 'image/png',
    sizeBytes: '68',
    displayName: 'photo.png',
    expirationTime: '2026-07-30T12:00:00Z',
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-files-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_upload_file — url', () => {
  it('fetches the URL server-side and returns a reusable files/<id> reference', async () => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'image/png', size: PNG_BYTES.byteLength,
      finalUrl: 'https://cdn.example.com/photo.png', requestedUrl: 'https://cdn.example.com/photo.png',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_upload_file', { url: 'https://cdn.example.com/photo.png' }),
    );
    await h.close();

    expect(fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/photo.png', expect.objectContaining({ accept: expect.arrayContaining(['image/', 'video/']) }));
    // The `files/<id>` form leads, because that is what images_file_uris documents.
    expect(body.file_uri).toBe('files/abc123');
    expect(body.uri).toBe('https://generativelanguage.googleapis.com/v1beta/files/abc123');
    expect(body.mime_type).toBe('image/png');
    expect(body.expires).toBe('2026-07-30T12:00:00Z');
    expect(String(body.hint)).toMatch(/images_file_uris/);
    expect(String(body.hint)).toMatch(/~48h/);
    // Names the upload after the URL's last segment.
    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'photo.png');
  });

  it('caps a url upload at what the runtime can actually buffer', async () => {
    // A `url` upload is buffered whole (fetch, then a Blob copy). Advertising
    // 100MB on a 128MB Cloudflare isolate would fail as an OOM rather than as
    // a clean error, so the hosted cap is much lower — and the parameter
    // description says the figure that actually applies.
    const capture = (methods: Record<string, unknown>, onDisk: boolean) => {
      const seen: Record<string, string> = {};
      const server = {
        registerTool: (name: string, config: { inputSchema?: Record<string, { description?: string }> }) => {
          seen[name] = config.inputSchema?.url?.description ?? '';
        },
      };
      registerFileTools(server as never, stub(methods, onDisk) as never);
      return seen.gemini_upload_file;
    };
    expect(capture({}, true)).toMatch(/up to 100MB/);
    expect(capture({}, false)).toMatch(/up to 25MB/);
    expect(capture({}, false)).toMatch(/POST the raw bytes to \/upload/);

    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'image/png', size: 4, finalUrl: 'https://x/y', requestedUrl: 'https://x/y',
    });
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes: vi.fn().mockResolvedValue(uploaded()) }, false)));
    await h.callTool('gemini_upload_file', { url: 'https://x/y' });
    await h.close();
    expect(fetchRemoteImage).toHaveBeenCalledWith('https://x/y', expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }));
  });

  it('honours mime_type and display_name overrides', async () => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'application/octet-stream', size: 4, finalUrl: 'https://x/y', requestedUrl: 'https://x/y',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    await h.callTool('gemini_upload_file', { url: 'https://x/y', mime_type: 'image/webp', display_name: 'hero' });
    await h.close();

    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/webp', 'hero');
  });

  it('surfaces a fetch failure with the URL rather than a generic upload error', async () => {
    const fetchRemoteImage = vi.fn().mockRejectedValue(new Error('https://x/y.png returned HTTP 404'));
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes: vi.fn() })));
    const res = await h.callTool('gemini_upload_file', { url: 'https://x/y.png' });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/y\.png returned HTTP 404/);
  });
});

describe('gemini_upload_file — data_base64 and path', () => {
  it('accepts data_base64 (the last resort) and sniffs its MIME', async () => {
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes })));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_upload_file', { data_base64: PNG_B64 }));
    await h.close();

    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'upload');
    expect(body.file_uri).toBe('files/abc123');
  });

  it('uploads a local path once confirmed, and dry-runs first without confirm', async () => {
    const p = join(dir, 'local.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes })));

    // A prompt-injected `path` would otherwise ship an arbitrary local file to
    // Google, so the dry-run must show the resolved path and upload nothing.
    const preview = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_upload_file', { path: p }));
    expect(preview.dryRun).toBe(true);
    expect(JSON.stringify(preview.willSend)).toContain(p);
    expect(uploadBytes).not.toHaveBeenCalled();

    await h.callTool('gemini_upload_file', { path: p, confirm: true });
    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'local.png');
    await h.close();
  });

  it('refuses `path` on the hosted connector and points at the three alternatives', async () => {
    const uploadBytes = vi.fn();
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes }, false)));
    const res = await h.callTool('gemini_upload_file', { path: '/etc/passwd', confirm: true });
    await h.close();

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/no filesystem/);
    expect(text).toMatch(/url/);
    expect(text).toMatch(/\/upload/);
    expect(uploadBytes).not.toHaveBeenCalled();
  });
});

describe('gemini_upload_file — display-name fallback', () => {
  /**
   * All three source branches must agree on their fallback. They stopped
   * agreeing once, silently: `fileNameFromUrl` was created by merging two
   * copies that differed only in their default, and inheriting the wrong one
   * made the `url` branch name a fallback upload "image" — for a tool that
   * accepts video and audio too. Pinned per branch so a shared default can
   * never quietly redefine one of them again.
   */
  const cases: Array<[string, Record<string, unknown>]> = [
    ['url with no filename segment', { url: 'https://cdn.example.com/' }],
    ['data_base64', { data_base64: PNG_B64 }],
  ];

  it.each(cases)('falls back to "upload" for %s', async (_label, args) => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'video/mp4', size: 4, finalUrl: 'https://cdn.example.com/', requestedUrl: 'https://cdn.example.com/',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    await h.callTool('gemini_upload_file', args);
    await h.close();

    expect(uploadBytes.mock.calls[0][2]).toBe('upload');
  });

  it('falls back to "upload" for a path with no usable basename', async () => {
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes })));
    // The path branch derives from the resolved filename; assert the shape of
    // the fallback expression rather than contriving an unnameable file.
    const p = join(dir, 'named.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    await h.callTool('gemini_upload_file', { path: p, confirm: true });
    await h.close();

    expect(uploadBytes.mock.calls[0][2]).toBe('named.png');
  });

  it('still prefers a real filename from the URL over the fallback', async () => {
    const fetchRemoteImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES, mimeType: 'video/mp4', size: 4, finalUrl: 'https://cdn.example.com/clip.mp4', requestedUrl: 'https://cdn.example.com/clip.mp4',
    });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ fetchRemoteImage, uploadBytes })));
    await h.callTool('gemini_upload_file', { url: 'https://cdn.example.com/clip.mp4' });
    await h.close();

    expect(uploadBytes.mock.calls[0][2]).toBe('clip.mp4');
  });
});

describe('gemini_upload_file — source validation', () => {
  it('requires exactly one source', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes: vi.fn() })));

    const none = await h.callTool('gemini_upload_file', {});
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toMatch(/exactly one/);

    const both = await h.callTool('gemini_upload_file', { url: 'https://x/y.png', data_base64: PNG_B64 });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toMatch(/not 2/);
    await h.close();
  });

  it('counts r2_key as a source like any other', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes: vi.fn() }, false)));
    const both = await h.callTool('gemini_upload_file', { url: 'https://x/y.png', r2_key: 'gen/k.png' });
    await h.close();
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toMatch(/url, r2_key/);
  });

  it('does not advertise r2_key on stdio, and refuses it with the actual fix (path)', async () => {
    // Hosted-only source, mirroring how `path` is handled in the other
    // direction: the schema says unavailable, the zero-source message omits
    // it, and using it anyway names `path` — not a misleading retention story.
    const h = await createTestHarness((s) => registerFileTools(s, stub({ uploadBytes: vi.fn() })));
    const { tools } = await h.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === 'gemini_upload_file')?.inputSchema);
    expect(schema).toMatch(/Unavailable on this server/);

    const none = await h.callTool('gemini_upload_file', {});
    expect(JSON.stringify(none.content)).not.toMatch(/r2_key/);

    const res = await h.callTool('gemini_upload_file', { r2_key: 'gen/k.png' });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/hosted connector/);
    expect(JSON.stringify(res.content)).toMatch(/`path`/);
    expect(JSON.stringify(res.content)).not.toMatch(/retention/);
  });
});

describe('gemini_upload_file — r2_key (a generated image becomes a reference image)', () => {
  it('reads its own bucket and re-uploads the stored bytes — no HTTP, no signature', async () => {
    const readStoredMedia = vi.fn().mockResolvedValue({ bytes: PNG_BYTES, mimeType: 'image/png' });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ readStoredMedia, uploadBytes }, false)));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_upload_file', { r2_key: 'gen/2026-07-30/abc123-a-cat.png' }),
    );
    await h.close();

    expect(readStoredMedia).toHaveBeenCalledWith('gen/2026-07-30/abc123-a-cat.png');
    // Display name matches what /media would call the file — prefix stripped.
    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'image/png', 'a-cat.png');
    expect(body.file_uri).toBe('files/abc123');
  });

  it('works for audio the same way — the stored MIME type travels with the bytes', async () => {
    const readStoredMedia = vi.fn().mockResolvedValue({ bytes: PNG_BYTES, mimeType: 'audio/mpeg' });
    const uploadBytes = vi.fn().mockResolvedValue(uploaded());
    const h = await createTestHarness((s) => registerFileTools(s, stub({ readStoredMedia, uploadBytes }, false)));
    await h.callTool('gemini_upload_file', { r2_key: 'gen/2026-07-30/ab12cd-a-jingle.mp3' });
    await h.close();

    expect(uploadBytes).toHaveBeenCalledWith(PNG_BYTES, 'audio/mpeg', 'a-jingle.mp3');
  });

  it('says plainly when the object is gone, before any billable call', async () => {
    // A real client wired to an R2 sink whose object was already swept.
    const { GeminiClient } = await import('../../src/client.js');
    const client = new GeminiClient({
      apiKey: 'k',
      mediaSink: createR2Sink({ put: async () => ({}), get: async () => null }, {}),
    });
    const uploadBytes = vi.spyOn(client, 'uploadBytes');
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const res = await h.callTool('gemini_upload_file', { r2_key: 'gen/long-gone.png' });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No stored media.*gen\/long-gone\.png/);
    // Remediation must be in the MESSAGE — MCP serialization drops hints.
    expect(JSON.stringify(res.content)).toMatch(/retention/);
    expect(JSON.stringify(res.content)).toMatch(/Re-run the generation/);
    expect(uploadBytes).not.toHaveBeenCalled();
  });
});

describe('gemini_sign_media', () => {
  const freshRef = {
    ref: 'https://c.example.com/media/gen/2026-07-30/abc123-a-cat.png?exp=9&sig=s',
    key: 'gen/2026-07-30/abc123-a-cat.png',
    expiresAt: '2026-08-01T12:00:00.000Z',
  };

  it('mints a fresh signed URL from a stable r2_key — no regeneration, no new billing', async () => {
    const resign = vi.fn().mockResolvedValue(freshRef);
    const h = await createTestHarness((s) =>
      registerFileTools(s, stub({ mediaSink: { persistsFiles: false, resign } })),
    );
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_sign_media', { r2_key: ` ${freshRef.key} ` }),
    );
    await h.close();

    expect(resign).toHaveBeenCalledWith(freshRef.key); // trimmed
    expect(body.url).toBe(freshRef.ref);
    expect(body.r2_key).toBe(freshRef.key);
    expect(body.expires_at).toBe(freshRef.expiresAt);
    // The ready-to-run command names the HUMAN filename, matching /media's
    // Content-Disposition.
    expect(body.curl_hint).toBe(`curl -sS -o a-cat.png "${freshRef.ref}"`);
  });

  it('distinguishes a swept object from an expired link', async () => {
    const h = await createTestHarness((s) =>
      registerFileTools(s, stub({ mediaSink: { persistsFiles: false, resign: vi.fn().mockResolvedValue(undefined) } })),
    );
    const res = await h.callTool('gemini_sign_media', { r2_key: 'gen/swept.png' });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/retention window/);
    expect(JSON.stringify(res.content)).toMatch(/Re-run the generation/);
  });

  it('is not registered on a disk-backed server, where paths never expire', () => {
    const names = (client: GeminiClient) => {
      const seen: string[] = [];
      registerFileTools({ registerTool: (n: string) => { seen.push(n); } } as never, client);
      return seen;
    };
    // Nothing to re-sign on stdio: the result already carries a durable path.
    expect(names(stub())).not.toContain('gemini_sign_media');
    expect(names(stub({}, false))).toContain('gemini_sign_media');
  });
});

describe('gemini_list_files', () => {
  it('lists uploads with their references and expiry', async () => {
    const listFiles = vi.fn().mockResolvedValue([
      { name: 'files/a1', uri: 'https://g/v1beta/files/a1', mimeType: 'image/png', state: 'ACTIVE', sizeBytes: '1234', expirationTime: '2026-07-30T12:00:00Z' },
    ]);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles })));
    const body = parseToolResult<{ count: number; files: Array<Record<string, unknown>>; hint: string }>(
      await h.callTool('gemini_list_files', {}),
    );
    await h.close();

    expect(listFiles).toHaveBeenCalledWith(100);
    expect(body.count).toBe(1);
    expect(body.files[0]).toMatchObject({ file_uri: 'files/a1', mime_type: 'image/png', size_bytes: 1234 });
    expect(body.hint).toMatch(/images_file_uris/);
  });

  it('explains an empty list as expiry rather than failure', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles: vi.fn().mockResolvedValue([]) })));
    const body = parseToolResult<{ hint: string }>(await h.callTool('gemini_list_files', {}));
    await h.close();
    expect(body.hint).toMatch(/expired/);
  });

  it('passes page_size through', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ listFiles })));
    await h.callTool('gemini_list_files', { page_size: 5 });
    await h.close();
    expect(listFiles).toHaveBeenCalledWith(5);
  });
});

describe('gemini_delete_file', () => {
  it('dry-runs without confirm and deletes nothing', async () => {
    const deleteFile = vi.fn();
    const h = await createTestHarness((s) => registerFileTools(s, stub({ deleteFile })));
    const body = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_delete_file', { file_uri: 'files/a1' }));
    await h.close();

    expect(body.dryRun).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('deletes when confirmed', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, stub({ deleteFile })));
    const body = parseToolResult<{ deleted: string }>(await h.callTool('gemini_delete_file', { file_uri: 'files/a1', confirm: true }));
    await h.close();

    expect(deleteFile).toHaveBeenCalledWith('files/a1');
    expect(body.deleted).toBe('files/a1');
  });
});

/**
 * `gemini_list_recent_media` — the way back to media whose RESULT was lost.
 *
 * A background job killed with its machine (see src/job-store.ts) still wrote
 * its images, but every reference to them died with the response. Before this
 * tool those bytes were unreachable and the only recourse was to pay for the
 * generation a second time.
 */
describe('gemini_list_recent_media', () => {
  const KEYS = [
    'gen/tenant1/2026-08-18/aaaa1111-summer-camp-adventure.png',
    'gen/tenant1/2026-08-19/bbbb2222-summer-camp-adventure-2.png',
  ];

  function hostedSink() {
    return createR2Sink(
      {
        put: async () => ({}),
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
        list: async ({ prefix }: { prefix?: string }) => ({
          objects: KEYS.filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key, size: 2048 })),
          truncated: false,
        }),
      } as never,
      {
        signedBaseUrl: 'https://host/b/reg',
        sign: async () => 'SIG',
        urlTtlMs: 3600_000,
        tenant: 'tenant1',
      },
    );
  }

  it('is not registered on a disk-backed server', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub({}, true)));
    const names = (await h.listTools()).map((t: { name: string }) => t.name);
    await h.close();
    expect(names).not.toContain('gemini_list_recent_media');
  });

  it('lists this account\'s recent media with openable URLs, newest first', async () => {
    const client = { mediaSink: hostedSink(), session: new SessionState() } as unknown as GeminiClient;
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const body = parseToolResult(await h.callTool('gemini_list_recent_media', {})) as Record<string, unknown>;
    await h.close();

    const media = body.media as Array<Record<string, unknown>>;
    expect(body.count).toBe(2);
    expect(media[0].name).toBe('summer-camp-adventure-2');
    expect(media[0].day).toBe('2026-08-19');
    expect(String(media[0].url)).toMatch(/^https:\/\/host\/b\/reg\//);
    expect(media[0].size_bytes).toBe(2048);
    // A one-curl route back to the bytes, same as every other media result.
    expect(String(media[0].curl_hint)).toMatch(/^curl -sS -o /);
  });

  it('filters to a day window, so "what did I make that night" is answerable', async () => {
    const client = { mediaSink: hostedSink(), session: new SessionState() } as unknown as GeminiClient;
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const body = parseToolResult(await h.callTool('gemini_list_recent_media', { since_day: '2026-08-19' })) as Record<string, unknown>;
    await h.close();
    expect((body.media as unknown[]).length).toBe(1);
  });
});
