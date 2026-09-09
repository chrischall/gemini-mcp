import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerFileTools } from '../../src/tools/files.js';
import { createDiskSink, createR2Sink } from '../../src/storage/media.js';
import type { GeminiClient } from '../../src/client.js';
import type { MediaSink } from '../../src/storage/media.js';

/**
 * `gemini_view_media` — the tool that lets a model SEE what it generated.
 *
 * On the hosted deployment a result is a signed URL, and a URL is not something
 * an agent can look at: fetching it needs network I/O the caller may not have,
 * and its own image tool wants a local file. So a generate → refine loop runs
 * blind, which is how five turns of edits ship without anyone noticing the text
 * came out garbled.
 *
 * Deliberately a SEPARATE tool rather than inline bytes on every result. Pixels
 * on every turn is a cost nobody opted into, and the durable result — the
 * `r2_key` manifest — is what survives a restart and gets re-signed. This way
 * the caller pays for eyes on the turns it actually looks, and can look at an
 * image from a lost turn found through gemini_list_recent_media just as easily.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function bucket(objects: Record<string, Uint8Array> = {}): Parameters<typeof createR2Sink>[0] {
  return {
    async put() {},
    async get(key: string) {
      const hit = objects[key];
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) as ArrayBuffer,
        httpMetadata: { contentType: 'image/png' },
      };
    },
  } as Parameters<typeof createR2Sink>[0];
}

function stub(sink: MediaSink, read?: (key: string) => Promise<{ bytes: Uint8Array; mimeType: string }>): GeminiClient {
  return {
    mediaSink: sink,
    readStoredMedia: read ?? (async (key: string) => {
      const stored = await sink.read?.(key);
      if (!stored) throw new Error(`No stored media for r2_key "${key}"`);
      return stored;
    }),
  } as unknown as GeminiClient;
}

describe('gemini_view_media', () => {
  it('returns the stored bytes as an image content block', async () => {
    const client = stub(createR2Sink(bucket({ 'gen/t/2026-09-09/poster.png': PNG_BYTES }), {}));
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const res = await h.callTool('gemini_view_media', { r2_key: 'gen/t/2026-09-09/poster.png' });
    const block = res.content.find((c: { type: string }) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(block?.mimeType).toBe('image/png');
    expect(block?.data).toBe(PNG_B64);
    await h.close();
  });

  it('is not registered where results are already local files', async () => {
    const h = await createTestHarness((s) => registerFileTools(s, stub(createDiskSink())));
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('gemini_view_media');
    await h.close();
  });

  it('refuses an image too large to return, and says what to do instead', async () => {
    // A payload cap is a host limit, not a model one: an oversized block is
    // rejected or truncated by the transport, which reads as a broken tool
    // rather than a large image. Better to say so and name the way through.
    const huge = new Uint8Array(9 * 1024 * 1024);
    const client = stub(createR2Sink(bucket({ 'gen/t/big.png': huge }), {}));
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const res = await h.callTool('gemini_view_media', { r2_key: 'gen/t/big.png' });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/too large/i);
    expect(text).toMatch(/image_size/); // re-render smaller
    expect(text).toMatch(/gemini_sign_media/); // or take the URL instead
    await h.close();
  });

  it('surfaces a swept key as the retention answer, not an empty block', async () => {
    const client = stub(createR2Sink(bucket(), {}), async (key: string) => {
      throw new Error(`No stored media for r2_key "${key}" — objects are removed on a retention schedule`);
    });
    const h = await createTestHarness((s) => registerFileTools(s, client));
    const res = await h.callTool('gemini_view_media', { r2_key: 'gen/t/gone.png' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/retention/i);
    await h.close();
  });
});

describe('running job handles', () => {
  it('carries the interaction id as soon as one exists', async () => {
    // A timed-out response must not lose the chain. The registry already knows
    // the interaction id the moment the API returns it; withholding it until
    // the job settles throws away the one handle that survives the settle
    // never happening.
    const { JobRegistry } = await import('../../src/jobs.js');
    const registry = new JobRegistry();
    let reported: (() => void) | undefined;
    const gate = new Promise<void>((r) => { reported = r; });
    const started = await registry.dispatch(
      { toolName: 'gemini_interact', fingerprint: 'fp', async: true },
      async (ctx) => {
        ctx.reportInteraction('v1_abc');
        reported!();
        return new Promise(() => {}) as never;
      },
    );
    await gate;
    const jobId = parseToolResult<{ job_id: string }>(started).job_id;
    const polled = parseToolResult<{ status: string; interaction_id?: string }>(await registry.getResult(jobId));
    expect(polled.status).toBe('running');
    expect(polled.interaction_id).toBe('v1_abc');
    await registry.drain();
  });
});
