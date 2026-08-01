import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerLibraryTools } from '../../src/tools/library.js';
import { createR2Library, type LibraryBucket } from '../../src/library.js';
import { SessionState } from '../../src/session.js';
import type { GeminiClient } from '../../src/client.js';

/**
 * The library tools are the persistence half of the character workflow: save a
 * reference once, use it forever by name. These tests drive the registrar
 * end-to-end over a real (fake-bucket-backed) library, because the contract
 * that matters — what round-trips — lives in the pair, not either half.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeBucket(): LibraryBucket {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
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
}

function stub(overrides: Record<string, unknown> = {}): GeminiClient {
  return {
    library: createR2Library(fakeBucket(), { tenant: 'aaaaaaaaaaaa' }),
    session: new SessionState(),
    readStoredMedia: vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' })),
    fetchRemoteImage: vi.fn(async (url: string) => ({
      bytes: PNG_BYTES, mimeType: 'image/jpeg', size: PNG_BYTES.byteLength, finalUrl: url, requestedUrl: url,
    })),
    ...overrides,
  } as unknown as GeminiClient;
}

describe('registration gating', () => {
  it('registers nothing when the client has no library (stdio)', async () => {
    const names: string[] = [];
    const server = { registerTool: (name: string) => { names.push(name); } };
    registerLibraryTools(server as never, { library: undefined } as never);
    expect(names).toEqual([]);
  });
});

describe('gemini_save_character', () => {
  it('saves from an r2_key (the connector reads its own store) and echoes usage guidance', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_save_character', {
        name: 'finn',
        description: '6-year-old boy, curly red hair',
        image_r2_key: 'up/aaaaaaaaaaaa/2026-07-31/x-finn.jpg',
      }),
    );
    await h.close();

    expect(body.saved).toBe('character');
    expect(body.name).toBe('finn');
    expect(String(body.hint)).toMatch(/characters:/);
    expect((client.readStoredMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('up/aaaaaaaaaaaa/2026-07-31/x-finn.jpg');
    // Round-trips: the saved image is readable back out of the library.
    const image = await client.library!.readCharacterImage('finn');
    expect(image?.bytes).toEqual(PNG_BYTES);
  });

  it('saves from a URL the server fetches', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_save_character', { name: 'bongo', description: 'a drum-playing monkey', image_url: 'https://cdn.example.com/bongo.jpg' }),
    );
    await h.close();
    expect(body.mime_type).toBe('image/jpeg');
    expect((client.fetchRemoteImage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://cdn.example.com/bongo.jpg');
  });

  it('requires exactly one image source', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    const none = await h.callTool('gemini_save_character', { name: 'x', description: 'd' });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toMatch(/image_r2_key/);
    const both = await h.callTool('gemini_save_character', { name: 'x', description: 'd', image_r2_key: 'gen/a', image_url: 'https://x.example/a.png' });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toMatch(/not both/);
    await h.close();
  });

  it('refuses an SVG reference image — the library serves from the connector origin', async () => {
    const client = stub({
      fetchRemoteImage: vi.fn(async (url: string) => ({
        bytes: PNG_BYTES, mimeType: 'image/svg+xml', size: PNG_BYTES.byteLength, finalUrl: url, requestedUrl: url,
      })),
      readStoredMedia: vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/svg+xml' })),
    });
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    for (const source of [{ image_url: 'https://x.example/a.svg' }, { image_r2_key: 'up/aaaaaaaaaaaa/a.svg' }]) {
      const res = await h.callTool('gemini_save_character', { name: 'evil', description: 'd', ...source });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/raster images only/);
    }
    expect(await client.library!.getCharacter('evil')).toBeUndefined();
    await h.close();
  });

  it('rejects names outside the slug charset at the schema', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    const res = await h.callTool('gemini_save_character', { name: 'Finn!', description: 'd', image_url: 'https://x.example/a.png' });
    expect(res.isError).toBe(true);
    await h.close();
  });
});

describe('list / delete characters', () => {
  it('lists what was saved and deletes only with confirm', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    await h.callTool('gemini_save_character', { name: 'finn', description: 'boy', image_url: 'https://x.example/finn.jpg' });
    await h.callTool('gemini_save_character', { name: 'mel', description: 'dog', image_url: 'https://x.example/mel.jpg' });

    const listed = parseToolResult<{ count: number; characters: Array<{ name: string; description: string }> }>(
      await h.callTool('gemini_list_characters', {}),
    );
    expect(listed.count).toBe(2);
    expect(listed.characters.map((c) => c.name)).toEqual(['finn', 'mel']);

    // No confirm ⇒ dry-run, nothing deleted.
    const dry = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_delete_character', { name: 'mel' }));
    expect(dry.dryRun).toBe(true);
    expect(parseToolResult<{ count: number }>(await h.callTool('gemini_list_characters', {})).count).toBe(2);

    const deleted = parseToolResult<Record<string, unknown>>(await h.callTool('gemini_delete_character', { name: 'mel', confirm: true }));
    expect(deleted.deleted).toBe('character');
    expect(parseToolResult<{ count: number }>(await h.callTool('gemini_list_characters', {})).count).toBe(1);

    const missing = await h.callTool('gemini_delete_character', { name: 'mel', confirm: true });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/No saved character/);
    await h.close();
  });
});

describe('styles', () => {
  it('save / list / delete round-trip, image optional', async () => {
    const client = stub();
    const h = await createTestHarness((s) => registerLibraryTools(s, client));
    const saved = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_save_style', { name: 'bold-cartoon-sports', prompt_fragment: 'bold cartoon style, thick outlines' }),
    );
    expect(saved.saved).toBe('style');
    expect(saved.has_reference_image).toBeUndefined();

    const withImage = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_save_style', { name: 'painterly', prompt_fragment: 'oil on canvas', image_url: 'https://x.example/ref.jpg' }),
    );
    expect(withImage.has_reference_image).toBe(true);

    const listed = parseToolResult<{ styles: Array<{ name: string }> }>(await h.callTool('gemini_list_styles', {}));
    expect(listed.styles.map((s) => s.name)).toEqual(['bold-cartoon-sports', 'painterly']);

    await h.callTool('gemini_delete_style', { name: 'painterly', confirm: true });
    expect(parseToolResult<{ count: number }>(await h.callTool('gemini_list_styles', {})).count).toBe(1);
    await h.close();
  });
});
