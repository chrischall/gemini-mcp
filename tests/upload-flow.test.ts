import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createFakeGateway } from './fixtures/blob-gateway.js';
import { blobStoreFromEnv } from '../src/blob-store.js';
import { createR2Sink, tenantIdFor } from '../src/storage/media.js';
import { createUploadUrlMinter, UPLOAD_MAX_BYTES } from '../src/upload-url.js';
import { registerUploadUrlTools } from '../src/tools/uploads.js';
import { registerGenerateTools } from '../src/tools/generate.js';
import { GeminiClient } from '../src/client.js';

/**
 * The whole signed-upload loop, end to end, against a gateway that actually
 * verifies signatures (tests/fixtures/blob-gateway.ts):
 *
 *   gemini_get_upload_url  →  curl-equivalent PUT  →  201  →  r2_key
 *                          →  images_r2_keys on a generation  →  the bytes
 *
 * Every test before this one stopped at the mint and asserted the URL's shape.
 * That is what let the re-host from the retired Cloudflare connector to
 * mcp-host move media links onto `/b/<registrationId>/` while the upload
 * builder kept its own base: both halves were "correct" in isolation and the
 * flow was broken. This exercises the join.
 */

const API_KEY = 'test-api-key';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The hosted wiring, verbatim: one blob store, one `links`, both consumers. */
function hosted(gateway = createFakeGateway()) {
  const blob = blobStoreFromEnv({} as NodeJS.ProcessEnv, {
    baseUrl: gateway.baseUrl,
    signingKey: gateway.signingKey,
    fetchImpl: gateway.fetch,
  })!;
  const tenant = () => tenantIdFor(API_KEY);
  const mediaSink = createR2Sink(blob.bucket, {
    links: blob.links,
    sign: blob.signRead,
    urlTtlMs: 24 * 60 * 60 * 1000,
    maxUrlTtlMs: 24 * 60 * 60 * 1000,
    readPrefixes: ['up', 'lib'],
    tenant,
  });
  const uploadUrls = createUploadUrlMinter({ links: blob.links, sign: blob.signWrite, tenant });
  return { gateway, blob, mediaSink, uploadUrls, tenant };
}

/** What `curl -X PUT -H "Content-Type: …" --data-binary @file` does. */
async function put(
  gateway: ReturnType<typeof createFakeGateway>,
  url: string,
  bytes: Uint8Array,
  contentType: string,
  method = 'PUT',
) {
  return gateway.fetch(url, { method, headers: { 'content-type': contentType }, body: bytes } as RequestInit);
}

async function mint(uploadUrls: ReturnType<typeof hosted>['uploadUrls'], name = 'family-carter-finley.jpg') {
  const h = await createTestHarness((s) =>
    registerUploadUrlTools(s, { uploadUrls } as unknown as GeminiClient),
  );
  const body = parseToolResult<{ upload_url: string; r2_key: string; content_type: string; curl_hint: string }>(
    await h.callTool('gemini_get_upload_url', { filename: name, content_type: 'image/jpeg' }),
  );
  await h.close();
  return body;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('the signed-upload loop, mint → PUT → r2_key → generation', () => {
  it('stores the bytes under the minted key and returns 201', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);

    // The link must live in the SAME key space the media links do — this is
    // the assertion the re-host would have failed.
    expect(minted.upload_url.startsWith(`${gateway.baseUrl}/`)).toBe(true);
    expect(minted.r2_key).toMatch(/^up\/[0-9a-f]{12}\/\d{4}-\d{2}-\d{2}\//);

    const res = await put(gateway, minted.upload_url, JPEG, 'image/jpeg');
    expect(res.status).toBe(201);
    expect(gateway.objects.get(minted.r2_key)?.bytes).toEqual(JPEG);
    expect(gateway.objects.get(minted.r2_key)?.contentType).toBe('image/jpeg');
    // Uploads are sweepable; only the library is permanent.
    expect(gateway.objects.get(minted.r2_key)?.permanent).toBe(false);
  });

  it('hands back an r2_key a generation then resolves through images_r2_keys', async () => {
    const { gateway, mediaSink, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);
    expect((await put(gateway, minted.upload_url, JPEG, 'image/jpeg')).status).toBe(201);

    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG } }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const client = new GeminiClient({ apiKey: API_KEY, mediaSink, uploadUrls, fetchImpl });

    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const out = parseToolResult<{ images: string[]; media?: Array<{ r2_key?: string }> }>(
      await h.callTool('gemini_image_edit', { prompt: 'make it snow', images_r2_keys: [minted.r2_key] }),
    );
    await h.close();

    // The uploaded bytes reached the model as an inline reference part…
    const sent = JSON.parse(String((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body));
    const parts = sent.contents[0].parts as Array<Record<string, { data?: string; mime_type?: string }>>;
    expect(parts.some((p) => p.inline_data?.mime_type === 'image/jpeg')).toBe(true);
    // …and the generation came back with a media link in the same key space.
    expect(out.images[0]!.startsWith(`${gateway.baseUrl}/`)).toBe(true);
  });

  it('mints media GET and upload PUT links into one key space, so a re-host cannot split them', async () => {
    const { gateway, mediaSink, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);
    const [persisted] = await mediaSink.persist([{ base: 'x', base64: PNG, mimeType: 'image/png' }], {});

    const get = new URL(persisted!.ref);
    const upload = new URL(minted.upload_url);
    expect(upload.origin).toBe(get.origin);
    expect(upload.pathname.startsWith(new URL(gateway.baseUrl).pathname)).toBe(true);
    expect(get.pathname.startsWith(new URL(gateway.baseUrl).pathname)).toBe(true);
  });

  it('produces a curl_hint whose Content-Type is the one the signature covers', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);
    // The gateway authenticates on the HEADER, so the hint carrying the right
    // -H is load-bearing, not decoration.
    expect(minted.curl_hint).toContain(`-H "Content-Type: ${minted.content_type}"`);
    expect((await put(gateway, minted.upload_url, JPEG, minted.content_type)).status).toBe(201);
  });
});

describe('the signed-upload loop refuses what it should', () => {
  it('rejects an expired signature', async () => {
    let clock = 1_800_000_000_000;
    const gateway = createFakeGateway({ now: () => clock });
    const { uploadUrls } = hosted(gateway);
    const minted = await mint(uploadUrls);

    clock += 11 * 60 * 1000; // past the ~10 minute TTL
    const res = await put(gateway, minted.upload_url, JPEG, 'image/jpeg');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'signature expired' });
    expect(gateway.objects.size).toBe(0);
  });

  it('rejects a tampered signature', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);
    const tampered = new URL(minted.upload_url);
    tampered.searchParams.set('sig', `${tampered.searchParams.get('sig')!.slice(0, -1)}X`);

    expect((await put(gateway, tampered.toString(), JPEG, 'image/jpeg')).status).toBe(403);
    expect(gateway.objects.size).toBe(0);
  });

  it('rejects a tampered KEY, so a signature cannot be moved to another object', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);
    const moved = minted.upload_url.replace(minted.r2_key.split('/').pop()!, 'someone-elses.jpg');

    expect((await put(gateway, moved, JPEG, 'image/jpeg')).status).toBe(403);
    expect(gateway.objects.size).toBe(0);
  });

  it('rejects the wrong method — an upload URL is PUT-only', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);

    expect((await put(gateway, minted.upload_url, JPEG, 'image/jpeg', 'POST')).status).toBe(405);
    // A GET carries a write signature, which is not a read signature.
    expect((await gateway.fetch(minted.upload_url)).status).toBe(403);
    expect(gateway.objects.size).toBe(0);
  });

  it('rejects a Content-Type the URL was not minted for', async () => {
    const { gateway, uploadUrls } = hosted();
    const minted = await mint(uploadUrls);

    // The signature covers the content type, so `image/png` bytes cannot be
    // stored under a URL minted for `image/jpeg` — nor can `text/html`, which
    // is the reason the cover exists (media is served from the app origin).
    expect((await put(gateway, minted.upload_url, JPEG, 'image/png')).status).toBe(403);
    expect((await put(gateway, minted.upload_url, JPEG, 'text/html')).status).toBe(403);
    expect((await put(gateway, minted.upload_url, JPEG, '')).status).toBe(403);
    expect(gateway.objects.size).toBe(0);
  });

  it('refuses to mint for a non-raster type at all', async () => {
    const { uploadUrls } = hosted();
    const h = await createTestHarness((s) => registerUploadUrlTools(s, { uploadUrls } as unknown as GeminiClient));
    for (const content_type of ['image/svg+xml', 'video/mp4', 'text/html']) {
      expect((await h.callTool('gemini_get_upload_url', { filename: 'x', content_type })).isError).toBe(true);
    }
    await h.close();
  });

  it('rejects an oversize body while reading it, not on the declared length', async () => {
    const gateway = createFakeGateway({ maxBytes: 1024 });
    const { uploadUrls } = hosted(gateway);
    const minted = await mint(uploadUrls);

    expect((await put(gateway, minted.upload_url, new Uint8Array(2048), 'image/jpeg')).status).toBe(413);
    expect(gateway.objects.size).toBe(0);
    // The tool advertises the cap it expects the gateway to enforce.
    expect(UPLOAD_MAX_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe('a mint is atomic: it cannot leave partial state', () => {
  it('never touches storage, so there is nothing to orphan when it fails', async () => {
    const { gateway, uploadUrls } = hosted();
    await mint(uploadUrls);
    // No reservation, no pending-upload record, no placeholder object. This is
    // what makes "the call partially took" impossible for this tool: a mint is
    // a tenant id, a key string and one HMAC.
    expect(gateway.requests).toEqual([]);
    expect(gateway.objects.size).toBe(0);
  });

  it('still mints while the store is completely unreachable', async () => {
    // Corollary of the above, and worth pinning: a gateway outage cannot be
    // the cause of a mint failure, which rules it out during triage.
    const { gateway, uploadUrls } = hosted(createFakeGateway({ offline: true }));
    const minted = await mint(uploadUrls);
    expect(minted.upload_url).toContain('/up/');
    expect(gateway.requests).toEqual([]);
  });

  it('fails at construction when the deployment has no blob base URL', () => {
    // The "missing env" case, and the reason it is a throw rather than a
    // fallback: a minter with nowhere to point produced URLs reading
    // `undefined/up/…`, which fail much later and much less legibly.
    expect(() => createUploadUrlMinter({ sign: async () => 'x', tenant: 't' })).toThrow(/MCP_BLOB_BASE_URL/);
    expect(blobStoreFromEnv({ MCP_BLOB_SIGNING_KEY: 'k' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_BASE_URL: 'https://x/b/reg_1' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('leaves the upload tool unregistered rather than half-configured', async () => {
    // A local install has no blob store; the tool must be absent, not present
    // and broken. `hostedStorage()` returns {} wholesale for the same reason.
    const names: string[] = [];
    registerUploadUrlTools(
      { registerTool: (n: string) => names.push(n) } as never,
      { uploadUrls: undefined } as unknown as GeminiClient,
    );
    expect(names).toEqual([]);
  });
});
