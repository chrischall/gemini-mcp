import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiClient, ChainedRequest404Error } from '../src/client.js';

/**
 * A chained 404 stops being a guess once `GET /v1beta/interactions/{id}`
 * exists (verified live 2026-08-22, docs/GEMINI-API.md).
 *
 * The POST body is generic — "Requested entity was not found." never names the
 * entity — so after the retry budget is spent we ASK about the one entity we
 * can ask about. Three answers, three different remediations:
 *
 *   GET 404 → the interaction really is gone (expired/deleted). Re-anchor.
 *   GET 200 → the interaction is ALIVE, so the 404 was about something else
 *             (a bad model id, an expired files/… uri). Re-anchoring would
 *             re-bill and still fail.
 *   GET 400 → `Invalid interaction name` — the id was never well-formed, which
 *             is a bug on our side, not an expiry.
 *
 * The probe is free: a 404'd POST generated nothing, and a GET generates
 * nothing either.
 */

const ORIG_KEY = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
});

interface Call { url: string; method: string }

/** POSTs always 404; the GET probe answers with `probe`. */
function chainFetch(probe: { ok: boolean; status: number; body: unknown }): {
  fn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (method === 'POST') {
      const body = { error: { message: 'Requested entity was not found.', code: 'not_found' } };
      return { ok: false, status: 404, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return {
      ok: probe.ok,
      status: probe.status,
      json: async () => probe.body,
      text: async () => JSON.stringify(probe.body),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function noSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

describe('chained 404 diagnosis via GET /interactions/{id}', () => {
  it('probes the interaction id once the retry budget is spent', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({ ok: false, status: 404, body: { error: { message: 'Requested entity was not found.' } } });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    await c.interact({ input: 'x', previousInteractionId: 'v1_stale' }).catch(() => undefined);

    const probes = cap.calls.filter((call) => call.method === 'GET');
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toContain('/interactions/v1_stale');
  });

  it('says the chain is gone when the probe 404s, and marks it so', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({ ok: false, status: 404, body: { error: { message: 'Requested entity was not found.' } } });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    const err = (await c
      .interact({ input: 'x', previousInteractionId: 'v1_stale' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as ChainedRequest404Error;

    expect(err).toBeInstanceOf(ChainedRequest404Error);
    expect(err.chainExists).toBe(false);
    expect(err.message).toMatch(/no longer exists|is gone|expired/i);
    expect(err.message).toContain('v1_stale');
  });

  it('says the cause is elsewhere when the interaction is still alive', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({ ok: true, status: 200, body: { id: 'v1_alive', status: 'completed', steps: [] } });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    const err = (await c
      .interact({ input: 'x', previousInteractionId: 'v1_alive', model: 'gemini-9-imaginary' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as ChainedRequest404Error;

    expect(err.chainExists).toBe(true);
    // The one thing we now KNOW: it isn't the chain. Say that, and point at the
    // two entities a generic 404 also covers.
    expect(err.message).toMatch(/still exists|is alive/i);
    expect(err.message).toMatch(/model id/i);
    expect(err.message).toMatch(/files\/…|files\//);
  });

  it('calls a malformed id what it is (400 Invalid interaction name), not an expiry', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({
      ok: false,
      status: 400,
      body: { error: { message: 'Invalid interaction name: interactions/v1_bogus', code: 'invalid_request' } },
    });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    const err = (await c
      .interact({ input: 'x', previousInteractionId: 'v1_bogus' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as ChainedRequest404Error;

    expect(err.chainExists).toBe(false);
    expect(err.message).toMatch(/not a valid interaction id|malformed/i);
  });

  it('still throws a ChainedRequest404Error when the probe itself fails (recovery must not depend on it)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push(method);
      if (method === 'GET') throw new Error('network down');
      const body = { error: { message: 'Requested entity was not found.' } };
      return { ok: false, status: 404, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: noSleep() });
    const err = (await c
      .interact({ input: 'x', previousInteractionId: 'v1_stale' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e)) as ChainedRequest404Error;

    expect(err).toBeInstanceOf(ChainedRequest404Error);
    expect(err.chainExists).toBeUndefined(); // unknown, and said as unknown
    expect(err.message).toContain('v1_stale');
  });

  it('does not probe when no previous_interaction_id was sent', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({ ok: true, status: 200, body: {} });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    await c.interact({ input: 'x' }).catch(() => undefined);
    expect(cap.calls.filter((call) => call.method === 'GET')).toHaveLength(0);
  });

  it('rejects an interaction id that could escape the URL path', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = chainFetch({ ok: true, status: 200, body: {} });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: noSleep() });
    await expect(c.getInteraction('../models/x:generateContent')).rejects.toThrow(/interaction id/i);
    expect(cap.calls).toHaveLength(0);
  });
});
