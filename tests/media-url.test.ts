import { describe, it, expect, vi } from 'vitest';
import {
  resolveSigningKey,
  loadSigningKey,
  signMediaKey,
  verifyMediaSignature,
  buildMediaUrl,
  SIGNING_SECRET_KV_KEY,
  MEDIA_URL_TTL_MS,
} from '../src/media-url.js';
import { createMediaHandler } from '../src/media-endpoint.js';

/**
 * The `/media` route is the only part of the connector that is NOT behind
 * OAuth — a browser opening a link and a curl in a sandbox carry no bearer
 * token, and demanding one would recreate exactly the problem the route exists
 * to solve. So the signature has to carry the whole weight, and these tests are
 * about that: a link works for the one object it names, and nothing else does.
 */

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
  };
}

function memoryBucket(objects: Record<string, { body: string; contentType?: string }> = {}) {
  return {
    get: vi.fn(async (key: string) => {
      const hit = objects[key];
      if (!hit) return null;
      return {
        body: new Blob([hit.body]).stream() as unknown as ReadableStream,
        httpMetadata: { contentType: hit.contentType },
        size: hit.body.length,
      };
    }),
  };
}

const KEY = 'gen/2026-07-29/abc123-a-cat.png';

describe('signing key resolution', () => {
  it('uses MEDIA_URL_SECRET when the operator sets one, touching no storage', async () => {
    const store = memoryStore();
    await resolveSigningKey('a-configured-secret', store);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('generates and persists a secret when unset — the zero-config path', async () => {
    const store = memoryStore();
    await resolveSigningKey(undefined, store);

    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.data.get(SIGNING_SECRET_KV_KEY)).toMatch(/^[\w-]{40,}$/);
  });

  it('reuses the persisted secret on later calls, so old links keep working', async () => {
    const store = memoryStore();
    const first = await resolveSigningKey(undefined, store);
    const sig = await signMediaKey(first, KEY, 1);

    const second = await resolveSigningKey(undefined, store);
    expect(store.put).toHaveBeenCalledTimes(1); // not regenerated
    await expect(verifyMediaSignature(second, KEY, '1', sig, 0)).resolves.toEqual({ ok: true });
  });

  it('treats a blank secret as unset rather than signing with empty string', async () => {
    const store = memoryStore();
    await resolveSigningKey('   ', store);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});

describe('only the SIGNING side may create a secret', () => {
  /**
   * KV is eventually consistent: a `put` on one isolate is not immediately
   * visible to another, and a read can miss for a while. If verification also
   * created-on-miss, that miss would mint a NEW secret and overwrite the one
   * every outstanding link was signed with — turning a transient read miss
   * into permanent 403s for media that was signed correctly. A self-inflicted
   * denial of service, and irreversible.
   */
  it('loadSigningKey never writes, and returns undefined when nothing is stored', async () => {
    const store = memoryStore();
    await expect(loadSigningKey(undefined, store)).resolves.toBeUndefined();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('a verify against a stale/empty KV read does NOT clobber the signing secret', async () => {
    const store = memoryStore();
    const signing = await resolveSigningKey(undefined, store);
    const secret = store.data.get(SIGNING_SECRET_KV_KEY);
    const exp = Date.now() + 60_000;
    const sig = await signMediaKey(signing, KEY, exp);

    // Simulate the eventually-consistent miss the verify path can hit. Its own
    // `put` spy, so the assertion below is about the VERIFY call and not about
    // the signing call above that legitimately wrote the secret.
    const stalePut = vi.fn(async (k: string, v: string) => { store.data.set(k, v); });
    await loadSigningKey(undefined, { get: vi.fn(async () => null), put: stalePut });

    expect(stalePut).not.toHaveBeenCalled();
    expect(store.data.get(SIGNING_SECRET_KV_KEY)).toBe(secret);
    // The link signed before the miss still verifies afterwards.
    const after = await loadSigningKey(undefined, store);
    await expect(verifyMediaSignature(after!, KEY, String(exp), sig, Date.now())).resolves.toEqual({ ok: true });
  });

  it('the media route 403s rather than creating a secret when none is stored', async () => {
    const store = memoryStore();
    const bucket = memoryBucket({ [KEY]: { body: 'x' } });
    const res = await createMediaHandler({ bucket, store })(
      new Request(`https://c.example.com/media/${KEY}?exp=${Date.now() + 1000}&sig=AAAA`),
    );

    expect(res.status).toBe(403);
    expect(store.put).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });
});

describe('signature verification', () => {
  const key = () => resolveSigningKey('test-secret', memoryStore());
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
    const mine = await resolveSigningKey('secret-a', memoryStore());
    const theirs = await resolveSigningKey('secret-b', memoryStore());
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

describe('GET /media/<key>', () => {
  const secret = 'test-secret';
  async function signedUrl(key = KEY, expiresAtMs = Date.now() + 60_000) {
    const k = await resolveSigningKey(secret, memoryStore());
    return buildMediaUrl('https://c.example.com/media', key, expiresAtMs, await signMediaKey(k, key, expiresAtMs));
  }

  const handler = (bucket: ReturnType<typeof memoryBucket>, now?: () => number) =>
    createMediaHandler({ bucket, store: memoryStore(), secret, now });

  it('streams the object with its stored content type', async () => {
    const bucket = memoryBucket({ [KEY]: { body: 'PNGBYTES', contentType: 'image/png' } });
    const res = await handler(bucket)(new Request(await signedUrl()));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Model output rendered by a browser: never let sniffing reinterpret it.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('PNGBYTES');
    expect(bucket.get).toHaveBeenCalledWith(KEY);
  });

  it('answers HEAD without a body — what a link preview sends first', async () => {
    const bucket = memoryBucket({ [KEY]: { body: 'PNGBYTES', contentType: 'image/png' } });
    const res = await handler(bucket)(new Request(await signedUrl(), { method: 'HEAD' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('8');
    expect(await res.text()).toBe('');
  });

  it('refuses an unsigned request — the bucket is not browsable', async () => {
    const bucket = memoryBucket({ [KEY]: { body: 'x' } });
    const res = await handler(bucket)(new Request(`https://c.example.com/media/${KEY}`));

    expect(res.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled(); // rejected before touching storage
  });

  it('refuses a signature lifted from another object', async () => {
    const bucket = memoryBucket({ 'gen/2026-07-29/private.png': { body: 'secret' } });
    const exp = Date.now() + 60_000;
    const k = await resolveSigningKey(secret, memoryStore());
    const stolen = await signMediaKey(k, KEY, exp);
    const res = await handler(bucket)(
      new Request(`https://c.example.com/media/gen/2026-07-29/private.png?exp=${exp}&sig=${stolen}`),
    );

    expect(res.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('reports an expired link as 410, with what to do about it', async () => {
    const bucket = memoryBucket({ [KEY]: { body: 'x' } });
    const expired = Date.now() - 1000;
    const res = await handler(bucket)(new Request(await signedUrl(KEY, expired)));

    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/expired.*re-run the generation/is);
  });

  it('404s a validly-signed key whose object was cleaned up', async () => {
    const res = await handler(memoryBucket({}))(new Request(await signedUrl()));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/cleaned up/i);
  });

  it('rejects a non-GET method', async () => {
    const res = await handler(memoryBucket({}))(new Request(await signedUrl(), { method: 'POST' }));
    expect(res.status).toBe(405);
  });

  it('round-trips a key containing characters that need encoding', async () => {
    const key = 'gen/2026-07-29/ab12-a cat.png';
    const bucket = memoryBucket({ [key]: { body: 'BYTES', contentType: 'image/png' } });
    const res = await handler(bucket)(new Request(await signedUrl(key)));

    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(key);
  });
});
