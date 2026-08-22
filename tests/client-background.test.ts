import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiClient } from '../src/client.js';

/**
 * Background execution (verified live 2026-08-22, docs/GEMINI-API.md).
 *
 * `background: true` returns `status: "in_progress"` immediately and the work
 * continues server-side; the caller polls `GET /v1beta/interactions/{id}`.
 * Accepting it is per-model — omni and Lyria do, the image models answer
 * `400 "does not support background interactions"` — so interact/generate must
 * never send it.
 *
 * It is **opt-in, never the default**, because retrieving the result is not
 * dependable: a poll of in-flight work answers `403 permission_denied`, and
 * some interactions then settle into a permanent `400 "Request contains an
 * invalid argument."` — billed, and unreachable forever. These tests pin the
 * mechanics for the callers who ask for it, and pin that nobody gets it by
 * accident.
 */

const ORIG_KEY = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
});

interface Call { url: string; method: string; body?: unknown }

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const VIDEO_STEP = { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'VIDEOBYTES' }] };
const AUDIO_STEP = { type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: 'AUDIOBYTES' }] };

/** POST starts a background job; each GET returns the next scripted poll body. */
function backgroundFetch(polls: unknown[], startId = 'v1_bg'): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let poll = 0;
  const fn = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (method === 'POST') return jsonOk({ id: startId, status: 'in_progress' });
    const body = polls[Math.min(poll, polls.length - 1)];
    poll++;
    return jsonOk(body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('background execution — video', () => {
  it('sends background: true and polls the interaction until it completes', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = backgroundFetch([
      { id: 'v1_bg', status: 'in_progress' },
      { id: 'v1_bg', status: 'completed', steps: [VIDEO_STEP] },
    ]);
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    const r = await c.generateVideo({ input: 'a cat surfing', delivery: 'inline', background: true });

    expect(cap.calls[0].method).toBe('POST');
    expect((cap.calls[0].body as { background?: boolean }).background).toBe(true);
    expect(cap.calls[1].url).toContain('/interactions/v1_bg');
    expect(cap.calls[1].method).toBe('GET');
    expect(r.id).toBe('v1_bg');
    expect(r.videos).toEqual([{ base64: 'VIDEOBYTES', mimeType: 'video/mp4' }]);
  });

  it('treats a poll body with no status as still running, not as done', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Defensive, not observed: the two "no status" polls seen live turned out
    // to be 403 error bodies read through jq (see the 403 test below), so this
    // pins a rule rather than a sighting — a body with no status and no output
    // is not evidence the work is done.
    const cap = backgroundFetch([
      { id: 'v1_bg' },
      { id: 'v1_bg' },
      { id: 'v1_bg', status: 'completed', steps: [VIDEO_STEP] },
    ]);
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    const r = await c.generateVideo({ input: 'x', delivery: 'inline', background: true });
    expect(r.videos[0].base64).toBe('VIDEOBYTES');
    expect(cap.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  it('surfaces a failed background interaction with its id', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = backgroundFetch([{ id: 'v1_bg', status: 'failed', error: { message: 'safety filter' } }]);
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(c.generateVideo({ input: 'x', delivery: 'inline', background: true })).rejects.toThrow(/failed/i);
  });

  it('names the interaction id when the wait runs out, because the work continues upstream', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Never completes. The generation is still running and billable on
    // Google's side — an error that does not name the id throws it away.
    const cap = backgroundFetch([{ id: 'v1_bg', status: 'in_progress' }]);
    const slept: number[] = [];
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: async (ms) => { slept.push(ms); } });
    const err = (await c
      .generateVideo({ input: 'x', delivery: 'inline', background: true, timeoutMs: 30_000 })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as Error;

    expect(err.message).toContain('v1_bg');
    expect(err.message).toMatch(/still running|continues/i);
    // Bounded by the caller's timeout, not unbounded.
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  it('does not poll when the POST already returned the finished interaction', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push((init.method ?? 'GET').toUpperCase());
      return jsonOk({ id: 'v1_done', status: 'completed', steps: [VIDEO_STEP] });
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    await c.generateVideo({ input: 'x', delivery: 'inline', background: true });
    expect(calls).toEqual(['POST']);
  });
});

describe('polling through the API being unhelpful', () => {
  it('keeps polling through a 403 on in-flight work (it is transient, not a permission failure)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Verified live: a GET of a running background interaction answers
    // "403 permission_denied — There was a problem processing your request.
    // You will not be charged.", on the same key that GETs it fine once it
    // completes. Taking that at face value fails every backgrounded
    // generation seconds in.
    let poll = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'POST') return jsonOk({ id: 'v1_bg', status: 'in_progress' });
      poll++;
      if (poll <= 2) {
        const body = { error: { message: 'There was a problem processing your request. You will not be charged.', code: 'permission_denied' } };
        return { ok: false, status: 403, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return jsonOk({ id: 'v1_bg', status: 'completed', steps: [VIDEO_STEP] });
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    const r = await c.generateVideo({ input: 'x', delivery: 'inline', background: true });
    expect(r.videos[0].base64).toBe('VIDEOBYTES');
    expect(poll).toBe(3);
  });

  it('reports the last poll error when the wait runs out, so a real 403 is not invisible', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'POST') return jsonOk({ id: 'v1_bg', status: 'in_progress' });
      const body = { error: { message: 'There was a problem processing your request. You will not be charged.', code: 'permission_denied' } };
      return { ok: false, status: 403, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    const err = (await c
      .generateVideo({ input: 'x', delivery: 'inline', background: true, timeoutMs: 9_000 })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as Error;
    expect(err.message).toContain('v1_bg');
    expect(err.message).toMatch(/last poll said/i);
    expect(err.message).toMatch(/permission_denied|not be charged/i);
  });

  it('does not swallow a poll error that is not transient', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'POST') return jsonOk({ id: 'v1_bg', status: 'in_progress' });
      const body = { error: { message: 'Internal error', code: 'internal' } };
      return { ok: false, status: 500, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(c.generateVideo({ input: 'x', delivery: 'inline', background: true })).rejects.toThrow(/500|internal/i);
  });
});

describe('the delivery fallback is scoped to the POST', () => {
  it('never re-issues a generation because a POLL mentioned delivery', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Once the POST succeeds the generation is running and billable. A 400
    // arriving from the poll must surface, never trigger the "that 400 cost
    // nothing" retry — which would pay for the clip twice.
    let posts = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'POST') {
        posts++;
        return jsonOk({ id: 'v1_bg', status: 'in_progress' });
      }
      const body = { error: { message: "Video delivery mode is not supported.", code: 'invalid_request' } };
      return { ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(c.generateVideo({ input: 'x', background: true })).rejects.toThrow(/delivery/i);
    expect(posts).toBe(1);
  });
});

describe('background execution — music', () => {
  it('sends background: true and polls to completion', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = backgroundFetch([{ id: 'v1_bg', status: 'completed', steps: [AUDIO_STEP] }], 'v1_bg');
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    const r = await c.generateMusic({ input: 'lofi', background: true });
    expect((cap.calls[0].body as { background?: boolean }).background).toBe(true);
    expect(r.audios).toEqual([{ base64: 'AUDIOBYTES', mimeType: 'audio/mpeg' }]);
  });
});

describe('image models never get background', () => {
  it('interact does not send background (the image models reject it with a 400)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body as string) : undefined });
      return jsonOk({ id: 'i-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: 'IMG' }] }] });
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl });
    await c.interact({ input: 'x' });
    expect(calls[0].body).not.toHaveProperty('background');
  });

  it('does not background a video generation unless the caller asks (polling can lose the result)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body as string) : undefined });
      return jsonOk({ id: 'v-1', status: 'completed', steps: [VIDEO_STEP] });
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl });
    await c.generateVideo({ input: 'x', delivery: 'inline' });
    expect(calls[0].body).not.toHaveProperty('background');
  });
});
