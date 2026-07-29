import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImageInputs, requireImageInput, hasImageInput } from '../src/inputs.js';
import { SessionState } from '../src/session.js';
import { createDiskSink, createR2Sink } from '../src/storage/media.js';
import type { GeminiClient } from '../src/client.js';

vi.mock('../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcA==', mimeType: 'image/jpeg' }),
}));

/**
 * `resolveImageInputs` is the funnel every reference image passes through, so
 * these tests are really about one promise: **a caller never has to put image
 * bytes in the conversation.** A URL is fetched by the server; a `files/…` uri
 * is passed by reference; a local path that gets reused is promoted to an
 * upload so the bytes stop being re-sent.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

interface Stub {
  client: GeminiClient;
  session: SessionState;
  fetchRemoteImage: ReturnType<typeof vi.fn>;
  uploadBytes: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
}

function stubClient(opts: { onDisk?: boolean; fetchBytes?: Uint8Array; fetchMime?: string } = {}): Stub {
  const session = new SessionState();
  const fetchRemoteImage = vi.fn(async (url: string) => ({
    bytes: opts.fetchBytes ?? PNG_BYTES,
    mimeType: opts.fetchMime ?? 'image/png',
    size: (opts.fetchBytes ?? PNG_BYTES).byteLength,
    finalUrl: url,
    requestedUrl: url,
  }));
  let n = 0;
  const uploadBytes = vi.fn(async (_bytes: Uint8Array, mimeType: string, displayName: string) => {
    n += 1;
    return {
      name: `files/up${n}`,
      uri: `https://generativelanguage.googleapis.com/v1beta/files/up${n}`,
      mimeType,
      displayName,
      expirationTime: new Date(Date.now() + 48 * 3600_000).toISOString(),
    };
  });
  const getFile = vi.fn(async (ref: string) => ({
    name: ref.replace(/^.*\/(files\/)/, '$1'),
    uri: `https://generativelanguage.googleapis.com/v1beta/${ref.replace(/^.*\/(files\/)/, '$1')}`,
    mimeType: 'image/webp',
  }));
  const client = {
    mediaSink: opts.onDisk === false ? createR2Sink({ put: async () => ({}) }, {}) : createDiskSink(),
    session,
    fetchRemoteImage,
    uploadBytes,
    getFile,
  } as unknown as GeminiClient;
  return { client, session, fetchRemoteImage, uploadBytes, getFile };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-inputs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('images_url', () => {
  it('fetches server-side and yields an INLINE part — no bytes in the tool call', async () => {
    const s = stubClient();
    const { inputs, report } = await resolveImageInputs({ images_url: ['https://cdn.example.com/a.png'] }, s.client);

    expect(s.fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(inputs).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    expect(report?.fetched_urls).toEqual([{ url: 'https://cdn.example.com/a.png', mime_type: 'image/png', bytes: PNG_BYTES.byteLength }]);
    // Nothing needed uploading at this size.
    expect(s.uploadBytes).not.toHaveBeenCalled();
  });

  it('uploads a LARGE fetched image to the Files API instead of inlining it', async () => {
    // generateContent caps a whole request near 20MB, so a 7MB inline reference
    // would risk failing the request itself.
    const big = new Uint8Array(7 * 1024 * 1024).fill(9);
    const s = stubClient({ fetchBytes: big, fetchMime: 'image/jpeg' });
    const { inputs, report } = await resolveImageInputs({ images_url: ['https://cdn.example.com/big.jpg'] }, s.client);

    expect(s.uploadBytes).toHaveBeenCalledTimes(1);
    expect(inputs[0].uri).toMatch(/files\/up1$/);
    expect(inputs[0].base64).toBeUndefined();
    expect(report?.fetched_urls?.[0].file_uri).toBe('files/up1');
  });

  it('fetches a repeated URL exactly ONCE within a call', async () => {
    const s = stubClient();
    const url = 'https://cdn.example.com/same.png';
    const { inputs } = await resolveImageInputs({ images_url: [url, url, url] }, s.client);

    expect(s.fetchRemoteImage).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toBe(inputs[2]);
  });

  it('propagates the fetch error verbatim — the caller must see which URL failed', async () => {
    const s = stubClient();
    s.fetchRemoteImage.mockRejectedValueOnce(new Error('https://x/y.png returned HTTP 403'));
    await expect(resolveImageInputs({ images_url: ['https://x/y.png'] }, s.client)).rejects.toThrow(/y\.png returned HTTP 403/);
  });
});

describe('images_file_uris', () => {
  it('passes a Files API reference straight through as a by-reference part', async () => {
    const s = stubClient();
    const { inputs, report } = await resolveImageInputs({ images_file_uris: ['files/abc123'] }, s.client);

    expect(inputs).toEqual([{ uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123', mimeType: 'image/webp' }]);
    expect(report?.file_uris).toEqual(['files/abc123']);
    // The whole point: nothing was fetched and nothing was uploaded.
    expect(s.fetchRemoteImage).not.toHaveBeenCalled();
    expect(s.uploadBytes).not.toHaveBeenCalled();
  });

  it('accepts the full uri form and resolves it once per distinct reference', async () => {
    const s = stubClient();
    const full = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
    const { inputs } = await resolveImageInputs({ images_file_uris: [full, full] }, s.client);

    expect(s.getFile).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(2);
  });
});

describe('input ordering', () => {
  it('returns nothing, and touches nothing, for a call with no image inputs', async () => {
    const s = stubClient();
    const { inputs, report } = await resolveImageInputs({}, s.client);
    expect(inputs).toEqual([]);
    expect(report).toBeUndefined();
    expect(s.fetchRemoteImage).not.toHaveBeenCalled();
    expect(s.getFile).not.toHaveBeenCalled();
  });

  it('loads paths before base64, each decoded to its sniffed MIME', async () => {
    const s = stubClient();
    const pngPath = join(dir, 'in.png');
    writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');

    const { inputs } = await resolveImageInputs({ images: [pngPath], images_base64: [jpegB64] }, s.client);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({ base64: PNG_B64, mimeType: 'image/png' });
    expect(inputs[1].mimeType).toBe('image/jpeg');
  });

  it('keeps clipboard → paths → base64 → urls → file_uris', async () => {
    const s = stubClient();
    const p = join(dir, 'ref.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    const { inputs } = await resolveImageInputs(
      {
        from_clipboard: true,
        images: [p],
        images_base64: ['data:image/gif;base64,R0lGOD'],
        images_url: ['https://cdn.example.com/a.png'],
        images_file_uris: ['files/abc'],
      },
      s.client,
    );

    expect(inputs.map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/png', 'image/webp']);
  });
});

describe('local paths auto-upload on repeat use (stdio)', () => {
  it('stays inline the FIRST time a path is referenced', async () => {
    const s = stubClient();
    const p = join(dir, 'once.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    const { inputs, report } = await resolveImageInputs({ images: [p] }, s.client);
    expect(inputs[0].base64).toBe(PNG_B64);
    expect(s.uploadBytes).not.toHaveBeenCalled();
    expect(report).toBeUndefined();
  });

  it('uploads ONCE on the second reference, then reuses the uri for free', async () => {
    const s = stubClient();
    const p = join(dir, 'twice.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    const first = await resolveImageInputs({ images: [p] }, s.client);
    expect(first.inputs[0].base64).toBeTruthy();

    const second = await resolveImageInputs({ images: [p] }, s.client);
    expect(s.uploadBytes).toHaveBeenCalledTimes(1);
    expect(second.inputs[0].uri).toMatch(/files\/up1$/);
    expect(second.report?.auto_uploaded?.[0]).toMatchObject({ path: p, file_uri: 'files/up1' });

    const third = await resolveImageInputs({ images: [p] }, s.client);
    // Served from the session cache — no second upload.
    expect(s.uploadBytes).toHaveBeenCalledTimes(1);
    expect(third.inputs[0].uri).toMatch(/files\/up1$/);
  });

  it('does NOT reuse the upload after the file changes on disk', async () => {
    const s = stubClient();
    const p = join(dir, 'edited.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    await resolveImageInputs({ images: [p] }, s.client);
    await resolveImageInputs({ images: [p] }, s.client);
    expect(s.uploadBytes).toHaveBeenCalledTimes(1);

    // Same path, different bytes: the cache key carries mtime + size, so the
    // stale upload must not be reused — it holds the OLD picture.
    writeFileSync(p, Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.from('extra')]));
    utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const after = await resolveImageInputs({ images: [p] }, s.client);
    expect(after.inputs[0].base64).toBeTruthy();
    expect(after.inputs[0].uri).toBeUndefined();
  });

  it('falls back to inline when the promotion upload fails', async () => {
    const s = stubClient();
    s.uploadBytes.mockRejectedValue(new Error('Files API down'));
    const p = join(dir, 'flaky.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    await resolveImageInputs({ images: [p] }, s.client);
    const second = await resolveImageInputs({ images: [p] }, s.client);
    // An optimization must never turn a working call into a failing one.
    expect(second.inputs[0].base64).toBe(PNG_B64);
  });

  it('scopes the cache to the session — a second session re-uploads rather than borrowing', async () => {
    const a = stubClient();
    const b = stubClient();
    const p = join(dir, 'shared.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));

    await resolveImageInputs({ images: [p] }, a.client);
    await resolveImageInputs({ images: [p] }, a.client);
    expect(a.uploadBytes).toHaveBeenCalledTimes(1);

    // A uri is minted by ONE user's key and readable only with that key, so
    // session B must not inherit A's reference.
    const firstForB = await resolveImageInputs({ images: [p] }, b.client);
    expect(firstForB.inputs[0].base64).toBeTruthy();
    expect(b.uploadBytes).not.toHaveBeenCalled();
  });
});

describe('input presence helpers', () => {
  it('hasImageInput recognises every form', () => {
    expect(hasImageInput({})).toBe(false);
    expect(hasImageInput({ images: [] })).toBe(false);
    expect(hasImageInput({ images: ['a.png'] })).toBe(true);
    expect(hasImageInput({ images_url: ['https://x/y.png'] })).toBe(true);
    expect(hasImageInput({ images_file_uris: ['files/a'] })).toBe(true);
    expect(hasImageInput({ images_base64: ['AAAA'] })).toBe(true);
    expect(hasImageInput({ from_clipboard: true })).toBe(true);
  });

  it('requireImageInput names the context-free options FIRST', () => {
    let message = '';
    try { requireImageInput({}); } catch (e) { message = (e as Error).message; }
    expect(message.indexOf('images_url')).toBeLessThan(message.indexOf('images_base64'));
    expect(message).toContain('images_file_uris');
  });
});
