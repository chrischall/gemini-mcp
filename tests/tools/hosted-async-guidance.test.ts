import { describe, expect, it, vi } from 'vitest';
import { timeoutRiskHint } from '../../src/tools/shared.js';
import { JobRegistry } from '../../src/jobs.js';
import { createBlobJobStore, type JobStoreBucket } from '../../src/job-store.js';
import { textResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The advice, and the behaviour behind it.
 *
 * The hosted branch of `timeoutRiskHint` used to steer a slow generation to
 * `async: true` — the one option that cannot work on a machine that stops when
 * no request is in flight. It was recommending the failure mode, which is how a
 * caller ends up with the exact "unknown job id" that prompted this change.
 *
 * `max_wait_ms` is the real answer, because holding the request open is what
 * keeps the executor alive.
 */

const RESULT = textResult({ images: ['https://blob/x.png'] });

function memoryBucket(): JobStoreBucket {
  const objects = new Map<string, string>();
  return {
    async put(key, value) {
      objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array));
    },
    async get(key) {
      const hit = objects.get(key);
      if (hit === undefined) return null;
      const bytes = new TextEncoder().encode(hit);
      return {
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    },
  };
}

/** A registry configured as the hosted client configures it. */
function hosted(waitMs = 50): JobRegistry {
  const registry = new JobRegistry();
  registry.store = createBlobJobStore(memoryBucket(), { tenant: 't' });
  registry.asyncWaitFallbackMs = waitMs;
  return registry;
}

const meta = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content?.[0];
  return first && first.type === 'text' ? JSON.parse(first.text) : {};
};

describe('hosted slow-generation guidance', () => {
  it('steers a slow hosted config to max_wait_ms, not async', () => {
    const hint = timeoutRiskHint({ model: 'gemini-3-pro-image', imageSize: '4K', persistsFiles: false })!;
    expect(hint).toMatch(/max_wait_ms/);
    expect(hint).not.toMatch(/`async: true`/);
  });

  it('explains why, so the advice survives being copied somewhere else', () => {
    const hint = timeoutRiskHint({ model: 'gemini-3-pro-image', persistsFiles: false })!;
    expect(hint).toMatch(/request open|in flight|holding/i);
  });

  it('leaves the disk-backed advice alone — there the sidecar really is the recovery path', () => {
    const hint = timeoutRiskHint({ model: 'gemini-3-pro-image', persistsFiles: true })!;
    expect(hint).toMatch(/sidecar/);
  });
});

describe('hosted async degrade', () => {
  it('serves async:true in-band when the work finishes inside the budget', async () => {
    // The caller asked not to wait; the platform means waiting is what makes it
    // work. A fast result comes straight back rather than becoming a poll.
    const registry = hosted(5_000);
    const result = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      async () => RESULT,
    );
    expect(meta(result).images).toEqual(['https://blob/x.png']);
    expect(meta(result).job_id).toBeUndefined();
    await registry.drain();
  });

  it('falls back to a durable job handle when the work outlives the budget', async () => {
    const registry = hosted(10);
    const result = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      () => new Promise<CallToolResult>(() => {}),
    );
    expect(meta(result).status).toBe('running');
    expect(typeof meta(result).job_id).toBe('string');
    // And the handle says the record survives a restart, rather than repeating
    // the old "per-process, ~10 min" claim that made the loss look like expiry.
    expect(meta(result).hint).toMatch(/durabl/i);
    expect(meta(result).hint).not.toMatch(/per-process/);
  });

  it('honours an explicit max_wait_ms over the fallback', async () => {
    const registry = hosted(10);
    const started = Date.now();
    const result = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true, waitMs: 400 },
      () => new Promise<CallToolResult>(() => {}),
    );
    expect(meta(result).status).toBe('running');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('does not degrade on a local stdio install, where background work is safe', async () => {
    const registry = new JobRegistry(); // no store, no fallback
    const work = vi.fn(() => new Promise<CallToolResult>(() => {}));
    const result = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      work,
    );
    expect(meta(result).status).toBe('running'); // returned immediately, as before
    expect(work).toHaveBeenCalled();
  });
});
