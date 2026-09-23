import { describe, it, expect, afterEach, vi } from 'vitest';
import { createFakeGateway } from './fixtures/blob-gateway.js';
import { blobStoreFromEnv } from '../src/blob-store.js';
import { hostedStorage } from '../src/client.js';
import { pinnedTenant, tenantResolver, TENANT_PIN_KEY } from '../src/tenant.js';
import { tenantIdFor } from '../src/storage/media.js';

/**
 * chrischall/fleet-audit#116: the hosted tenant id used to be a hash of
 * GEMINI_API_KEY, recomputed every process. Rotating the key — which the
 * healthcheck's own `credential_rejected` hint tells the user to do — moved
 * every namespace (lib/, jobs/, gen/, up/) to a fresh prefix, so the
 * "NO expiry" character/style library silently came back empty.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function blobFor(gateway: ReturnType<typeof createFakeGateway>) {
  return blobStoreFromEnv({} as NodeJS.ProcessEnv, {
    baseUrl: gateway.baseUrl,
    signingKey: gateway.signingKey,
    fetchImpl: gateway.fetch,
  })!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hosted tenant survives an API-key rotation', () => {
  it('a character saved under one key is still listed after the key is rotated', async () => {
    const gateway = createFakeGateway();

    vi.stubEnv('GEMINI_API_KEY', 'old-key');
    const before = hostedStorage(blobFor(gateway));
    await before.library!.saveCharacter({ name: 'finn', description: 'a boy', image: { bytes: PNG, mimeType: 'image/png' } });

    // A fresh process after the user rotated the key.
    vi.stubEnv('GEMINI_API_KEY', 'new-key');
    const after = hostedStorage(blobFor(gateway));
    expect((await after.library!.listCharacters()).map((c) => c.name)).toEqual(['finn']);
  });

  it('pins to the CURRENT key hash on first use, so data written before the pin existed stays reachable', async () => {
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    const tenant = pinnedTenant(blob.bucket, () => tenantIdFor('existing-key'));
    expect(await tenant()).toBe(await tenantIdFor('existing-key'));
    const pin = gateway.objects.get(TENANT_PIN_KEY)!;
    expect(pin).toBeDefined();
    // Written under lib/ so the host's retention prune never reclaims it.
    expect(pin.permanent).toBe(true);
  });

  it('a stored pin wins over the derivation', async () => {
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    await pinnedTenant(blob.bucket, () => 'aaaaaaaaaaaa')();
    const derive = vi.fn(() => 'bbbbbbbbbbbb');
    expect(await pinnedTenant(blob.bucket, derive)()).toBe('aaaaaaaaaaaa');
    expect(derive).not.toHaveBeenCalled();
  });

  it('memoises: one store round-trip per process, not per call', async () => {
    const gateway = createFakeGateway();
    const tenant = pinnedTenant(blobFor(gateway).bucket, () => 'aaaaaaaaaaaa');
    await tenant();
    const seen = gateway.requests.length;
    await tenant();
    await tenant();
    expect(gateway.requests.length).toBe(seen);
  });

  it('ignores a malformed pin rather than namespacing under garbage', async () => {
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    await blob.bucket.put(TENANT_PIN_KEY, JSON.stringify({ tenant: '../escape' }), {
      httpMetadata: { contentType: 'application/json' },
    });
    expect(await pinnedTenant(blob.bucket, () => 'cccccccccccc')()).toBe('cccccccccccc');
  });

  it('does not cache a failed read, so a transient store outage is retried', async () => {
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    const flaky = {
      ...blob.bucket,
      get: vi.fn().mockRejectedValueOnce(new Error('blob get failed (503)')).mockImplementation(blob.bucket.get),
    };
    const tenant = pinnedTenant(flaky, () => 'dddddddddddd');
    await expect(tenant()).rejects.toThrow(/503/);
    expect(await tenant()).toBe('dddddddddddd');
  });

  it('still resolves when writing the pin fails, and retries the pin next call', async () => {
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    const flaky = {
      ...blob.bucket,
      put: vi.fn().mockRejectedValueOnce(new Error('blob put failed (503)')).mockImplementation(blob.bucket.put),
    };
    const tenant = pinnedTenant(flaky, () => 'eeeeeeeeeeee');
    expect(await tenant()).toBe('eeeeeeeeeeee');
    expect(gateway.objects.has(TENANT_PIN_KEY)).toBe(false);
    expect(await tenant()).toBe('eeeeeeeeeeee');
    expect(gateway.objects.has(TENANT_PIN_KEY)).toBe(true);
  });
});

describe('stores do not cache a failed tenant resolution', () => {
  const failingOnce = () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValueOnce(new Error('blob get failed (503)')).mockResolvedValue('aaaaaaaaaaaa');
    return fn;
  };

  it('library retries the tenant after a transient failure', async () => {
    const { createR2Library } = await import('../src/library.js');
    const gateway = createFakeGateway();
    const library = createR2Library(blobFor(gateway).bucket, { tenant: failingOnce() });
    await expect(library.listCharacters()).rejects.toThrow(/503/);
    await expect(library.listCharacters()).resolves.toEqual([]);
  });

  it('media sink retries the tenant after a transient failure', async () => {
    const { createR2Sink } = await import('../src/storage/media.js');
    const gateway = createFakeGateway();
    const blob = blobFor(gateway);
    const sink = createR2Sink(blob.bucket, { links: blob.links, sign: blob.signRead, tenant: failingOnce() });
    const item = { base: 'x', base64: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' };
    await expect(sink.persist([item], {})).rejects.toThrow(/503/);
    const [persisted] = await sink.persist([item], {});
    expect(persisted.key).toMatch(/^gen\/aaaaaaaaaaaa\//);
  });
});

describe('tenantResolver', () => {
  it('passes a static tenant through (including undefined)', async () => {
    await expect(tenantResolver('abc')()).resolves.toBe('abc');
    await expect(tenantResolver<string | undefined>(undefined)()).resolves.toBeUndefined();
  });

  it('resolves a function source once and caches the success', async () => {
    const source = vi.fn(async () => 'abc123abc123');
    const resolve = tenantResolver(source);
    await expect(resolve()).resolves.toBe('abc123abc123');
    await expect(resolve()).resolves.toBe('abc123abc123');
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight resolution between concurrent callers', async () => {
    const source = vi.fn(async () => 't');
    const resolve = tenantResolver(source);
    await Promise.all([resolve(), resolve(), resolve()]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('drops a rejected resolution instead of caching it', async () => {
    const source = vi.fn()
      .mockRejectedValueOnce(new Error('store blip'))
      .mockResolvedValueOnce('recovered');
    const resolve = tenantResolver<string>(source);
    await expect(resolve()).rejects.toThrow('store blip');
    await expect(resolve()).resolves.toBe('recovered');
    await expect(resolve()).resolves.toBe('recovered');
    expect(source).toHaveBeenCalledTimes(2);
  });
});
