import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { GeminiClient } from '../../src/client.js';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { createR2Sink } from '../../src/storage/media.js';
import { createR2Library, type LibraryBucket } from '../../src/library.js';

/**
 * Regression guard for the hosted connector's "Illegal invocation" outage:
 * `GeminiClient` stored the global `fetch` in a class field and invoked it as
 * `this.fetchImpl(...)`, handing native fetch the client instance as its
 * receiver. workerd's WebIDL receiver check rejects that with "Illegal
 * invocation: function called with incorrect 'this' reference" — while Node's
 * fetch does not care, so every node-pool test stayed green and the crash was
 * production-only. The reachable trigger was the Files API upload: every
 * reference form promotes a >6MB image through `uploadBytes`, so generations
 * with r2_key uploads (15MB cap), saved characters copied from those uploads,
 * and large fetched URLs all failed, while text-only generation (no upload)
 * and library writes (no promotion) kept working.
 *
 * `strictReceiverFetch` emulates the workerd semantics — callable with an
 * undefined or global receiver, throwing on anything else — and every test
 * here runs the REAL client code against it (no client-method spies), one
 * generation per reference form, exactly the sweep that would have caught
 * this before it shipped.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
const NOW = new Date('2026-08-01T12:00:00Z');
const TENANT = 'aaaaaaaaaaaa';
const SESSION_URL = 'https://upload.example/session?upload_id=1';
const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/promoted1';

function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket: LibraryBucket & {
    objects: typeof objects;
    put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  } = {
    objects,
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.bytes.buffer.slice(0) as ArrayBuffer,
        httpMetadata: { contentType: hit.contentType },
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix }) {
      const matching = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { objects: matching.map((key) => ({ key })), truncated: false };
    },
  };
  return bucket;
}

type FetchCall = { url: string; init?: RequestInit };

/**
 * A fetch stub with workerd's receiver semantics: the real runtime's native
 * fetch throws unless `this` is undefined or the global scope, so any call
 * shaped `something.fetchImpl(...)` fails here exactly as it fails in
 * production. It serves every upstream this suite needs: `generateContent`,
 * the Files API resumable dance, and one public image URL.
 */
function strictReceiverFetch() {
  const calls: FetchCall[] = [];
  const dispatch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes(':generateContent')) {
      return Response.json({
        candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_B64 } }] } }],
      });
    }
    if (url.includes('/upload/v1beta/files')) {
      return new Response(null, { status: 200, headers: { 'x-goog-upload-url': SESSION_URL } });
    }
    if (url.startsWith(SESSION_URL)) {
      return Response.json({
        file: { name: 'files/promoted1', uri: FILE_URI, mimeType: 'image/png', state: 'ACTIVE' },
      });
    }
    if (url === 'https://images.example/ref.png') {
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  const fetchImpl = function (this: unknown, input: unknown, init?: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect 'this' reference.");
    }
    return dispatch(String(input), init as RequestInit);
  } as typeof fetch;
  return { fetchImpl, calls };
}

/** A hosted-shaped client over the strict fetch: R2 sink + library, no spies. */
function hostedClient() {
  const bucket = fakeBucket();
  const { fetchImpl, calls } = strictReceiverFetch();
  const client = new GeminiClient({
    apiKey: 'test-key',
    fetchImpl,
    mediaSink: createR2Sink(bucket, {
      signedBaseUrl: 'https://connector.example/media',
      sign: async (key, exp) => `sig-${key.length}-${exp}`,
      urlTtlMs: 48 * 3600_000,
      now: () => NOW,
      readPrefixes: ['up', 'lib'],
      tenant: TENANT,
    }),
    library: createR2Library(bucket, { tenant: TENANT, now: () => NOW }),
  });
  return { client, bucket, calls };
}

async function generateWith(client: GeminiClient, args: Record<string, unknown>) {
  const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
  const res = await h.callTool('gemini_image_generate', args);
  await h.close();
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return parseToolResult<Record<string, unknown>>(res);
}

/** The generateContent body of the last upstream call, for part assertions. */
function lastGenerateBody(calls: FetchCall[]) {
  const call = [...calls].reverse().find((c) => c.url.includes(':generateContent'));
  expect(call).toBeTruthy();
  return JSON.parse(String(call!.init?.body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
}

describe('one generation per reference form, under workerd receiver semantics', () => {
  it('images_base64', async () => {
    const { client, calls } = hostedClient();
    await generateWith(client, { prompt: 'a red square, from base64', images_base64: [PNG_B64] });
    expect(lastGenerateBody(calls).contents[0].parts).toHaveLength(2);
  });

  it('images_url (server-side fetch)', async () => {
    const { client, calls } = hostedClient();
    const res = await generateWith(client, { prompt: 'a red square, from a url', images_url: ['https://images.example/ref.png'] });
    const report = res.image_inputs as { fetched_urls: Array<{ url: string }> };
    expect(report.fetched_urls[0].url).toBe('https://images.example/ref.png');
    expect(lastGenerateBody(calls).contents[0].parts).toHaveLength(2);
  });

  it('images_r2_keys (connector-store read)', async () => {
    const { client, bucket, calls } = hostedClient();
    const key = `up/${TENANT}/2026-08-01/abc-ref.png`;
    await bucket.put(key, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
    await generateWith(client, { prompt: 'a red square, from an r2 key', images_r2_keys: [key] });
    expect(lastGenerateBody(calls).contents[0].parts).toHaveLength(2);
  });

  it('characters (saved library reference)', async () => {
    const { client, calls } = hostedClient();
    await client.library!.saveCharacter({ name: 'finn', description: 'a boy', image: { bytes: PNG_BYTES, mimeType: 'image/png' } });
    await generateWith(client, { prompt: 'Finn on a bike', characters: ['finn'] });
    expect(lastGenerateBody(calls).contents[0].parts).toHaveLength(2);
  });
});

describe('the >6MB Files-API promotion — the path that crashed in production', () => {
  const BIG = new Uint8Array(7 * 1024 * 1024).fill(7);

  it('promotes a large r2_key through uploadBytes without an Illegal invocation', async () => {
    const { client, bucket, calls } = hostedClient();
    const key = `up/${TENANT}/2026-08-01/def-big.png`;
    await bucket.put(key, BIG, { httpMetadata: { contentType: 'image/png' } });
    const res = await generateWith(client, { prompt: 'a big reference, from an r2 key', images_r2_keys: [key] });

    // The resumable dance ran: start, then finalize on the session URL.
    expect(calls.some((c) => c.url.includes('/upload/v1beta/files'))).toBe(true);
    expect(calls.some((c) => c.url.startsWith(SESSION_URL))).toBe(true);
    // The image rode by reference, not inline, and the report says so.
    const parts = lastGenerateBody(calls).contents[0].parts;
    expect(parts[1]).toEqual({ file_data: { file_uri: FILE_URI, mime_type: 'image/png' } });
    const report = res.image_inputs as { r2_keys: Array<{ file_uri?: string }> };
    expect(report.r2_keys[0].file_uri).toBe('files/promoted1');
  });

  it('promotes a large saved character without an Illegal invocation', async () => {
    const { client, calls } = hostedClient();
    await client.library!.saveCharacter({ name: 'jumbo', description: 'an elephant', image: { bytes: BIG, mimeType: 'image/png' } });
    await generateWith(client, { prompt: 'Jumbo at the beach', characters: ['jumbo'] });
    expect(lastGenerateBody(calls).contents[0].parts[1]).toEqual({ file_data: { file_uri: FILE_URI, mime_type: 'image/png' } });
  });

  it('uploadBytes itself never hands fetch a foreign receiver', async () => {
    const { fetchImpl } = strictReceiverFetch();
    const client = new GeminiClient({ apiKey: 'test-key', fetchImpl });
    const up = await client.uploadBytes(PNG_BYTES, 'image/png', 'ref.png');
    expect(up.uri).toBe(FILE_URI);
  });
});
