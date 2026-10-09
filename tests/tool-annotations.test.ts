import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { GeminiClient } from '../src/client.js';
import { createR2Sink } from '../src/storage/media.js';
import { createR2Library, type LibraryBucket } from '../src/library.js';
import type { UploadUrlMinter } from '../src/upload-url.js';

/**
 * Invariant: every tool states `openWorldHint` explicitly, so a client that
 * keys its permission UX off it treats sibling tools consistently.
 *
 * `gemini_list_models` calls Google's API but shipped with only
 * `readOnlyHint` while `gemini_list_files` — the same kind of read — said
 * `openWorldHint: true` (fleet-audit#848). An omitted hint is not the same as
 * `false`: the MCP spec defaults it to `true`, and clients differ on whether
 * they apply that default, so leaving it out is the inconsistent case.
 */
describe('tool annotations', () => {
  async function registeredTools() {
    const client = new GeminiClient({ apiKey: 'k' });
    const h = await createTestHarness((server) => {
      for (const register of TOOL_REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();
    return tools;
  }

  it('declares openWorldHint on every tool', async () => {
    const missing = (await registeredTools())
      .filter((t) => typeof t.annotations?.openWorldHint !== 'boolean')
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('marks gemini_list_models as a read-only call to Google', async () => {
    const tool = (await registeredTools()).find((t) => t.name === 'gemini_list_models');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  /**
   * Fleet invariant: every WRITE states `destructiveHint` as a boolean, and no
   * READ claims to destroy. `destructiveHint` defaults to TRUE, so a write that
   * omits it and a write that considered it publish identically — asserting
   * `readOnlyHint` alone cannot tell them apart. Checked against the hosted
   * roster too: the library / upload-URL / signed-media tools only register
   * when the client has somewhere to keep bytes, so a stdio-only check never
   * sees them.
   *
   * The pinned table is the inverse test, per tool (see the commit that added
   * it): `false` only where a later call in THIS tool set restores the prior
   * state.
   *   - generation tools (image/interact/video/music) bill the funded Google
   *     account per call, and nothing in the set removes the media they
   *     write, so: destructive.
   *   - gemini_get_result can write media recovered from a killed job, and
   *     nothing removes it: destructive.
   *   - gemini_upload_file is undone by gemini_delete_file: additive.
   *   - gemini_save_character / gemini_save_style REPLACE a same-named record
   *     and nothing restores the replaced one: destructive.
   *   - the two library deletes and gemini_delete_file: destructive.
   */
  const EXPECTED_DESTRUCTIVE: Record<string, boolean> = {
    gemini_image_generate: true,
    gemini_image_edit: true,
    gemini_image_set: true,
    gemini_interact: true,
    gemini_video_generate: true,
    gemini_music_generate: true,
    gemini_get_result: true,
    gemini_upload_file: false,
    gemini_delete_file: true,
    gemini_save_character: true,
    gemini_save_style: true,
    gemini_delete_character: true,
    gemini_delete_style: true,
  };

  function fakeBucket(): LibraryBucket & { put: (...a: unknown[]) => Promise<unknown> } {
    return {
      put: async () => ({}),
      get: async () => null,
      delete: async () => undefined,
      list: async () => ({ objects: [], truncated: false }),
    };
  }

  async function hostedTools() {
    const bucket = fakeBucket();
    const client = new GeminiClient({
      apiKey: 'k',
      mediaSink: createR2Sink(bucket, {
        signedBaseUrl: 'https://connector.example/media',
        sign: async (key, exp) => `sig-${key.length}-${exp}`,
        urlTtlMs: 3600_000,
        tenant: 'aaaaaaaaaaaa',
      }),
      library: createR2Library(bucket, { tenant: 'aaaaaaaaaaaa' }),
      uploadUrls: { mint: async () => { throw new Error('unused'); } } as UploadUrlMinter,
    });
    const h = await createTestHarness((server) => {
      for (const register of TOOL_REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();
    return tools;
  }

  for (const [label, load] of [
    ['stdio', registeredTools],
    ['hosted', hostedTools],
  ] as const) {
    describe(`${label} roster`, () => {
      it('gives every write an explicit boolean destructiveHint', async () => {
        const silent = (await load())
          .filter((t) => t.annotations?.readOnlyHint !== true)
          .filter((t) => typeof t.annotations?.destructiveHint !== 'boolean')
          .map((t) => t.name);
        expect(silent).toEqual([]);
      });

      it('never lets a read claim to be destructive', async () => {
        const reads = (await load())
          .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
          .map((t) => t.name);
        expect(reads).toEqual([]);
      });

      it('pins each write to its inverse-test verdict', async () => {
        const writes = (await load()).filter((t) => t.annotations?.readOnlyHint !== true);
        const actual = Object.fromEntries(writes.map((t) => [t.name, t.annotations?.destructiveHint]));
        const expected = Object.fromEntries(writes.map((t) => [t.name, EXPECTED_DESTRUCTIVE[t.name]]));
        expect(actual).toEqual(expected);
      });
    });
  }

  it('marks the library saves open-world: each can fetch a public image_url', async () => {
    const tools = await hostedTools();
    for (const n of ['gemini_save_character', 'gemini_save_style']) {
      expect(tools.find((t) => t.name === n)?.annotations?.openWorldHint, n).toBe(true);
    }
  });

  it('the hosted roster actually reaches the hosted-only writes', async () => {
    const names = (await hostedTools()).map((t) => t.name);
    for (const n of ['gemini_save_character', 'gemini_save_style', 'gemini_delete_character', 'gemini_delete_style']) {
      expect(names).toContain(n);
    }
  });
});
