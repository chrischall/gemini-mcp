import { describe, it, expect } from 'vitest';
import { blobStoreFromEnv } from '../src/blob-store.js';
import { createR2Sink, tenantIdFor } from '../src/storage/media.js';
import { createUploadUrlMinter } from '../src/upload-url.js';
import { readFile } from 'node:fs/promises';

/**
 * The same loop as `upload-flow.test.ts`, but against the REAL deployment.
 *
 * Opt-in and skipped by default, because it needs this registration's own blob
 * credentials and CI has none — a test that cannot run in CI must not be able
 * to fail it. `tests/ci-gates.test.ts` covers what CI actually enforces; this
 * is the thing you run by hand after a re-host, which is exactly the moment the
 * signed-upload flow broke and nothing noticed.
 *
 *   GEMINI_LIVE_BLOB_BASE_URL=https://mcp.nullnet.app/b/reg_… \
 *   GEMINI_LIVE_BLOB_SIGNING_KEY=… \
 *   npx vitest run tests/upload-flow.live.test.ts
 *
 * Both values are what mcp-host injects into the deployment as
 * `MCP_BLOB_BASE_URL` / `MCP_BLOB_SIGNING_KEY`; they are deliberately NOT read
 * from those names, so a developer with a hosted `.env` sourced cannot run this
 * against production by accident.
 *
 * It cleans up after itself: the object it uploads is deleted at the end, so a
 * repeated run leaves nothing behind.
 */

const BASE_URL = process.env.GEMINI_LIVE_BLOB_BASE_URL;
const SIGNING_KEY = process.env.GEMINI_LIVE_BLOB_SIGNING_KEY;
const LIVE = Boolean(BASE_URL && SIGNING_KEY);

// A one-pixel JPEG's worth of bytes — enough to be a real object, small enough
// to be polite about it.
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xd9]);

describe.skipIf(!LIVE)('signed uploads against the deployed host', () => {
  const store = () => {
    const blob = blobStoreFromEnv({} as NodeJS.ProcessEnv, { baseUrl: BASE_URL!, signingKey: SIGNING_KEY! })!;
    const tenant = () => tenantIdFor(process.env.GEMINI_API_KEY ?? 'live-test');
    return {
      blob,
      tenant,
      uploadUrls: createUploadUrlMinter({ links: blob.links, sign: blob.signWrite, tenant }),
      mediaSink: createR2Sink(blob.bucket, {
        links: blob.links,
        sign: blob.signRead,
        urlTtlMs: 60 * 60 * 1000,
        maxUrlTtlMs: 24 * 60 * 60 * 1000,
        readPrefixes: ['up', 'lib'],
        tenant,
      }),
    };
  };

  it('mints → PUTs → reads the bytes back by r2_key', async () => {
    const { blob, uploadUrls, mediaSink } = store();
    const minted = await uploadUrls.mint('live-upload-probe.jpg', 'image/jpeg');
    expect(minted.url.startsWith(`${BASE_URL!.replace(/\/+$/, '')}/`)).toBe(true);

    try {
      const res = await fetch(minted.url, {
        method: 'PUT',
        headers: { 'content-type': minted.contentType },
        body: BYTES as unknown as BodyInit,
      });
      // Any 2xx: the gateway's body is not part of the contract, and the
      // r2_key to keep is the minted one.
      expect(res.ok, `PUT returned ${res.status}: ${await res.text()}`).toBe(true);

      // The round trip that actually matters — this is what a generation does
      // when handed `images_r2_keys`.
      const stored = await mediaSink.read!(minted.key);
      expect(stored?.bytes).toEqual(BYTES);
      expect(stored?.mimeType).toBe('image/jpeg');
    } finally {
      await blob.bucket.delete(minted.key).catch(() => {});
    }
  }, 60_000);

  it('refuses a tampered signature and a mismatched content type', async () => {
    const { uploadUrls } = store();
    const minted = await uploadUrls.mint('live-upload-negative.jpg', 'image/jpeg');

    const tampered = new URL(minted.url);
    tampered.searchParams.set('sig', `${tampered.searchParams.get('sig')!.slice(0, -1)}X`);
    const forged = await fetch(tampered, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: BYTES as unknown as BodyInit });
    expect(forged.ok).toBe(false);

    const wrongType = await fetch(minted.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: BYTES as unknown as BodyInit });
    expect(wrongType.ok, 'the signature covers the content type, so a mismatched header must be refused').toBe(false);
  }, 60_000);
});

describe('the live upload probe stays opt-in', () => {
  it('reads its own env names, never the ones a hosted .env would define', async () => {
    // If this file ever read MCP_BLOB_BASE_URL / MCP_BLOB_SIGNING_KEY directly,
    // sourcing a production .env would silently point the suite — writes and
    // deletes included — at the live store. The separate names are the guard.
    const source = await readFile(new URL(import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('const BASE_URL'));
    expect(body).not.toMatch(/process\.env\.MCP_BLOB_(BASE_URL|SIGNING_KEY)/);
    expect(body).toContain('GEMINI_LIVE_BLOB_BASE_URL');
  });
});
