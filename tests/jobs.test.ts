import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatch, fingerprintRequest, getJobResult, __resetJobRegistry } from '../src/jobs.js';

afterEach(() => { __resetJobRegistry(); vi.useRealTimers(); vi.restoreAllMocks(); });

function textResultOf(obj: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function metaOf(r: CallToolResult): Record<string, unknown> {
  return JSON.parse((r.content[0] as { text: string }).text);
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('fingerprintRequest', () => {
  it('is stable for identical inputs and differs when the request changes', () => {
    const a = fingerprintRequest('gemini_image_generate', { model: 'm', prompt: 'x' });
    const b = fingerprintRequest('gemini_image_generate', { model: 'm', prompt: 'x' });
    const c = fingerprintRequest('gemini_image_generate', { model: 'm', prompt: 'y' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is namespaced by tool so identical params across tools do not collide', () => {
    expect(fingerprintRequest('gemini_image_generate', { prompt: 'x' }))
      .not.toBe(fingerprintRequest('gemini_image_edit', { prompt: 'x' }));
  });
});

describe('dispatch — in-flight fingerprint dedup', () => {
  it('runs work once for two concurrent identical requests; the second is reused', async () => {
    const fp = fingerprintRequest('t', { prompt: 'x' });
    let calls = 0;
    const d = deferred<CallToolResult>();
    const work = () => { calls++; return d.promise; };
    const p1 = dispatch({ toolName: 't', fingerprint: fp }, work);
    const p2 = dispatch({ toolName: 't', fingerprint: fp }, work);
    d.resolve(textResultOf({ images: ['a.png'], model: 'm' }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    const m1 = metaOf(r1), m2 = metaOf(r2);
    expect(m1.images).toEqual(['a.png']);
    expect(m2.images).toEqual(['a.png']);
    // Exactly one of the pair is flagged reused (the one that attached).
    expect([m1.reused, m2.reused].filter(Boolean)).toHaveLength(1);
  });

  it('does not dedup concurrent requests with different fingerprints', async () => {
    let calls = 0;
    const d1 = deferred<CallToolResult>(), d2 = deferred<CallToolResult>();
    const p1 = dispatch({ toolName: 't', fingerprint: 'a' }, () => { calls++; return d1.promise; });
    const p2 = dispatch({ toolName: 't', fingerprint: 'b' }, () => { calls++; return d2.promise; });
    d1.resolve(textResultOf({})); d2.resolve(textResultOf({}));
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
  });

  it('does NOT dedup a sequential identical request without a key (in-flight only)', async () => {
    const fp = fingerprintRequest('t', { prompt: 'x' });
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'] })); };
    await dispatch({ toolName: 't', fingerprint: fp }, work);
    await dispatch({ toolName: 't', fingerprint: fp }, work);
    expect(calls).toBe(2);
  });
});

describe('dispatch — idempotency_key', () => {
  it('reuses a recently-completed result for the same key (even if fingerprint differs)', async () => {
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'], model: 'm' })); };
    await dispatch({ toolName: 't', fingerprint: 'fp1', idempotencyKey: 'k' }, work);
    const r2 = await dispatch({ toolName: 't', fingerprint: 'fp2', idempotencyKey: 'k' }, work);
    expect(calls).toBe(1);
    const m = metaOf(r2);
    expect(m.reused).toBe(true);
    expect(typeof m.reused_job_id).toBe('string');
  });

  it('does not reuse a failed job by key — the retry runs again', async () => {
    let calls = 0;
    const work = () => { calls++; return Promise.reject(new McpToolError('boom')); };
    await expect(dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k' }, work)).rejects.toThrow('boom');
    await expect(dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k' }, work)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('expires a completed keyed job after the TTL (no longer reused)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'] })); };
    await dispatch({ toolName: 't', fingerprint: 'fp1', idempotencyKey: 'k' }, work);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // past the 10-min TTL
    await dispatch({ toolName: 't', fingerprint: 'fp2', idempotencyKey: 'k' }, work);
    expect(calls).toBe(2);
  });
});

describe('dispatch — async job handle', () => {
  const settle = () => new Promise((r) => setImmediate(r));

  it('returns a job_id immediately without awaiting work', async () => {
    const d = deferred<CallToolResult>();
    const r = await dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const m = metaOf(r);
    expect(typeof m.job_id).toBe('string');
    expect(m.status).toBe('running');
    d.resolve(textResultOf({ images: ['a.png'] }));
  });

  it('getJobResult reports running, then returns the result once done', async () => {
    const d = deferred<CallToolResult>();
    const start = await dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const jobId = metaOf(start).job_id as string;
    expect(metaOf(getJobResult(jobId)).status).toBe('running');
    d.resolve(textResultOf({ images: ['a.png'], model: 'm' }));
    await settle();
    expect(metaOf(getJobResult(jobId)).images).toEqual(['a.png']);
  });

  it('getJobResult throws with the recorded message for a failed job', async () => {
    const d = deferred<CallToolResult>();
    const start = await dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const jobId = metaOf(start).job_id as string;
    d.reject(new McpToolError('kaboom'));
    await settle();
    expect(() => getJobResult(jobId)).toThrow('kaboom');
  });

  it('getJobResult throws for an unknown/expired job id', () => {
    expect(() => getJobResult('nope')).toThrow();
  });

  it('an async call attaches to a matching running job by key (same job_id)', async () => {
    const d = deferred<CallToolResult>();
    let calls = 0;
    const first = await dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k', async: true }, () => { calls++; return d.promise; });
    const second = await dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k', async: true }, () => { calls++; return d.promise; });
    expect(calls).toBe(1);
    expect(metaOf(second).job_id).toBe(metaOf(first).job_id);
    d.resolve(textResultOf({ images: ['a.png'] }));
  });

  it('an async call attaches to a matching in-flight job by fingerprint (no key, same job_id)', async () => {
    const d = deferred<CallToolResult>();
    let calls = 0;
    const first = await dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => { calls++; return d.promise; });
    const second = await dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => { calls++; return d.promise; });
    expect(calls).toBe(1); // fingerprint dedup fired even without an idempotency_key
    expect(metaOf(second).job_id).toBe(metaOf(first).job_id);
    d.resolve(textResultOf({ images: ['a.png'] }));
  });
});
