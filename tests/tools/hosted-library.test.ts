import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { GeminiClient } from '../../src/client.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { createR2Sink } from '../../src/storage/media.js';
import { createR2Library, type LibraryBucket } from '../../src/library.js';

/**
 * `characters` / `style` on the generation tools are what make the saved
 * library usable: name a character and its reference image + description ride
 * along automatically; name a style and its fragment lands in the prompt. And
 * a multi-image set on the hosted sink comes back with a single bundle_url zip
 * plus week-long links — the retrieval half of the same workflow.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
const NOW = new Date('2026-07-31T12:00:00Z');

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

/** A hosted-shaped client: R2 sink + library over one shared fake bucket. */
async function hostedClient() {
  const bucket = fakeBucket();
  const library = createR2Library(bucket, { tenant: 'aaaaaaaaaaaa', now: () => NOW });
  await library.saveCharacter({ name: 'finn', description: '6-year-old boy, curly red hair', image: { bytes: PNG_BYTES, mimeType: 'image/png' } });
  await library.saveCharacter({ name: 'bongo', description: 'a drum-playing monkey', image: { bytes: PNG_BYTES, mimeType: 'image/png' } });
  await library.saveStyle({ name: 'bold-cartoon-sports', promptFragment: 'bold cartoon style, thick outlines' });
  const client = new GeminiClient({
    mediaSink: createR2Sink(bucket, {
      signedBaseUrl: 'https://connector.example/media',
      sign: async (key, exp) => `sig-${key.length}-${exp}`,
      urlTtlMs: 48 * 3600_000,
      now: () => NOW,
      tenant: 'aaaaaaaaaaaa',
    }),
    library,
  });
  return { client, bucket };
}

const IMAGE = { images: [{ base64: PNG_B64, mimeType: 'image/png' }] };

describe('gemini_image_set with characters + style (hosted)', () => {
  it('attaches saved references everywhere, composes prompts, bundles, and signs for ~7 days', async () => {
    const { client, bucket } = await hostedClient();
    const spy = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_image_set', {
        master_prompt: 'Finn and Bongo on a soccer field',
        scenes: ['kicking the ball', 'celebrating a goal', 'walking home at sunset'],
        characters: ['finn', 'bongo'],
        style: 'bold-cartoon-sports',
        aspect_ratio: '16:9',
      }),
    );
    await h.close();

    // Master: character preamble + caller prompt + style fragment; both
    // character references attached (nothing else).
    const master = spy.mock.calls[0][0];
    expect(master.prompt).toContain('(1) finn — 6-year-old boy, curly red hair');
    expect(master.prompt).toContain('(2) bongo — a drum-playing monkey');
    expect(master.prompt).toContain('Finn and Bongo on a soccer field');
    expect(master.prompt).toContain('Style: bold cartoon style, thick outlines');
    expect(master.images).toHaveLength(2);

    // Scenes: master image + both character references; style fragment only
    // (the master image anchors identity, so no in-order preamble claim).
    for (const call of spy.mock.calls.slice(1)) {
      expect(call[0].images).toHaveLength(3);
      expect(call[0].prompt).toContain('Style: bold cartoon style');
      expect(call[0].prompt).not.toContain('attached reference images');
    }

    // Result meta echoes what the library contributed.
    expect(res.characters).toEqual(['finn', 'bongo']);
    expect(res.style).toBe('bold-cartoon-sports');

    // One bundle zip of all four images, with its own key + curl_hint.
    expect(String(res.bundle_url)).toContain('https://connector.example/media/');
    const bundle = res.bundle as Record<string, unknown>;
    expect(String(bundle.r2_key)).toMatch(/-bundle\.zip$/);
    expect(bundle.files).toHaveLength(4);
    expect(String(bundle.curl_hint)).toContain('curl -sS -o');
    expect(bucket.objects.has(String(bundle.r2_key))).toBe(true);

    // Set links are signed for ~7 days, not the default ~48h.
    const media = res.media as Array<{ expires_at: string }>;
    const week = new Date(NOW.getTime() + 7 * 24 * 3600_000).toISOString();
    for (const entry of media) expect(entry.expires_at).toBe(week);
    expect((bundle.expires_at as string)).toBe(week);
  });

  it('fails fast on an unknown character name — before any billable call', async () => {
    const { client } = await hostedClient();
    const spy = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const res = await h.callTool('gemini_image_set', { master_prompt: 'x', scenes: ['y'], characters: ['nemo'] });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No saved character .{0,4}nemo/);
    expect(JSON.stringify(res.content)).toMatch(/bongo, finn/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('gemini_image_generate with characters (hosted)', () => {
  it('attaches the saved reference and composes the prompt', async () => {
    const { client } = await hostedClient();
    const spy = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_image_generate', { prompt: 'Finn brushing his teeth', characters: ['finn'] }),
    );
    await h.close();

    expect(spy.mock.calls[0][0].images).toHaveLength(1);
    expect(spy.mock.calls[0][0].prompt).toContain('(1) finn — 6-year-old boy');
    expect(res.characters).toEqual(['finn']);
  });

  it('gemini_image_edit accepts characters as its only image input', async () => {
    const { client } = await hostedClient();
    const spy = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'put Finn in a spacesuit', characters: ['finn'] });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(spy.mock.calls[0][0].images).toHaveLength(1);
  });
});

describe('large character references', () => {
  it('promotes a >6MB saved reference to a Files API upload instead of inlining it', async () => {
    const { client } = await hostedClient();
    const big = new Uint8Array(7 * 1024 * 1024).fill(7);
    await client.library!.saveCharacter({ name: 'jumbo', description: 'an elephant', image: { bytes: big, mimeType: 'image/png' } });
    const uploadBytes = vi.spyOn(client, 'uploadBytes').mockResolvedValue({
      name: 'files/big1',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/big1',
      mimeType: 'image/png',
    } as never);
    const generate = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    await h.callTool('gemini_image_generate', { prompt: 'Jumbo at the beach', characters: ['jumbo'] });
    await h.close();

    expect(uploadBytes).toHaveBeenCalledTimes(1);
    const input = (generate.mock.calls[0][0].images as Array<{ uri?: string; base64?: string }>)[0];
    expect(input.uri).toMatch(/files\/big1$/);
    expect(input.base64).toBeUndefined();
  });
});

describe('characters on a server with no library (stdio)', () => {
  it('says the library is hosted-only and names the direct alternatives', async () => {
    const client = new GeminiClient({});
    const spy = vi.spyOn(client, 'generate').mockResolvedValue(IMAGE);
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'x', characters: ['finn'] });
    await h.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/hosted connector only/);
    expect(spy).not.toHaveBeenCalled();
  });
});
