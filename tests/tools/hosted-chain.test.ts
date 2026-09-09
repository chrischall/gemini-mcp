import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerInteractTools } from '../../src/tools/interact.js';
import { registerFileTools } from '../../src/tools/files.js';
import { createR2Sink, type MediaBucket, type MediaSink } from '../../src/storage/media.js';
import { SessionState } from '../../src/session.js';
import { ChainedRequest404Error } from '../../src/client.js';
import type { GeminiClient } from '../../src/client.js';

/**
 * Chain durability WITHOUT a filesystem.
 *
 * On disk, `gemini_interact` survives a lost response because an `<image>.json`
 * sidecar keeps the interaction id next to the image it produced: the chain can
 * be continued after a restart, and a chained 404 can be re-anchored on that
 * exact image and re-issued un-chained. The hosted deployment had none of it,
 * so a dropped response ended the chain and a 404 was terminal — the two
 * failures a real multi-turn workflow hits first.
 *
 * An object store holds a small JSON record perfectly well. These tests pin the
 * hosted half of both recoveries against a fake bucket.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The 404 the client raises for a chained request whose interaction is gone. */
function chained404(previousInteractionId: string): ChainedRequest404Error {
  return new ChainedRequest404Error(
    previousInteractionId,
    'Requested entity was not found.',
    { attempts: 3, waitedMs: 120_000 },
    { hint: 'chain' },
    false, // chainExists: gone, so re-anchoring is the right experiment
  );
}

function bucket(): MediaBucket {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      const view = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      objects.set(key, new Uint8Array(view));
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) as ArrayBuffer,
        httpMetadata: { contentType: 'image/png' },
      };
    },
    async list({ prefix, limit }) {
      const keys = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit ?? 1000).map((key) => ({ key, size: objects.get(key)!.byteLength })), truncated: false };
    },
  };
}

function hostedClient(sink: MediaSink, methods: Record<string, unknown> = {}): GeminiClient {
  return {
    mediaSink: sink,
    session: new SessionState(),
    readStoredMedia: async (key: string) => {
      const stored = await sink.read?.(key);
      if (!stored) throw new Error(`No stored media for r2_key "${key}"`);
      return stored;
    },
    ...methods,
  } as unknown as GeminiClient;
}

describe('hosted interact — the sidecar record', () => {
  it('records the interaction id beside the image it produced', async () => {
    const sink = createR2Sink(bucket(), { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    const client = hostedClient(sink, {
      interact: vi.fn().mockResolvedValue({ id: 'v1_one', images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    await h.callTool('gemini_interact', { input: 'a red poster' });
    await h.close();

    const found = await sink.findByInteraction!('v1_one');
    expect(found).toBeDefined();
    expect(found!.prompt).toBe('a red poster');
  });

  it('continues the newest recorded interaction after the in-memory id is gone', async () => {
    // A restart empties SessionState but the interaction is still alive
    // upstream. On disk the newest sidecar covers this; hosted had nothing, so
    // a restart mid-workflow read as an expired chain.
    const sink = createR2Sink(bucket(), { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    const interact = vi.fn().mockResolvedValue({ id: 'v1_one', images: [{ base64: PNG, mimeType: 'image/png' }] });
    const client = hostedClient(sink, { interact });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    await h.callTool('gemini_interact', { input: 'a red poster' });

    client.session.lastInteractionId = undefined; // the restart
    const res = await h.callTool('gemini_interact', { input: 'make it blue', continue_last: true });
    await h.close();

    expect(interact.mock.calls[1][0].previousInteractionId).toBe('v1_one');
    expect(parseToolResult<{ continued_from_sidecar?: boolean }>(res).continued_from_sidecar).toBe(true);
  });

  it('re-anchors a chained 404 on the image that interaction produced', async () => {
    const sink = createR2Sink(bucket(), { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    const interact = vi.fn()
      .mockResolvedValueOnce({ id: 'v1_one', images: [{ base64: PNG, mimeType: 'image/png' }] })
      .mockRejectedValueOnce(chained404('v1_one'))
      .mockResolvedValueOnce({ id: 'v1_two', images: [{ base64: PNG, mimeType: 'image/png' }] });
    const client = hostedClient(sink, { interact });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    await h.callTool('gemini_interact', { input: 'a red poster' });
    const res = await h.callTool('gemini_interact', { input: 'make it blue', previous_interaction_id: 'v1_one' });
    await h.close();

    const body = parseToolResult<{ chain_recovered?: { expired_interaction_id: string; reanchored_on: string[] } }>(res);
    expect(body.chain_recovered?.expired_interaction_id).toBe('v1_one');
    // Re-issued UN-chained, carrying the recovered image as a fresh reference.
    const retry = interact.mock.calls[2][0];
    expect(retry.previousInteractionId).toBeUndefined();
    expect(retry.images[0].base64).toBe(PNG);
  });

  it('does not re-anchor on an image belonging to a different interaction', async () => {
    // Matched by id only. Re-anchoring on the wrong picture corrupts the edit
    // silently, so an id with no record has to rethrow rather than guess.
    const sink = createR2Sink(bucket(), { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    const interact = vi.fn()
      .mockResolvedValueOnce({ id: 'v1_one', images: [{ base64: PNG, mimeType: 'image/png' }] })
      .mockRejectedValueOnce(chained404('v1_unknown'));
    const client = hostedClient(sink, { interact });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    await h.callTool('gemini_interact', { input: 'a red poster' });
    const res = await h.callTool('gemini_interact', { input: 'make it blue', previous_interaction_id: 'v1_unknown' });
    await h.close();

    expect(res.isError).toBe(true);
    expect(interact).toHaveBeenCalledTimes(2); // no third, re-anchored call
  });
});

describe('gemini_list_recent_media — what each object was', () => {
  it('reports the interaction id and prompt, so a lost turn is identifiable', async () => {
    const sink = createR2Sink(bucket(), { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    const client = hostedClient(sink, {
      interact: vi.fn().mockResolvedValue({ id: 'v1_one', images: [{ base64: PNG, mimeType: 'image/png' }] }),
    });
    const hi = await createTestHarness((s) => registerInteractTools(s, client));
    await hi.callTool('gemini_interact', { input: 'a red poster' });
    await hi.close();

    const hf = await createTestHarness((s) => registerFileTools(s, client));
    const body = parseToolResult<{ media: Array<{ interaction_id?: string; prompt?: string }> }>(
      await hf.callTool('gemini_list_recent_media', {}),
    );
    await hf.close();

    expect(body.media[0].interaction_id).toBe('v1_one');
    expect(body.media[0].prompt).toBe('a red poster');
  });
});
