import { describe, it, expect, vi } from 'vitest';
import {
  signMediaKey,
  verifyMediaSignature,
  buildMediaUrl,
  MEDIA_URL_TTL_MS,
} from '../src/media-url.js';
import { hmacKey } from './fixtures/hmac-key.js';

/**
 * The `/media` route is the only part of the connector that is NOT behind
 * OAuth — a browser opening a link and a curl in a sandbox carry no bearer
 * token, and demanding one would recreate exactly the problem the route exists
 * to solve. So the signature has to carry the whole weight, and these tests are
 * about that: a link works for the one object it names, and nothing else does.
 */

function memoryBucket(objects: Record<string, { body: string; contentType?: string; etag?: string }> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      const hit = objects[key];
      if (!hit) return null;
      return {
        body: new Blob([hit.body]).stream() as unknown as ReadableStream,
        httpMetadata: { contentType: hit.contentType },
        size: hit.body.length,
        ...(hit.etag ? { httpEtag: hit.etag } : {}),
        arrayBuffer: async () => new TextEncoder().encode(hit.body).buffer as ArrayBuffer,
      };
    }),
  };
}

const KEY = 'gen/2026-07-29/abc123-a-cat.png';

describe('signature verification', () => {
  const key = () => hmacKey('test-secret');
  const future = Date.now() + 60_000;

  it('accepts a signature it just minted', async () => {
    const k = await key();
    const sig = await signMediaKey(k, KEY, future);
    await expect(verifyMediaSignature(k, KEY, String(future), sig, Date.now())).resolves.toEqual({ ok: true });
  });

  it('rejects a signature minted for a DIFFERENT object', async () => {
    const k = await key();
    const sig = await signMediaKey(k, KEY, future);
    // The whole security property: one link opens one object.
    const other = await verifyMediaSignature(k, 'gen/2026-07-29/other-secret.png', String(future), sig, Date.now());
    expect(other).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered expiry — you cannot extend your own link', async () => {
    const k = await key();
    const sig = await signMediaKey(k, KEY, future);
    const extended = await verifyMediaSignature(k, KEY, String(future + 86_400_000), sig, Date.now());
    expect(extended).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered signature', async () => {
    const k = await key();
    const sig = await signMediaKey(k, KEY, future);
    // Flip the FIRST character, not the last. An HMAC-SHA256 is 32 bytes, which
    // base64url-encodes to 43 characters — 258 bits of alphabet for 256 bits of
    // data — so the final character carries only 4 significant bits and two of
    // its bit positions are discarded on decode. Mutating it is a no-op about
    // 8% of the time, which is exactly the sort of test that passes locally and
    // fails in CI (it did). Every bit of the first character is significant.
    const flipped = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    expect(flipped).not.toBe(sig);
    expect(await verifyMediaSignature(k, KEY, String(future), flipped, Date.now())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a truncated signature', async () => {
    const k = await key();
    const sig = await signMediaKey(k, KEY, future);
    expect(await verifyMediaSignature(k, KEY, String(future), sig.slice(0, 20), Date.now())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a signature from a different secret', async () => {
    const mine = await hmacKey('secret-a');
    const theirs = await hmacKey('secret-b');
    const sig = await signMediaKey(theirs, KEY, future);
    expect(await verifyMediaSignature(mine, KEY, String(future), sig, Date.now())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports expiry only for an AUTHENTIC link — a forgery is never told it was close', async () => {
    const k = await key();
    const past = Date.now() - 1000;
    const sig = await signMediaKey(k, KEY, past);
    expect(await verifyMediaSignature(k, KEY, String(past), sig, Date.now())).toEqual({ ok: false, reason: 'expired' });
    // Same expired timestamp, wrong signature ⇒ 'invalid', not 'expired'.
    expect(await verifyMediaSignature(k, KEY, String(past), 'AAAA', Date.now())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects missing or unparseable parameters', async () => {
    const k = await key();
    expect(await verifyMediaSignature(k, KEY, null, null, Date.now())).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyMediaSignature(k, KEY, 'not-a-number', 'AAAA', Date.now())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('defaults to a 48h lifetime, matching Files API retention', () => {
    expect(MEDIA_URL_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe('buildMediaUrl', () => {
  it('encodes each path segment and appends the query', () => {
    const url = buildMediaUrl('https://c.example.com/media', 'gen/2026-07-29/a b.png', 123, 'SIG');
    expect(url).toBe('https://c.example.com/media/gen/2026-07-29/a%20b.png?exp=123&sig=SIG');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildMediaUrl('https://c.example.com/media/', 'k.png', 1, 's')).toBe('https://c.example.com/media/k.png?exp=1&sig=s');
  });
});
