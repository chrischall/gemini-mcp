import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../src/tools/generate.js';
import { registerInteractTools } from '../src/tools/interact.js';
import { registerJobTools } from '../src/tools/jobs.js';
import { registerMusicTools } from '../src/tools/music.js';
import { GeminiClient } from '../src/client.js';

/**
 * MULTI-TENANCY. The hosted connector runs every authenticated claude.ai
 * session in ONE Cloudflare isolate — a single Worker isolate is shared across
 * many Durable Object instances. So any state that lives at *module* scope is
 * shared by every user on that isolate, and the per-session GeminiClient (which
 * isolates the API key) does not save you.
 *
 * The job registry and the interact session memory used to be module-level
 * Maps. That meant user B calling any generation tool with a colliding
 * `idempotency_key` ("1", "test", "retry") got user A's recorded result
 * verbatim — A's image refs, A's interaction id, A's prompt-derived meta — and
 * `continue_last: true` from B resumed A's interaction, billed to B's key.
 *
 * These tests pin the fix: the registry and the last-interaction memory hang
 * off the client, and each session gets its own client.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-tenancy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** A client with its own key and its own stubbed upstream. */
function sessionClient(apiKey: string): GeminiClient {
  return new GeminiClient({ apiKey, fetchImpl: (() => { throw new Error('no upstream in this test'); }) as unknown as typeof fetch });
}

describe('idempotency keys do not cross sessions', () => {
  it('user B with a colliding idempotency_key gets B\'s own generation, not A\'s', async () => {
    const a = sessionClient('key-a');
    const b = sessionClient('key-b');
    const genA = vi.spyOn(a, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }], text: 'A-secret' });
    const genB = vi.spyOn(b, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }], text: 'B-secret' });

    const hA = await createTestHarness((s) => registerGenerateTools(s, a));
    const hB = await createTestHarness((s) => registerGenerateTools(s, b));

    const resA = parseToolResult<{ text?: string; reused?: boolean }>(
      await hA.callTool('gemini_image_generate', { prompt: 'a cat', idempotency_key: '1', output_dir: dir }),
    );
    const resB = parseToolResult<{ text?: string; reused?: boolean }>(
      await hB.callTool('gemini_image_generate', { prompt: 'a cat', idempotency_key: '1', output_dir: dir }),
    );
    await hA.close();
    await hB.close();

    // B must have been generated for B — not replayed from A's registry entry.
    expect(resA.text).toBe('A-secret');
    expect(resB.text).toBe('B-secret');
    expect(resB.reused).toBeUndefined();
    expect(genA).toHaveBeenCalledTimes(1);
    expect(genB).toHaveBeenCalledTimes(1);
  });

  it('still dedups a repeated idempotency_key WITHIN one session', async () => {
    const a = sessionClient('key-a');
    const gen = vi.spyOn(a, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((s) => registerGenerateTools(s, a));

    await h.callTool('gemini_image_generate', { prompt: 'a cat', idempotency_key: 'k', output_dir: dir });
    const second = parseToolResult<{ reused?: boolean }>(
      await h.callTool('gemini_image_generate', { prompt: 'a cat', idempotency_key: 'k', output_dir: dir }),
    );
    await h.close();

    expect(second.reused).toBe(true);
    expect(gen).toHaveBeenCalledTimes(1);
  });
});

describe('in-flight fingerprint dedup does not cross sessions', () => {
  it('B issuing the same prompt concurrently is billed to B, not attached to A\'s job', async () => {
    const a = sessionClient('key-a');
    const b = sessionClient('key-b');
    let releaseA!: () => void;
    const pendingA = new Promise<void>((r) => { releaseA = r; });
    const genA = vi.spyOn(a, 'generate').mockImplementation(async () => {
      await pendingA;
      return { images: [{ base64: PNG, mimeType: 'image/png' }], text: 'A-secret' };
    });
    const genB = vi.spyOn(b, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }], text: 'B-secret' });

    const hA = await createTestHarness((s) => registerGenerateTools(s, a));
    const hB = await createTestHarness((s) => registerGenerateTools(s, b));

    const pA = hA.callTool('gemini_image_generate', { prompt: 'same prompt', output_dir: dir });
    const resB = parseToolResult<{ text?: string }>(
      await hB.callTool('gemini_image_generate', { prompt: 'same prompt', output_dir: dir }),
    );
    releaseA();
    const resA = parseToolResult<{ text?: string }>(await pA);
    await hA.close();
    await hB.close();

    expect(resB.text).toBe('B-secret');
    expect(resA.text).toBe('A-secret');
    expect(genA).toHaveBeenCalledTimes(1);
    expect(genB).toHaveBeenCalledTimes(1);
  });
});

describe('async job ids are not readable across sessions', () => {
  it('B cannot poll A\'s job_id', async () => {
    const a = sessionClient('key-a');
    const b = sessionClient('key-b');
    vi.spyOn(a, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }], text: 'A-secret' });

    const hA = await createTestHarness((s) => { registerGenerateTools(s, a); registerJobTools(s, a); });
    const hB = await createTestHarness((s) => { registerGenerateTools(s, b); registerJobTools(s, b); });

    const started = parseToolResult<{ job_id: string }>(
      await hA.callTool('gemini_image_generate', { prompt: 'a cat', async: true, output_dir: dir }),
    );
    // Poll rather than sleep a fixed interval: a fixed 20ms is enough when this
    // file runs alone and not always enough under the full suite's load, which
    // makes the assertion below fail for timing reasons that have nothing to do
    // with session isolation.
    let mine: { text?: string; status?: string } = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      mine = parseToolResult<{ text?: string; status?: string }>(
        await hA.callTool('gemini_get_result', { job_id: started.job_id }),
      );
      if (mine.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const stolen = await hB.callTool('gemini_get_result', { job_id: started.job_id });
    await hA.close();
    await hB.close();

    expect(stolen.isError).toBe(true);
    expect(JSON.stringify(stolen.content)).not.toContain('A-secret');
    expect(mine.text).toBe('A-secret');
  });
});

describe('music/video continue_last is per-session too', () => {
  // `gemini_music_generate` IS registered on the hosted connector, so its
  // last-interaction memory is a live cross-tenant leak of the same shape as
  // gemini_interact's. (Video is stdio-only — not registered on the Worker —
  // but carries the identical hazard, so it is scoped the same way.)
  it('B\'s music continue_last does not resume A\'s music interaction', async () => {
    const a = sessionClient('key-a');
    const b = sessionClient('key-b');
    vi.spyOn(a, 'generateMusic').mockResolvedValue({ id: 'A-music', audios: [{ base64: PNG, mimeType: 'audio/mp3' }] });
    const musicB = vi.spyOn(b, 'generateMusic').mockResolvedValue({ id: 'B-music', audios: [{ base64: PNG, mimeType: 'audio/mp3' }] });

    const hA = await createTestHarness((s) => registerMusicTools(s, a));
    const hB = await createTestHarness((s) => registerMusicTools(s, b));

    await hA.callTool('gemini_music_generate', { prompt: 'lo-fi', output_dir: dir });
    const res = await hB.callTool('gemini_music_generate', { prompt: 'add drums', continue_last: true, output_dir: dir });
    await hA.close();
    await hB.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain('A-music');
    expect(musicB).not.toHaveBeenCalled();
  });
});

describe('continue_last does not resume another session\'s interaction', () => {
  it('B\'s continue_last errors instead of chaining onto A\'s interaction id', async () => {
    const a = sessionClient('key-a');
    const b = sessionClient('key-b');
    vi.spyOn(a, 'interact').mockResolvedValue({ id: 'A-interaction', images: [{ base64: PNG, mimeType: 'image/png' }] });
    const interactB = vi.spyOn(b, 'interact').mockResolvedValue({ id: 'B-interaction', images: [{ base64: PNG, mimeType: 'image/png' }] });

    const hA = await createTestHarness((s) => registerInteractTools(s, a));
    const hB = await createTestHarness((s) => registerInteractTools(s, b));

    // Separate output dirs, because the leak under test is the *in-memory*
    // `lastInteractionId`. `continue_last` also has a documented disk fallback
    // to the newest `<image>.json` sidecar in the output dir — pointing both
    // sessions at one dir would exercise that instead, and mask the thing being
    // asserted. The fallback is gated on `mediaSink.persistsFiles`, so it does
    // not exist on the hosted connector (a Worker has no filesystem); sharing
    // an output dir is a single-user stdio arrangement by construction.
    const dirA = mkdtempSync(join(tmpdir(), 'gemini-tenancy-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'gemini-tenancy-b-'));
    let res: Awaited<ReturnType<typeof hB.callTool>>;
    try {
      await hA.callTool('gemini_interact', { input: 'draw a cat', output_dir: dirA });
      res = await hB.callTool('gemini_interact', { input: 'add a hat', continue_last: true, output_dir: dirB });
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
    await hA.close();
    await hB.close();

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/no previous interaction/i);
    expect(JSON.stringify(res.content)).not.toContain('A-interaction');
    expect(interactB).not.toHaveBeenCalled();
  });
});
