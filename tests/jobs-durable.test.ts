import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../src/jobs.js';
import { createBlobJobStore, EXECUTOR_LOST_AFTER_MS, type JobStoreBucket } from '../src/job-store.js';
import { textResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The reported bug, end to end.
 *
 * `gemini_image_set` was called with `async: true`, returned a job id, and two
 * minutes later that id was unknown — well inside the 10-minute window the
 * error itself quoted. The cause was not expiry: the hosted connector's Fly
 * machine stops as soon as nothing is in flight, and an async call holds
 * nothing open, so the child died with the registry inside it.
 *
 * These tests stand the registry back up over a shared blob store and assert
 * the three outcomes that were missing: the result survives the executor, a
 * killed job ends `failed` rather than `unknown`, and an idempotent resubmit
 * after the restart replays instead of re-billing.
 */

function fakeBucket(): JobStoreBucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
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

const T0 = 1_700_000_000_000;

/** A registry wired to `bucket`, as one hosted child would build it. */
function hostedRegistry(bucket: JobStoreBucket, now: () => number = () => T0): JobRegistry {
  const registry = new JobRegistry();
  registry.store = createBlobJobStore(bucket, { tenant: 'a632ccd72524', now });
  registry.now = now;
  return registry;
}

const meta = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content?.[0];
  return first && first.type === 'text' ? JSON.parse(first.text) : {};
};

const RESULT = textResult({ images: ['https://blob/gen/x.png'], media: [{ r2_key: 'gen/t/2026-08-18/x.png' }] });

describe('durable job recovery', () => {
  it('replays a completed job to a registry that never ran it', async () => {
    // submit → the machine stops → a new child answers the poll.
    const bucket = fakeBucket();
    const first = hostedRegistry(bucket);
    const handle = await first.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      async () => RESULT,
    );
    const jobId = meta(handle).job_id as string;
    expect(meta(handle).status).toBe('running');
    await first.drain();

    const reborn = hostedRegistry(bucket, () => T0 + 120_000);
    const polled = await reborn.getResult(jobId);
    expect(meta(polled).images).toEqual(['https://blob/gen/x.png']);
  });

  it('ends a job whose executor was killed in "failed", never "unknown"', async () => {
    const bucket = fakeBucket();
    const first = hostedRegistry(bucket);
    const handle = await first.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      // Never settles — the machine stopped mid-generation.
      () => new Promise<CallToolResult>(() => {}),
    );
    const jobId = meta(handle).job_id as string;

    const reborn = hostedRegistry(bucket, () => T0 + EXECUTOR_LOST_AFTER_MS + 1);
    await expect(reborn.getResult(jobId)).rejects.toThrow(/lost|executor/i);
    // And specifically NOT the old, misleading copy.
    await expect(reborn.getResult(jobId)).rejects.not.toThrow(/unknown or expired/i);
  });

  it('still reports a genuinely-running job as running', async () => {
    const bucket = fakeBucket();
    const first = hostedRegistry(bucket);
    const handle = await first.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      () => new Promise<CallToolResult>(() => {}),
    );
    const jobId = meta(handle).job_id as string;
    const reborn = hostedRegistry(bucket, () => T0 + EXECUTOR_LOST_AFTER_MS - 1);
    expect(meta(await reborn.getResult(jobId)).status).toBe('running');
  });

  it('replays by idempotency key across a restart without a second upstream call', async () => {
    const bucket = fakeBucket();
    const work = vi.fn(async () => RESULT);
    const first = hostedRegistry(bucket);
    await first.dispatch({ toolName: 'gemini_image_set', fingerprint: 'fp', idempotencyKey: 'summer-camp' }, work);
    expect(work).toHaveBeenCalledTimes(1);

    const reborn = hostedRegistry(bucket, () => T0 + 120_000);
    const again = await reborn.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', idempotencyKey: 'summer-camp' },
      work,
    );
    expect(work).toHaveBeenCalledTimes(1); // no new generation billed
    expect(meta(again).reused).toBe(true);
  });

  it('does not replay a FAILED job by key — a retry after an error must really retry', async () => {
    const bucket = fakeBucket();
    const first = hostedRegistry(bucket);
    await expect(
      first.dispatch({ toolName: 'gemini_image_set', fingerprint: 'fp', idempotencyKey: 'k' }, async () => {
        throw new Error('safety filter');
      }),
    ).rejects.toThrow('safety filter');

    const work = vi.fn(async () => RESULT);
    const reborn = hostedRegistry(bucket, () => T0 + 120_000);
    await reborn.dispatch({ toolName: 'gemini_image_set', fingerprint: 'fp', idempotencyKey: 'k' }, work);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('keeps a running job\'s heartbeat fresh so a slow set is not declared lost', async () => {
    // A 12-scene set outlives EXECUTOR_LOST_AFTER_MS. Without a heartbeat the
    // record would go stale while the work was still perfectly healthy.
    const bucket = fakeBucket();
    let clock = T0;
    const registry = hostedRegistry(bucket, () => clock);
    let finish: (r: CallToolResult) => void = () => {};
    const handle = await registry.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      () => new Promise<CallToolResult>((res) => { finish = res; }),
    );
    const jobId = meta(handle).job_id as string;

    clock = T0 + EXECUTOR_LOST_AFTER_MS * 2;
    await registry.beat(); // what the heartbeat timer does
    const reader = hostedRegistry(bucket, () => clock + 1000);
    expect(meta(await reader.getResult(jobId)).status).toBe('running');

    finish(RESULT);
    await registry.drain();
  });

  it('records that an inline result was not persisted instead of replaying an empty success', async () => {
    const bucket = fakeBucket();
    const registry = hostedRegistry(bucket);
    const inline: CallToolResult = {
      content: [{ type: 'image', data: 'A'.repeat(5000), mimeType: 'image/png' }],
    };
    const handle = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      async () => inline,
    );
    const jobId = meta(handle).job_id as string;
    await registry.drain();

    const reborn = hostedRegistry(bucket, () => T0 + 120_000);
    await expect(reborn.getResult(jobId)).rejects.toThrow(/inline/i);
  });

  it('degrades to the in-memory path when the store is unavailable', async () => {
    const registry = new JobRegistry(); // no store — a local stdio install
    const handle = await registry.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      async () => RESULT,
    );
    await registry.drain();
    expect(meta(await registry.getResult(meta(handle).job_id as string)).images).toBeDefined();
  });
});
