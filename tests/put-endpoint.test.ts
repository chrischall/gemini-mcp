import { describe, expect, it } from 'vitest';
import { createSignedPutHandler, wellFormedUploadKey, type PutBucket } from '../src/put-endpoint.js';
import { UPLOAD_URL_TTL_MS, buildUploadUrl, signUploadKey } from '../src/upload-url.js';
import { resolveSigningKey, type SecretStore } from '../src/media-url.js';

/**
 * `/put` accepts writes from anyone holding a valid signature and nobody else.
 * These tests drive the whole handler with real Request objects and a fake
 * bucket: the adversarial cases (tampering, expiry, wrong method, oversize,
 * content-type mismatch) must all be refused BEFORE anything is stored.
 */

const SECRET = 'put-endpoint-test-secret';
const NOW = 1_790_000_000_000;
const KEY = 'up/ab12cd34ef56/2026-07-31/deadbeef-photo.jpg';
const CT = 'image/jpeg';
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fakeStore(): SecretStore {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

function fakeBucket(): PutBucket & { puts: Array<{ key: string; bytes: Uint8Array; contentType?: string }> } {
  const puts: Array<{ key: string; bytes: Uint8Array; contentType?: string }> = [];
  return {
    puts,
    async put(key, value, options) {
      const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      puts.push({ key, bytes: new Uint8Array(view), contentType: options?.httpMetadata?.contentType });
    },
  };
}

async function signedUrl(key = KEY, ct = CT, expiresAtMs = NOW + UPLOAD_URL_TTL_MS, secret = SECRET): Promise<string> {
  const signingKey = await resolveSigningKey(secret, fakeStore());
  const sig = await signUploadKey(signingKey, key, ct, expiresAtMs);
  return buildUploadUrl('https://connector.example/put', key, ct, expiresAtMs, sig);
}

function putRequest(url: string, opts: { method?: string; body?: BodyInit | null; contentType?: string | null; contentLength?: string | null } = {}): Request {
  const headers = new Headers();
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? CT);
  if (opts.contentLength !== null) headers.set('content-length', opts.contentLength ?? String(BYTES.byteLength));
  return new Request(url, { method: opts.method ?? 'PUT', body: opts.body === undefined ? BYTES : opts.body, headers, ...(opts.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}

function handler(bucket = fakeBucket(), overrides: { maxBytes?: number; secretStored?: boolean } = {}) {
  const store = fakeStore();
  const h = createSignedPutHandler({
    bucket,
    store,
    secret: overrides.secretStored === false ? undefined : SECRET,
    now: () => NOW,
    maxBytes: overrides.maxBytes,
  });
  return { h, bucket };
}

describe('createSignedPutHandler', () => {
  it('stores a correctly signed upload and returns the r2_key with usage hints', async () => {
    const { h, bucket } = handler();
    const res = await h(putRequest(await signedUrl()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.r2_key).toBe(KEY);
    expect(body.size_bytes).toBe(BYTES.byteLength);
    expect(body.content_type).toBe(CT);
    expect(String(body.hint)).toMatch(/images_r2_keys/);
    expect(String(body.hint)).toMatch(/gemini_save_character/);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0].key).toBe(KEY);
    expect(bucket.puts[0].bytes).toEqual(BYTES);
    expect(bucket.puts[0].contentType).toBe(CT);
  });

  it('refuses non-PUT methods with 405 and stores nothing', async () => {
    const { h, bucket } = handler();
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await h(putRequest(await signedUrl(), { method, body: method === 'GET' ? null : BYTES }));
      expect(res.status).toBe(405);
    }
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses a tampered signature with 403', async () => {
    const { h, bucket } = handler();
    const url = new URL(await signedUrl());
    const sig = url.searchParams.get('sig')!;
    url.searchParams.set('sig', sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA'));
    const res = await h(putRequest(url.toString()));
    expect(res.status).toBe(403);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses a signature for a different key with 403 (path cannot be redirected)', async () => {
    const { h, bucket } = handler();
    const url = new URL(await signedUrl());
    url.pathname = url.pathname.replace('photo.jpg', 'other.jpg');
    const res = await h(putRequest(url.toString()));
    expect(res.status).toBe(403);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses an expired URL with 410 and a mint-a-fresh-one hint', async () => {
    const { h, bucket } = handler();
    const res = await h(putRequest(await signedUrl(KEY, CT, NOW - 1)));
    expect(res.status).toBe(410);
    expect(String(((await res.json()) as { hint: string }).hint)).toMatch(/gemini_get_upload_url/);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses everything when no signing secret was ever stored', async () => {
    const { h, bucket } = handler(fakeBucket(), { secretStored: false });
    const res = await h(putRequest(await signedUrl()));
    expect(res.status).toBe(403);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses an SVG content type outright with 415 — even correctly signed', async () => {
    // Belt and braces: the mint tool already refuses SVG, but the endpoint
    // must not trust that — a signature over image/svg+xml (e.g. minted by an
    // older deploy) still may not store a scriptable document.
    const { h, bucket } = handler();
    const res = await h(putRequest(await signedUrl(KEY, 'image/svg+xml'), { contentType: 'image/svg+xml' }));
    expect(res.status).toBe(415);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses a Content-Type that does not match the signed one with 415', async () => {
    const { h, bucket } = handler();
    const res = await h(putRequest(await signedUrl(), { contentType: 'image/png' }));
    expect(res.status).toBe(415);
    expect(String(((await res.json()) as { hint: string }).hint)).toContain('image/jpeg');
    expect(bucket.puts).toHaveLength(0);
  });

  it('requires Content-Length (411)', async () => {
    const { h, bucket } = handler();
    const res = await h(putRequest(await signedUrl(), { contentLength: null }));
    expect(res.status).toBe(411);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses an over-declared body with 413 before reading it', async () => {
    const { h, bucket } = handler(fakeBucket(), { maxBytes: 4 });
    const res = await h(putRequest(await signedUrl(), { contentLength: '5000000000' }));
    expect(res.status).toBe(413);
    expect(bucket.puts).toHaveLength(0);
  });

  it('enforces the cap on bytes actually read, not the declared length', async () => {
    const { h, bucket } = handler(fakeBucket(), { maxBytes: 4 });
    // Declares 2 bytes, streams 8: the lie must not get the payload stored.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES);
        controller.close();
      },
    });
    const res = await h(putRequest(await signedUrl(), { body: stream, contentLength: '2' }));
    expect(res.status).toBe(413);
    expect(bucket.puts).toHaveLength(0);
  });

  it('refuses malformed keys (wrong prefix, dot-segments, bad charset) without verifying', async () => {
    const { h, bucket } = handler();
    for (const key of ['gen/ab12cd34ef56/x.jpg', 'up/../secrets', 'up/a b/c.jpg', 'up']) {
      const url = new URL(await signedUrl());
      url.pathname = `/put/${key}`;
      const res = await h(putRequest(url.toString()));
      expect([403, 404]).toContain(res.status);
    }
    expect(bucket.puts).toHaveLength(0);
  });

  it('answers OPTIONS with 204 (allow: PUT)', async () => {
    const { h } = handler();
    const res = await h(putRequest(await signedUrl(), { method: 'OPTIONS', body: null }));
    expect(res.status).toBe(204);
    expect(res.headers.get('allow')).toContain('PUT');
  });
});

describe('wellFormedUploadKey', () => {
  it('accepts minted keys and refuses crafted ones', () => {
    expect(wellFormedUploadKey(KEY)).toBe(true);
    expect(wellFormedUploadKey('gen/tenant/x.jpg')).toBe(false);
    expect(wellFormedUploadKey('up/../x')).toBe(false);
    expect(wellFormedUploadKey('up//x')).toBe(false);
    expect(wellFormedUploadKey('up/a\u0000b')).toBe(false);
    expect(wellFormedUploadKey('up/a b')).toBe(false);
    expect(wellFormedUploadKey('up/a\nb')).toBe(false);
    expect(wellFormedUploadKey('up')).toBe(false);
  });
});
