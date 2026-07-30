import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { JobRegistry, fingerprintRequest } from '../src/jobs.js';

// A fresh registry per test — which is also the production shape: one registry
// per session, never a module-level singleton (see src/session.ts).
let registry: JobRegistry;
beforeEach(() => { registry = new JobRegistry(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
    const p1 = registry.dispatch({ toolName: 't', fingerprint: fp }, work);
    const p2 = registry.dispatch({ toolName: 't', fingerprint: fp }, work);
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
    const p1 = registry.dispatch({ toolName: 't', fingerprint: 'a' }, () => { calls++; return d1.promise; });
    const p2 = registry.dispatch({ toolName: 't', fingerprint: 'b' }, () => { calls++; return d2.promise; });
    d1.resolve(textResultOf({})); d2.resolve(textResultOf({}));
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
  });

  it('does NOT dedup a sequential identical request without a key (in-flight only)', async () => {
    const fp = fingerprintRequest('t', { prompt: 'x' });
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'] })); };
    await registry.dispatch({ toolName: 't', fingerprint: fp }, work);
    await registry.dispatch({ toolName: 't', fingerprint: fp }, work);
    expect(calls).toBe(2);
  });
});

describe('dispatch — idempotency_key', () => {
  it('reuses a recently-completed result for the same key (even if fingerprint differs)', async () => {
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'], model: 'm' })); };
    await registry.dispatch({ toolName: 't', fingerprint: 'fp1', idempotencyKey: 'k' }, work);
    const r2 = await registry.dispatch({ toolName: 't', fingerprint: 'fp2', idempotencyKey: 'k' }, work);
    expect(calls).toBe(1);
    const m = metaOf(r2);
    expect(m.reused).toBe(true);
    expect(typeof m.reused_job_id).toBe('string');
  });

  it('does not reuse a failed job by key — the retry runs again', async () => {
    let calls = 0;
    const work = () => { calls++; return Promise.reject(new McpToolError('boom')); };
    await expect(registry.dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k' }, work)).rejects.toThrow('boom');
    await expect(registry.dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k' }, work)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('expires a completed keyed job after the TTL (no longer reused)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const work = () => { calls++; return Promise.resolve(textResultOf({ images: ['a.png'] })); };
    await registry.dispatch({ toolName: 't', fingerprint: 'fp1', idempotencyKey: 'k' }, work);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // past the 10-min TTL
    await registry.dispatch({ toolName: 't', fingerprint: 'fp2', idempotencyKey: 'k' }, work);
    expect(calls).toBe(2);
  });
});

describe('dispatch — replayed media URLs are re-minted', () => {
  const recorded = () =>
    textResultOf({
      images: ['https://c.example.com/media/gen/abc123-cat.png?exp=1&sig=old'],
      media: [{ url: 'https://c.example.com/media/gen/abc123-cat.png?exp=1&sig=old', r2_key: 'gen/abc123-cat.png', expires_at: '2026-01-01T00:00:00.000Z' }],
    });

  it('replaces an expired signed URL with a fresh one, everywhere it appears', async () => {
    registry.resigner = {
      resign: vi.fn().mockResolvedValue({
        ref: 'https://c.example.com/media/gen/abc123-cat.png?exp=2&sig=new',
        key: 'gen/abc123-cat.png',
        expiresAt: '2026-12-31T00:00:00.000Z',
      }),
    };
    await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => recorded());
    const replay = metaOf(
      await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => {
        throw new Error('must not re-run');
      }),
    );

    expect(replay.reused).toBe(true);
    expect(replay.media_urls_refreshed).toBe(true);
    const media = (replay.media as Array<Record<string, unknown>>)[0];
    expect(media.url).toContain('sig=new');
    expect(media.expires_at).toBe('2026-12-31T00:00:00.000Z');
    // The curl hint is minted fresh too — a legacy recorded shape gains it.
    expect(media.curl_hint).toBe('curl -sS -o cat.png "https://c.example.com/media/gen/abc123-cat.png?exp=2&sig=new"');
    // The flat list must agree with media[], or the caller copies the dead one.
    expect((replay.images as string[])[0]).toContain('sig=new');
  });

  it('refreshes audio and video results too — the flat list is found by name', async () => {
    for (const listName of ['audios', 'videos'] as const) {
      const reg = new JobRegistry();
      reg.resigner = {
        resign: vi.fn().mockResolvedValue({ ref: 'https://c.example.com/media/gen/ab12cd-track.mp3?exp=2&sig=new', key: 'gen/ab12cd-track.mp3' }),
      };
      const recordedMedia = () =>
        textResultOf({
          [listName]: ['https://c.example.com/media/gen/ab12cd-track.mp3?exp=1&sig=old'],
          media: [{ url: 'https://c.example.com/media/gen/ab12cd-track.mp3?exp=1&sig=old', r2_key: 'gen/ab12cd-track.mp3', expires_at: '2026-01-01T00:00:00.000Z' }],
        });
      await reg.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => recordedMedia());
      const replay = metaOf(await reg.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => recordedMedia()));

      expect(replay.media_urls_refreshed, listName).toBe(true);
      expect((replay[listName] as string[])[0], listName).toContain('sig=new');
      const entry = (replay.media as Array<Record<string, unknown>>)[0];
      expect(entry.curl_hint).toBe(
        'curl -sS -o track.mp3 "https://c.example.com/media/gen/ab12cd-track.mp3?exp=2&sig=new"',
      );
      // The resigner returned no expiry, so the stale recorded one must not
      // survive to mislabel the fresh link.
      expect(entry.expires_at).toBeUndefined();
    }
  });

  it('keeps positions aligned when some entries carry no r2_key at all', async () => {
    // An entry without r2_key must not shift later assignments: the refresh is
    // per-entry, and the flat list keeps its full length and order.
    registry.resigner = {
      resign: vi.fn(async (key: string) => ({ ref: `https://c.example.com/media/${key}?exp=2&sig=new`, key })),
    };
    const mixed = () =>
      textResultOf({
        images: ['inline-block-placeholder', 'https://c.example.com/media/gen/ab12cd-b.png?exp=1&sig=old'],
        media: [
          { url: 'inline-block-placeholder' }, // no r2_key (e.g. legacy / inline entry)
          { url: 'https://c.example.com/media/gen/ab12cd-b.png?exp=1&sig=old', r2_key: 'gen/ab12cd-b.png' },
        ],
      });
    await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => mixed());
    const replay = metaOf(await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => mixed()));

    const media = replay.media as Array<Record<string, unknown>>;
    expect(media).toHaveLength(2);
    expect(media[0].url).toBe('inline-block-placeholder'); // untouched, not clobbered
    expect(media[0].curl_hint).toBeUndefined();
    expect(media[1].url).toContain('sig=new');
    const images = replay.images as string[];
    expect(images).toHaveLength(2); // never truncated
    expect(images[0]).toBe('inline-block-placeholder');
    expect(images[1]).toContain('sig=new');
  });

  it('is best-effort: a replay that cannot be refreshed is still a valid replay', async () => {
    registry.resigner = { resign: vi.fn().mockRejectedValue(new Error('KV down')) };
    await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => recorded());
    const replay = metaOf(
      await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => recorded()),
    );

    expect(replay.reused).toBe(true);
    expect(replay.media_urls_refreshed).toBeUndefined();
    expect((replay.media as Array<Record<string, unknown>>)[0].url).toContain('sig=old');
  });

  it('leaves stdio replays untouched — no resigner, refs are paths that never expire', async () => {
    const result = textResultOf({ images: ['/tmp/out/cat.png'] });
    await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => result);
    const replay = metaOf(
      await registry.dispatch({ toolName: 't', fingerprint: 'f', idempotencyKey: 'k' }, async () => result),
    );

    expect(replay.reused).toBe(true);
    expect(replay.media_urls_refreshed).toBeUndefined();
    expect((replay.images as string[])[0]).toBe('/tmp/out/cat.png');
  });
});

describe('dispatch — async job handle', () => {
  const settle = () => new Promise((r) => setImmediate(r));

  it('returns a job_id immediately without awaiting work', async () => {
    const d = deferred<CallToolResult>();
    const r = await registry.dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const m = metaOf(r);
    expect(typeof m.job_id).toBe('string');
    expect(m.status).toBe('running');
    d.resolve(textResultOf({ images: ['a.png'] }));
  });

  it('getJobResult reports running, then returns the result once done', async () => {
    const d = deferred<CallToolResult>();
    const start = await registry.dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const jobId = metaOf(start).job_id as string;
    expect(metaOf(registry.getResult(jobId)).status).toBe('running');
    d.resolve(textResultOf({ images: ['a.png'], model: 'm' }));
    await settle();
    expect(metaOf(registry.getResult(jobId)).images).toEqual(['a.png']);
  });

  it('getJobResult throws with the recorded message for a failed job', async () => {
    const d = deferred<CallToolResult>();
    const start = await registry.dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => d.promise);
    const jobId = metaOf(start).job_id as string;
    d.reject(new McpToolError('kaboom'));
    await settle();
    expect(() => registry.getResult(jobId)).toThrow('kaboom');
  });

  it('getJobResult throws for an unknown/expired job id', () => {
    expect(() => registry.getResult('nope')).toThrow();
  });

  it('an async call attaches to a matching running job by key (same job_id)', async () => {
    const d = deferred<CallToolResult>();
    let calls = 0;
    const first = await registry.dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k', async: true }, () => { calls++; return d.promise; });
    const second = await registry.dispatch({ toolName: 't', fingerprint: 'fp', idempotencyKey: 'k', async: true }, () => { calls++; return d.promise; });
    expect(calls).toBe(1);
    expect(metaOf(second).job_id).toBe(metaOf(first).job_id);
    d.resolve(textResultOf({ images: ['a.png'] }));
  });

  it('an async call attaches to a matching in-flight job by fingerprint (no key, same job_id)', async () => {
    const d = deferred<CallToolResult>();
    let calls = 0;
    const first = await registry.dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => { calls++; return d.promise; });
    const second = await registry.dispatch({ toolName: 't', fingerprint: 'fp', async: true }, () => { calls++; return d.promise; });
    expect(calls).toBe(1); // fingerprint dedup fired even without an idempotency_key
    expect(metaOf(second).job_id).toBe(metaOf(first).job_id);
    d.resolve(textResultOf({ images: ['a.png'] }));
  });
});
