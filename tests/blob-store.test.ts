import { describe, it, expect, vi } from 'vitest';
import { createBlobBucket, blobStoreFromEnv, prefixFromBaseUrl } from '../src/blob-store.js';

/**
 * The contract these tests defend is CROSS-REPO: mcp-host's gateway verifies
 * every signature this module mints, so a shape that drifts here fails there —
 * at runtime, in production, with a 403 that looks like a permissions problem.
 *
 * The payload shapes are reproduced independently below rather than imported,
 * so a change to `blob-store.ts` has to be made twice to pass. They must stay
 * byte-identical to `packages/gateway/src/blob-key.ts` in chrischall/mcp-host.
 */

// The host injects the immutable registration id, not <account>/<slug>.
const BASE = 'https://gw.test/b/reg_9f2c1a7b';
const KEY = 'test-signing-key';

/** Independent restatement of the gateway's four shapes. */
const shapes = {
  read: (k: string, e: number) => `${k}\n${e}`,
  write: (k: string, c: string, e: number) => `put\0${k}\0${c}\0${e}`,
  del: (k: string, e: number) => `del\0${k}\0${e}`,
  list: (p: string, e: number) => `list\0${p}\0${e}`,
  writePermanent: (k: string, c: string, e: number) => `putp\0${k}\0${c}\0${e}`,
};

async function expectedSig(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Buffer.from(mac).toString('base64url');
}

function capturingFetch(response: () => Response) {
  const calls: Array<{ url: URL; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? 'GET', body: init?.body });
    return response();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('prefixFromBaseUrl', () => {
  it('recovers the account/slug the gateway folds into every signature', () => {
    expect(prefixFromBaseUrl('https://gw.test/b/reg_9f2c1a7b')).toBe('reg_9f2c1a7b');
    expect(prefixFromBaseUrl('https://gw.test/b/reg_9f2c1a7b/')).toBe('reg_9f2c1a7b');
  });
});

describe('blob bucket signatures match the gateway contract', () => {
  const now = () => 1_000_000;

  it('signs a PUT over the FULL key, including the account/slug prefix', async () => {
    const { impl, calls } = capturingFetch(() => new Response(null, { status: 201 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    await bucket.put('gen/x.png', new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });

    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url.pathname).toBe('/b/reg_9f2c1a7b/gen/x.png');
    const exp = Number(call.url.searchParams.get('exp'));
    expect(exp).toBe(1_001_000);
    // The signature covers `chris/gemini/gen/x.png`, NOT `gen/x.png` — getting
    // this wrong is a 403 from the gateway on every write.
    expect(call.url.searchParams.get('sig')).toBe(
      await expectedSig(shapes.write('reg_9f2c1a7b/gen/x.png', 'image/png', exp)),
    );
  });

  it('signs a `lib/` write as PERMANENT, so retention never reclaims the library', async () => {
    // A saved character outlives every signed URL and every upload. The prefix
    // is the distinction and it is ours to know — the host only enforces what
    // was signed, so an ordinary write here would quietly expire someone's
    // library a month later.
    const { impl, calls } = capturingFetch(() => new Response(null, { status: 201 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    await bucket.put('lib/t1/char.json', '{}', { httpMetadata: { contentType: 'application/json' } });

    const call = calls[0]!;
    expect(call.url.searchParams.get('retain')).toBe('permanent');
    const exp = Number(call.url.searchParams.get('exp'));
    expect(call.url.searchParams.get('sig')).toBe(
      await expectedSig(shapes.writePermanent('reg_9f2c1a7b/lib/t1/char.json', 'application/json', exp)),
    );
  });

  it('signs a `gen/` write as ordinary, so generated media still expires', async () => {
    const { impl, calls } = capturingFetch(() => new Response(null, { status: 201 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    await bucket.put('gen/x.png', new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });

    expect(calls[0]!.url.searchParams.get('retain')).toBeNull();
  });

  it('signs a GET with the read shape, which the gateway will not accept as a write', async () => {
    const { impl, calls } = capturingFetch(() => new Response('bytes', { status: 200 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    await bucket.get('gen/x.png');

    const call = calls[0]!;
    const exp = Number(call.url.searchParams.get('exp'));
    expect(call.url.searchParams.get('sig')).toBe(
      await expectedSig(shapes.read('reg_9f2c1a7b/gen/x.png', exp)),
    );
    // Distinct from the write signature for the same key and expiry.
    expect(call.url.searchParams.get('sig')).not.toBe(
      await expectedSig(shapes.write('reg_9f2c1a7b/gen/x.png', 'image/png', exp)),
    );
  });

  it('signs a DELETE with its own shape', async () => {
    const { impl, calls } = capturingFetch(() => new Response(null, { status: 204 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    await bucket.delete('lib/t/char.json');

    const call = calls[0]!;
    expect(call.method).toBe('DELETE');
    const exp = Number(call.url.searchParams.get('exp'));
    expect(call.url.searchParams.get('sig')).toBe(
      await expectedSig(shapes.del('reg_9f2c1a7b/lib/t/char.json', exp)),
    );
  });

  it('signs a LIST over the RELATIVE prefix, not the full one', async () => {
    const { impl, calls } = capturingFetch(
      () => new Response(JSON.stringify({ objects: [{ key: 'lib/t/a.json' }], truncated: false }), { status: 200 }),
    );
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl, now, ttlMs: 1000 });

    const out = await bucket.list({ prefix: 'lib/t/' });

    const call = calls[0]!;
    expect(call.url.pathname).toBe('/b/reg_9f2c1a7b/');
    const exp = Number(call.url.searchParams.get('exp'));
    // Relative — the gateway signs what the caller asked for, not what it
    // reconstructed, so prefixing here would never verify.
    expect(call.url.searchParams.get('sig')).toBe(await expectedSig(shapes.list('lib/t/', exp)));
    expect(out.objects[0]!.key).toBe('lib/t/a.json');
  });
});

describe('blob bucket behaviour', () => {
  it('returns null for a missing object rather than throwing', async () => {
    const { impl } = capturingFetch(() => new Response(null, { status: 404 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl });
    await expect(bucket.get('gen/gone.png')).resolves.toBeNull();
  });

  it('treats a 404 on delete as success, since the gateway is idempotent', async () => {
    const { impl } = capturingFetch(() => new Response(null, { status: 404 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl });
    await expect(bucket.delete('lib/t/gone.json')).resolves.toBeUndefined();
  });

  it('throws on a real failure so a silent half-write is impossible', async () => {
    const { impl } = capturingFetch(() => new Response('nope', { status: 403 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl });
    await expect(bucket.put('gen/x.png', new Uint8Array([1]))).rejects.toThrow(/403/);
  });

  it('percent-encodes each key segment but never the separators', async () => {
    // The gateway decodes per segment and verifies against the LOGICAL key, so
    // the two sides only agree if separators survive and everything else is
    // encoded. Encoding the whole string would invent segments; encoding
    // nothing would break on a space.
    const { impl, calls } = capturingFetch(() => new Response('x', { status: 200 }));
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: impl });
    await bucket.get('gen/a b/c+d.png');
    expect(calls[0]!.url.pathname).toBe('/b/reg_9f2c1a7b/gen/a%20b/c%2Bd.png');
  });
});

describe('blobStoreFromEnv', () => {
  it('is absent unless BOTH variables are set, so a local install degrades cleanly', () => {
    expect(blobStoreFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_BASE_URL: BASE } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_SIGNING_KEY: KEY } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('builds the store when the host injects both', () => {
    const store = blobStoreFromEnv({
      MCP_BLOB_BASE_URL: BASE,
      MCP_BLOB_SIGNING_KEY: KEY,
    } as NodeJS.ProcessEnv);
    expect(store?.baseUrl).toBe(BASE);
    expect(typeof store?.signRead).toBe('function');
    expect(typeof store?.signWrite).toBe('function');
  });
});

describe('signed links stay inside the store ceiling', () => {
  it('clamps a per-persist override to 24h, so a set URL is not born invalid', async () => {
    // gemini_image_set asks for a 7-day link (SET_URL_TTL_MS). That is fine
    // against a bucket we own; the blob store refuses anything over 24h, so
    // without the clamp every set URL and bundle_url 403s on first click.
    const { createR2Sink } = await import('../src/storage/media.js');
    const { createBlobBucket } = await import('../src/blob-store.js');
    const t0 = 1_000_000_000;
    const bucket = createBlobBucket({ baseUrl: BASE, signingKey: KEY, fetchImpl: capturingFetch(() => new Response(null, { status: 201 })).impl });
    const sink = createR2Sink(bucket, {
      signedBaseUrl: BASE,
      sign: bucket.signRead,
      urlTtlMs: 60 * 60 * 1000,
      maxUrlTtlMs: 24 * 60 * 60 * 1000,
      now: () => new Date(t0),
    });

    const [ref] = await sink.persist(
      [{ base: 'x', base64: 'AAA=', mimeType: 'image/png' }],
      { urlTtlMs: 7 * 24 * 60 * 60 * 1000 },
    );

    const exp = Number(new URL(ref!.ref).searchParams.get('exp'));
    expect(exp - t0).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe('the default link life is the longest the store allows', () => {
  it('mints at the 24h ceiling, not something arbitrarily shorter', async () => {
    // The re-host cannot keep the old 48h default or the 7-day image_set
    // window — the store refuses any signature over 24h — but it should give
    // links the full life they can legally have rather than a fraction of it.
    const { createR2Sink } = await import('../src/storage/media.js');
    const { createBlobBucket } = await import('../src/blob-store.js');
    const t0 = 1_000_000_000;
    const bucket = createBlobBucket({
      baseUrl: BASE,
      signingKey: KEY,
      fetchImpl: capturingFetch(() => new Response(null, { status: 201 })).impl,
    });
    const sink = createR2Sink(bucket, {
      signedBaseUrl: BASE,
      sign: bucket.signRead,
      urlTtlMs: 24 * 60 * 60 * 1000,
      maxUrlTtlMs: 24 * 60 * 60 * 1000,
      now: () => new Date(t0),
    });

    // No per-persist override: this is the plain generate path.
    const [ref] = await sink.persist([{ base: 'x', base64: 'AAA=', mimeType: 'image/png' }], {});
    const exp = Number(new URL(ref!.ref).searchParams.get('exp'));
    expect(exp - t0).toBe(24 * 60 * 60 * 1000);
  });
});

describe('a stale or malformed base URL', () => {
  it('names the variable and the value instead of dying as `Invalid URL`', () => {
    // `blobStoreFromEnv` runs while client.ts builds its module-level
    // singleton, so this failure stops the server booting rather than failing
    // one request — and a bare TypeError from a stack that never mentions
    // storage is close to undebuggable from a host's logs.
    expect(() => prefixFromBaseUrl('${MCP_BLOB_BASE_URL}')).toThrow(/MCP_BLOB_BASE_URL is not a valid URL/);
    expect(() => prefixFromBaseUrl('')).toThrow(/https:\/\/<host>\/b\/<registrationId>/);
    expect(() =>
      blobStoreFromEnv({ MCP_BLOB_BASE_URL: 'not-a-url', MCP_BLOB_SIGNING_KEY: KEY } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_BLOB_BASE_URL/);
  });
});
