import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../src/jobs.js';
import { createBlobJobStore, EXECUTOR_LOST_AFTER_MS, type JobStoreBucket } from '../src/job-store.js';
import { textResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Follow-ups from the review of the durable-jobs change (#152 / #153).
 *
 * Three of the four are about a durable record outliving the assumptions the
 * in-memory registry was written under: a `Map` entry that expires in ten
 * minutes and dies with the process is a very different object from a JSON blob
 * that sits in storage for a month, and code that was correct for the first is
 * not automatically correct for the second.
 */

const T0 = 1_700_000_000_000;
const RESULT = textResult({ images: ['https://blob/x.png'] });

function sharedBucket(): JobStoreBucket & { objects: Map<string, string> } {
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

function registry(bucket: JobStoreBucket, now: () => number = () => T0): JobRegistry {
  const r = new JobRegistry();
  r.store = createBlobJobStore(bucket, { tenant: 't', now });
  r.now = now;
  return r;
}

const meta = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content?.[0];
  return first && first.type === 'text' ? JSON.parse(first.text) : {};
};

describe('durable idempotency is bounded by identity, not just by key', () => {
  it('refuses to replay when the request is a DIFFERENT generation', async () => {
    // The severe case: `idempotency_key: "1"` is a habit, not a promise that
    // the prompt is unchanged. Replaying by key alone hands back an image of
    // something else entirely and calls it a cache hit.
    const bucket = sharedBucket();
    await registry(bucket).dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'PROMPT-A', idempotencyKey: '1' },
      async () => RESULT,
    );

    const work = vi.fn(async () => textResult({ images: ['https://blob/b.png'] }));
    const later = registry(bucket, () => T0 + 60_000);
    const result = await later.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'PROMPT-B', idempotencyKey: '1' },
      work,
    );
    expect(work).toHaveBeenCalledTimes(1); // really generated
    expect(meta(result).reused).toBeUndefined();
    expect(meta(result).images).toEqual(['https://blob/b.png']);
  });

  it('still replays the SAME generation across a restart', async () => {
    const bucket = sharedBucket();
    await registry(bucket).dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'SAME', idempotencyKey: '1' },
      async () => RESULT,
    );
    const work = vi.fn(async () => RESULT);
    const later = registry(bucket, () => T0 + 60_000);
    const result = await later.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'SAME', idempotencyKey: '1' },
      work,
    );
    expect(work).not.toHaveBeenCalled();
    expect(meta(result).reused).toBe(true);
  });

  it('does not replay a result older than the durable reuse window', async () => {
    // Records live for the store's retention (~30 days). Without a bound, a
    // key reused next month silently returns last month's picture.
    const bucket = sharedBucket();
    await registry(bucket).dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'SAME', idempotencyKey: '1' },
      async () => RESULT,
    );
    const work = vi.fn(async () => RESULT);
    const muchLater = registry(bucket, () => T0 + 3 * 24 * 60 * 60 * 1000);
    await muchLater.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'SAME', idempotencyKey: '1' },
      work,
    );
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('a heartbeat cannot resurrect a job that already finished', () => {
  it('does not overwrite a terminal record with an in-flight running beat', async () => {
    // beat() sampled the running set, then awaited its write. If the job
    // settled inside that await, the late write put `running` back on top of
    // `done` — and the next reader called a successful generation "lost".
    const bucket = sharedBucket();
    let release: (r: CallToolResult) => void = () => {};
    // A `running` write is made deliberately slow, so the heartbeat's write is
    // still in flight when the job's terminal write lands. That is precisely
    // the interleaving the review describes, made deterministic.
    const slowBucket: JobStoreBucket = {
      async put(key, value) {
        if (String(value).includes('"status":"running"')) await new Promise((res) => setTimeout(res, 20));
        return bucket.put(key, value);
      },
      get: bucket.get,
    };
    const r = registry(slowBucket);
    await r.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      () => new Promise<CallToolResult>((res) => { release = res; }),
    );
    await r.drain();

    const beating = r.beat();       // samples the job as running
    release(RESULT);                // …and it finishes while that write is in flight
    await beating;
    await r.drain();
    await new Promise((res) => setTimeout(res, 40)); // let any late write land

    const reader = registry(bucket, () => T0 + EXECUTOR_LOST_AFTER_MS * 2);
    const jobId = [...bucket.objects.keys()]
      .find((k) => !k.includes('/keys/'))!
      .replace('jobs/t/', '')
      .replace('.json', '');
    // The successful result must survive — not be reported as executor-lost.
    expect(meta(await reader.getResult(jobId)).images).toEqual(['https://blob/x.png']);
  });
});

describe('an omitted result says which kind of omission it was', () => {
  it('gives inline-specific remediation for an inline result', async () => {
    const bucket = sharedBucket();
    const r = registry(bucket);
    const handle = await r.dispatch(
      { toolName: 'gemini_image_generate', fingerprint: 'fp', async: true },
      async () => ({ content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }] }),
    );
    await r.drain();
    const jobId = meta(handle).job_id as string;
    await expect(registry(bucket, () => T0 + 1000).getResult(jobId)).rejects.toThrow(/inline/i);
  });

  it('does NOT blame inline mode for a result that was merely too large', async () => {
    // persistableResult also omits an oversized TEXT result. Telling that
    // caller to "re-run without inline: true" is advice they cannot act on —
    // they never passed it.
    const bucket = sharedBucket();
    const r = registry(bucket);
    const handle = await r.dispatch(
      { toolName: 'gemini_image_set', fingerprint: 'fp', async: true },
      async () => textResult({ images: Array.from({ length: 4000 }, (_, i) => `https://blob/${i}-${'x'.repeat(40)}.png`) }),
    );
    await r.drain();
    const jobId = meta(handle).job_id as string;
    await expect(registry(bucket, () => T0 + 1000).getResult(jobId)).rejects.toThrow(/too large/i);
    await expect(registry(bucket, () => T0 + 1000).getResult(jobId)).rejects.not.toThrow(/inline: true/);
  });
});
