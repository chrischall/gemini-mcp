import { describe, it, expect } from 'vitest';
import { createSignedPutHandler, type PutBucket } from '../src/put-endpoint.js';
import { createUploadUrlMinter, signUploadKey, verifyUploadSignature } from '../src/upload-url.js';
import { resolveSigningKey, type SecretStore } from '../src/media-url.js';
import { createR2Library, type LibraryBucket } from '../src/library.js';
import { buildZip, crc32 } from '../src/zip.js';

/**
 * The signed-upload and library paths, exercised inside workerd. Same rationale
 * as worker-upload-runtime.test.ts: WebIDL enforcement makes receiver mistakes
 * (`crypto.subtle`, `TextEncoder`, stream readers, `DataView`) throw here while
 * staying green under Node.
 */

const SECRET = 'workerd-put-secret';
const NOW = 1_790_000_000_000;

function fakeStore(): SecretStore {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

describe('signed PUT flow under workerd', () => {
  it('mint → PUT → stored, end to end', async () => {
    const store = fakeStore();
    const sign = async (key: string, ct: string, exp: number) =>
      signUploadKey(await resolveSigningKey(SECRET, store), key, ct, exp);
    const minter = createUploadUrlMinter({
      baseUrl: 'https://connector.example/put',
      sign,
      tenant: 'aaaaaaaaaaaa',
      now: () => new Date(NOW),
    });
    const minted = await minter.mint('finn.jpg', 'image/jpeg');

    const puts: Array<{ key: string; contentType?: string; size: number }> = [];
    const bucket: PutBucket = {
      async put(key, value, options) {
        puts.push({ key, contentType: options?.httpMetadata?.contentType, size: (value as Uint8Array).byteLength });
      },
    };
    const handler = createSignedPutHandler({ bucket, store, secret: SECRET, now: () => NOW });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const res = await handler(
      new Request(minted.url, {
        method: 'PUT',
        body: bytes,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) },
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { r2_key: string; size_bytes: number };
    expect(body.r2_key).toBe(minted.key);
    expect(body.size_bytes).toBe(bytes.byteLength);
    expect(puts).toEqual([{ key: minted.key, contentType: 'image/jpeg', size: bytes.byteLength }]);
  });

  it('verifies and refuses signatures with workerd WebCrypto', async () => {
    const key = await resolveSigningKey(SECRET, fakeStore());
    const sig = await signUploadKey(key, 'up/t/x.jpg', 'image/jpeg', NOW + 1000);
    expect(await verifyUploadSignature(key, 'up/t/x.jpg', 'image/jpeg', String(NOW + 1000), sig, NOW)).toEqual({ ok: true });
    expect((await verifyUploadSignature(key, 'up/t/other.jpg', 'image/jpeg', String(NOW + 1000), sig, NOW)).ok).toBe(false);
  });
});

describe('library + zip under workerd', () => {
  it('character save/read round-trips and buildZip produces a coherent archive', async () => {
    const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
    const bucket: LibraryBucket = {
      async put(key, value, options) {
        const bytes =
          typeof value === 'string'
            ? new TextEncoder().encode(value)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType });
      },
      async get(key) {
        const hit = objects.get(key);
        if (!hit) return null;
        return { arrayBuffer: async () => hit.bytes.buffer.slice(0) as ArrayBuffer, httpMetadata: { contentType: hit.contentType } };
      },
      async delete(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
      },
      async list({ prefix }) {
        const matching = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
        return { objects: matching.map((key) => ({ key })), truncated: false };
      },
    };
    const lib = createR2Library(bucket, { tenant: 'aaaaaaaaaaaa' });
    await lib.saveCharacter({ name: 'finn', description: 'boy', image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } });
    expect((await lib.readCharacterImage('finn'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((await lib.listCharacters()).map((c) => c.name)).toEqual(['finn']);

    const zip = buildZip([{ name: 'a.png', bytes: new Uint8Array([9, 9]) }]);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
