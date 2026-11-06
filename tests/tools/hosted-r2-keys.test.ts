import { describe, it, expect, vi, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { GeminiClient } from '../../src/client.js';
import { createR2Sink, type MediaBucket } from '../../src/storage/media.js';
import { registerVideoTools } from '../../src/tools/video.js';
import { registerMusicTools } from '../../src/tools/music.js';
import { registerInteractTools } from '../../src/tools/interact.js';

/**
 * `images_r2_keys` on the three interaction-backed tools.
 *
 * The upload tool's own result, the README and the SKILL all said an `r2_key`
 * from `gemini_get_upload_url` was usable "on any generation tool" — and on
 * video, music and interact it was not a parameter at all. On the hosted
 * connector, where `images` paths are refused, that left a caller with a photo
 * and a shell no zero-token route into those three tools.
 *
 * Every case here runs the REAL `resolveImageInputs` → `readStoredMedia` →
 * `createR2Sink.read` path, so the ownership gate is the production one; only
 * the upstream generation call is stubbed.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
const MP4 = 'AAAAIGZ0eXBpc29tAAAAAA==';
const MP3 = 'SUQzBAAAAAAAAA==';
const TENANT = 'tenant0000aa';
const OTHER_TENANT = 'tenant1111bb';
const OWN_KEY = `up/${TENANT}/2026-11-01/abcd1234-reference.png`;
const FOREIGN_KEY = `up/${OTHER_TENANT}/2026-11-01/efgh5678-reference.png`;

function memoryBucket(): MediaBucket & { objects: Map<string, { bytes: Uint8Array; contentType?: string }>; deleted: string[] } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.bytes.buffer.slice(0) as ArrayBuffer,
        httpMetadata: { contentType: hit.contentType },
      };
    },
    // Present so a test can prove nothing ever calls it: references are reused.
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) { deleted.push(k); objects.delete(k); }
    },
  } as MediaBucket & { objects: typeof objects; deleted: string[] };
}

/** A hosted-shaped client: tenant-scoped R2 sink that may read `up/`. */
function hostedClient() {
  const bucket = memoryBucket();
  bucket.objects.set(OWN_KEY, { bytes: PNG_BYTES, contentType: 'image/png' });
  bucket.objects.set(FOREIGN_KEY, { bytes: PNG_BYTES, contentType: 'image/png' });
  const client = new GeminiClient({
    apiKey: 'test-key',
    fetchImpl: (async () => { throw new Error('no upstream in this test'); }) as typeof fetch,
    mediaSink: createR2Sink(bucket, {
      publicBaseUrl: 'https://media.example',
      readPrefixes: ['up', 'lib'],
      tenant: TENANT,
    }),
  });
  return { client, bucket };
}

type Case = {
  tool: string;
  register: (server: McpServer, client: GeminiClient) => void;
  args: Record<string, unknown>;
  stub: (client: GeminiClient) => ReturnType<typeof vi.spyOn>;
};

const CASES: Case[] = [
  {
    tool: 'gemini_video_generate',
    register: registerVideoTools,
    args: { prompt: 'animate this still', task: 'image_to_video' },
    stub: (c) => vi.spyOn(c, 'generateVideo').mockResolvedValue({ id: 'vid-1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] }),
  },
  {
    tool: 'gemini_music_generate',
    register: registerMusicTools,
    args: { prompt: 'a calm tune for this picture' },
    stub: (c) => vi.spyOn(c, 'generateMusic').mockResolvedValue({ id: 'mus-1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] }),
  },
  {
    tool: 'gemini_interact',
    register: registerInteractTools,
    args: { input: 'make it winter' },
    stub: (c) => vi.spyOn(c, 'interact').mockResolvedValue({ id: 'int-1', images: [{ base64: PNG_B64, mimeType: 'image/png' }] }),
  },
];

afterEach(() => { vi.restoreAllMocks(); });

describe.each(CASES)('$tool — images_r2_keys', ({ tool, register, args, stub }) => {
  it('advertises images_r2_keys and points the hosted caller at gemini_get_upload_url', async () => {
    const { client } = hostedClient();
    const h = await createTestHarness((srv) => register(srv, client));
    const { tools } = await h.client.listTools();
    await h.close();
    const def = tools.find((t) => t.name === tool)!;
    expect(Object.keys(def.inputSchema.properties ?? {})).toContain('images_r2_keys');
    expect(def.description).toMatch(/gemini_get_upload_url/);
    expect(def.description).toMatch(/images_r2_keys/);
  });

  it('reads an owned upload out of the store and sends it as an inline reference', async () => {
    const { client, bucket } = hostedClient();
    const spy = stub(client);
    const h = await createTestHarness((srv) => register(srv, client));
    const res = await h.callTool(tool, { ...args, images_r2_keys: [OWN_KEY] });
    await h.close();
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = (spy.mock.calls[0][0] as { images?: unknown[] }).images;
    expect(sent).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    const data = parseToolResult<{ image_inputs?: { r2_keys?: Array<{ r2_key: string; bytes: number }> } }>(res);
    expect(data.image_inputs?.r2_keys).toEqual([{ r2_key: OWN_KEY, mime_type: 'image/png', bytes: PNG_BYTES.byteLength }]);
    // A reference is reused across generations (and may later be saved into
    // the library), so using it must never consume it.
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(OWN_KEY)).toBe(true);
  });

  it("refuses another tenant's key before any billable call, indistinguishably from a swept one", async () => {
    const { client } = hostedClient();
    const spy = stub(client);
    const h = await createTestHarness((srv) => register(srv, client));
    const res = await h.callTool(tool, { ...args, images_r2_keys: [FOREIGN_KEY] });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No stored media for r2_key/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the same upload usable for a second generation', async () => {
    const { client } = hostedClient();
    const spy = stub(client);
    const h = await createTestHarness((srv) => register(srv, client));
    const first = await h.callTool(tool, { ...args, images_r2_keys: [OWN_KEY] });
    const second = await h.callTool(tool, { ...args, images_r2_keys: [OWN_KEY], idempotency_key: 'second-run' });
    await h.close();
    expect(first.isError).toBeFalsy();
    expect(second.isError, JSON.stringify(second.content)).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe two in-flight calls that differ only by r2 key', async () => {
    const { client, bucket } = hostedClient();
    const otherOwn = `up/${TENANT}/2026-11-01/ijkl9012-other.png`;
    bucket.objects.set(otherOwn, { bytes: PNG_BYTES, contentType: 'image/png' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = stub(client);
    const inner = spy.getMockImplementation();
    spy.mockImplementation(async (...a: unknown[]) => { await gate; return (inner as (...x: unknown[]) => unknown)(...a); });
    const h = await createTestHarness((srv) => register(srv, client));
    const a = h.callTool(tool, { ...args, images_r2_keys: [OWN_KEY] });
    const b = h.callTool(tool, { ...args, images_r2_keys: [otherOwn] });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    release!();
    await Promise.all([a, b]);
    await h.close();
  });
});

describe('the stdio surface', () => {
  it.each(CASES)('$tool does not carry images_r2_keys where no store can answer it', async ({ tool, register }) => {
    // A disk install has no blob store, so an r2_key can never resolve there:
    // the param would be standing token cost on every request for nothing.
    const client = new GeminiClient({ apiKey: 'k' });
    const h = await createTestHarness((srv) => register(srv, client));
    const { tools } = await h.client.listTools();
    await h.close();
    const def = tools.find((t) => t.name === tool)!;
    expect(Object.keys(def.inputSchema.properties ?? {})).not.toContain('images_r2_keys');
    expect(def.description).not.toMatch(/gemini_get_upload_url/);
  });
});
