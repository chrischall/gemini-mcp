import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { GeminiClient, resolveTimeoutMs } from '../src/client.js';

// These tests mutate GEMINI_API_KEY / GEMINI_TIMEOUT_MS; restore after each so
// the suite stays order-independent.
const ORIG_KEY = process.env.GEMINI_API_KEY;
const ORIG_TIMEOUT = process.env.GEMINI_TIMEOUT_MS;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
  if (ORIG_TIMEOUT === undefined) delete process.env.GEMINI_TIMEOUT_MS;
  else process.env.GEMINI_TIMEOUT_MS = ORIG_TIMEOUT;
});

/** A fetch that never responds but honors the abort signal — how a stalled
 * upstream looks to the client's timeout plumbing. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

describe('resolveTimeoutMs', () => {
  it('defaults to 60s', () => {
    delete process.env.GEMINI_TIMEOUT_MS;
    expect(resolveTimeoutMs(undefined, undefined)).toBe(60_000);
  });

  it('defaults to 120s for 4K output (routinely exceeds 60s on the Pro model)', () => {
    delete process.env.GEMINI_TIMEOUT_MS;
    expect(resolveTimeoutMs(undefined, '4K')).toBe(120_000);
    expect(resolveTimeoutMs(undefined, '2K')).toBe(60_000);
  });

  it('GEMINI_TIMEOUT_MS overrides both defaults (including the 4K bump)', () => {
    process.env.GEMINI_TIMEOUT_MS = '90000';
    expect(resolveTimeoutMs(undefined, undefined)).toBe(90_000);
    expect(resolveTimeoutMs(undefined, '4K')).toBe(90_000);
  });

  it('a per-call timeout wins over the env override', () => {
    process.env.GEMINI_TIMEOUT_MS = '90000';
    expect(resolveTimeoutMs(30_000, '4K')).toBe(30_000);
  });

  it('ignores a non-numeric or non-positive GEMINI_TIMEOUT_MS', () => {
    process.env.GEMINI_TIMEOUT_MS = 'abc';
    expect(resolveTimeoutMs(undefined, undefined)).toBe(60_000);
    process.env.GEMINI_TIMEOUT_MS = '0';
    expect(resolveTimeoutMs(undefined, undefined)).toBe(60_000);
    process.env.GEMINI_TIMEOUT_MS = '-5';
    expect(resolveTimeoutMs(undefined, undefined)).toBe(60_000);
  });
});

describe('per-call timeout wiring', () => {
  it('generate aborts at the per-call timeoutMs', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_TIMEOUT_MS;
    const c = new GeminiClient({ fetchImpl: hangingFetch });
    await expect(c.generate({ prompt: 'a circle', timeoutMs: 25 })).rejects.toThrow(/timed out after 25ms/);
  });

  // mcp-utils 3.0: a timed-out POST may already have run (and been billed), so
  // it surfaces as WriteOutcomeUnknownError rather than a retry-safe
  // RequestTimeoutError.
  it('a timed-out generate/interact POST is a WriteOutcomeUnknownError (not retry-safe)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_TIMEOUT_MS;
    const c = new GeminiClient({ fetchImpl: hangingFetch });
    for (const call of [
      () => c.generate({ prompt: 'a circle', timeoutMs: 25 }),
      () => c.interact({ input: 'a circle', timeoutMs: 25 }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
      expect(err).toMatchObject({ timedOut: true, retrySafe: false, method: 'POST' });
    }
  });

  it('interact aborts at the per-call timeoutMs', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_TIMEOUT_MS;
    const c = new GeminiClient({ fetchImpl: hangingFetch });
    await expect(c.interact({ input: 'a circle', timeoutMs: 25 })).rejects.toThrow(/timed out after 25ms/);
  });

  it('generate reads GEMINI_TIMEOUT_MS at request time (not construction)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: hangingFetch });
    process.env.GEMINI_TIMEOUT_MS = '25';
    await expect(c.generate({ prompt: 'a circle' })).rejects.toThrow(/timed out after 25ms/);
  });
});

// chrischall/fleet-audit#467: the generated-media download and the Files API
// upload were the two upstream calls with no deadline. A server that accepts
// the connection and then stalls hung the tool call forever (the progress
// heartbeat stops the host from timing it out for us).
describe('media transfers are bounded', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a stalled generated-media download times out instead of hanging', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    process.env.GEMINI_API_KEY = 'test-key';
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media';
    let downloadSignal: AbortSignal | undefined;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes('/interactions')) {
        const body = {
          id: 'vid-1', status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: fileUri }] }],
        };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      downloadSignal = init.signal ?? undefined;
      // Headers arrive, then the body trickles one byte and stalls — erroring
      // only when the request is aborted, exactly like a real fetch body.
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl });
    const pending = c.generateVideo({ input: 'x' });
    const settled = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await settled;
    expect(downloadSignal).toBeInstanceOf(AbortSignal);
  });

  it('a stalled Files API upload from a local path times out instead of hanging', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gemini-upload-timeout-'));
    try {
      const p = join(d, 'clip.mp4');
      writeFileSync(p, Buffer.from('tiny'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      process.env.GEMINI_API_KEY = 'test-key';
      const c = new GeminiClient({ fetchImpl: hangingFetch, sleep: async () => {} });
      const pending = c.uploadFile(p, 'video/mp4');
      const settled = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await settled;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a video that fails processing after the upload deadline keeps its processing error', async () => {
    // The deadline bounds the two upload round trips only. The PROCESSING
    // poll that follows is bounded by its own attempt cap, so a FAILED state
    // reached after the deadline would elapse must surface as a processing
    // failure, not be relabelled a stalled upload (chrischall/fleet-audit#467).
    const d = mkdtempSync(join(tmpdir(), 'gemini-upload-poll-'));
    try {
      const p = join(d, 'clip.mp4');
      writeFileSync(p, Buffer.from('tiny'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      process.env.GEMINI_API_KEY = 'test-key';
      const json = (body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
      let polls = 0;
      const fetchImpl: typeof fetch = async (url) => {
        const u = String(url);
        if (u.includes('/upload/') && !u.includes('upload_id')) {
          return json({}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x' });
        }
        if (u.includes('upload_id')) return json({ file: { name: 'files/abc', state: 'PROCESSING' } });
        polls++;
        return json({ name: 'files/abc', state: 'FAILED', error: { message: 'unsupported codec' } });
      };
      // Each poll interval runs the clock well past the upload deadline.
      const sleep = async () => { vi.advanceTimersByTime(60 * 60 * 1000); };
      const c = new GeminiClient({ fetchImpl, sleep });
      await expect(c.uploadFile(p, 'video/mp4')).rejects.toThrow(/file processing failed \(state FAILED\): unsupported codec/);
      expect(polls).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
