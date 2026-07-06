import { describe, it, expect, afterEach } from 'vitest';
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
