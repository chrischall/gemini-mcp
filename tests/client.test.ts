import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiClient, ChainedRequest404Error } from '../src/client.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const listFixture = JSON.parse(readFileSync(join(FIX, 'list-models-response.json'), 'utf8'));

// These tests mutate process.env.GEMINI_API_KEY; restore it after each so the
// env doesn't leak across tests/files (e.g. a stray 'test-key' masking the
// deferred-config path elsewhere).
const ORIG_KEY = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
});

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('GeminiClient config', () => {
  it('constructs without a key (deferred) and throws only on use', async () => {
    delete process.env.GEMINI_API_KEY;
    const c = new GeminiClient();
    await expect(c.listModels()).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe('listModels', () => {
  it('returns only image models with stripped ids', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: mockFetch(listFixture) });
    const models = await c.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => /image/i.test(m.id))).toBe(true);
    expect(models.every((m) => !m.id.startsWith('models/'))).toBe(true);
    // imagen-* is in the fixture but uses a different API — must be excluded.
    expect(models.map((m) => m.id)).not.toContain('imagen-4.0-generate-001');
  });

  it('maps a non-2xx to a redacted, status-carrying error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: mockFetch({ error: 'nope' }, false, 403) });
    await expect(c.listModels()).rejects.toThrow(/Gemini error 403/);
  });
});

describe('shared-client timeout & 429 retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds every generateContent request with an abort signal (60s timeout)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf' });
    expect(cap.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds every interactions request with an abort signal (60s timeout)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    expect(cap.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('times out a hung request after 60s (image generation can run 30s+, so not sooner)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl: fn });
    const outcome = c.listModels().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    // Just under the budget: still pending (60s, NOT 30s — image gen runs 30s+).
    await vi.advanceTimersByTimeAsync(59_999);
    const sentinel = Symbol('pending');
    expect(await Promise.race([outcome, Promise.resolve(sentinel)])).toBe(sentinel);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatch(/timed out after 60000ms/);
  });

  it('retries a 429 once after 2s on the generateContent path (free tier rate-limits aggressively)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    const fn = (async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, status: 200, json: async () => genFixture, text: async () => JSON.stringify(genFixture) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl: fn });
    const p = c.generate({ prompt: 'leaf' });
    p.catch(() => {}); // settled-result tracking under fake timers
    await vi.advanceTimersByTimeAsync(2000);
    const out = await p;
    expect(out.images.length).toBeGreaterThan(0);
    expect(n).toBe(2);
  });

  it('retries a 429 once after 2s on the interactions path', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = makeInteractFixture();
    let n = 0;
    const fn = (async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, status: 200, json: async () => fixture, text: async () => JSON.stringify(fixture) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl: fn });
    const p = c.interact({ input: 'a circle' });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    const out = await p;
    expect(out.images).toHaveLength(1);
    expect(n).toBe(2);
  });
});

const genFixture = JSON.parse(readFileSync(join(FIX, 'generate-response.json'), 'utf8'));

function capturingFetch(body: unknown): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('generate', () => {
  it('posts prompt + inline images and extracts image bytes', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const out = await c.generate({
      prompt: 'a leaf',
      images: [{ base64: 'QQ==', mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      aspectRatio: '1:1',
      imageSize: '1K',
    });

    // request: correct URL + auth header
    expect(cap.calls[0].url).toContain('/models/gemini-3-pro-image:generateContent');
    expect((cap.calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');

    // request: body shape (CONFIRMED in Task 5)
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.contents[0].parts[0]).toEqual({ text: 'a leaf' });
    expect(sent.contents[0].parts[1]).toEqual({ inline_data: { mime_type: 'image/png', data: 'QQ==' } });
    expect(sent.generationConfig.responseModalities).toContain('IMAGE');
    expect(sent.generationConfig.responseModalities).toContain('TEXT');
    expect(sent.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });

    // response: new shape { images, text? }
    expect(out.images.length).toBeGreaterThan(0);
    expect(out.images[0].base64.length).toBeGreaterThan(0);
    expect(out.images[0].mimeType).toMatch(/^image\//);
  });

  it('throws when no image part is returned', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: capturingFetch({ candidates: [{ content: { parts: [{ text: 'blocked' }] } }] }).fn });
    await expect(c.generate({ prompt: 'x' })).rejects.toThrow(/no image/i);
  });

  it('returns text parts alongside images when the model provides them', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixtureWithText = {
      candidates: [{
        content: {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'abc123' } },
            { text: 'Here is the generated image.' },
          ],
        },
      }],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixtureWithText).fn });
    const out = await c.generate({ prompt: 'a leaf' });
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe('Here is the generated image.');
  });

  it('omits text from result when model returns no text parts', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: capturingFetch(genFixture).fn });
    const out = await c.generate({ prompt: 'leaf' });
    expect(out.text).toBeUndefined();
  });

  it('still throws when result has only text and no image (safety blocked)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: capturingFetch({ candidates: [{ content: { parts: [{ text: 'blocked' }] } }] }).fn });
    await expect(c.generate({ prompt: 'x' })).rejects.toThrow(/no image/i);
  });

  it('includes generationConfig.seed in request body when seed is provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf', seed: 42 });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generationConfig.seed).toBe(42);
  });

  it('omits seed from generationConfig when not provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generationConfig.seed).toBeUndefined();
  });

  it('includes generationConfig.thinkingConfig.thinkingLevel when thinkingLevel is provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf', thinkingLevel: 'minimal' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('accepts thinkingLevel "high"', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf', thinkingLevel: 'high' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
  });

  it('omits thinkingConfig from generationConfig when thinkingLevel not provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('includes top-level tools:[{google_search:{}}] when googleSearch is true', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf', googleSearch: true });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toEqual([{ google_search: {} }]);
  });

  it('omits tools from body when googleSearch is not set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'leaf' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toBeUndefined();
  });

  it('includes file_data video part when videoUrl is set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'describe this video', videoUrl: 'https://www.youtube.com/watch?v=abc123' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    const parts: unknown[] = sent.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'describe this video' });
    expect(parts).toContainEqual({ file_data: { file_uri: 'https://www.youtube.com/watch?v=abc123', mime_type: 'video/mp4' } });
  });

  it('parses grounding from groundingMetadata in response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixtureWithGrounding = {
      candidates: [{
        content: {
          parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'abc123' } }],
        },
        groundingMetadata: {
          webSearchQueries: ['current weather in SF'],
          groundingChunks: [
            { web: { uri: 'https://weather.com/sf', title: 'SF Weather' } },
            { web: { uri: 'https://example.com', title: 'Example' } },
          ],
        },
      }],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixtureWithGrounding).fn });
    const out = await c.generate({ prompt: 'weather image', googleSearch: true });
    expect(out.grounding).toBeDefined();
    expect(out.grounding!.queries).toEqual(['current weather in SF']);
    expect(out.grounding!.sources).toEqual([
      { uri: 'https://weather.com/sf', title: 'SF Weather' },
      { uri: 'https://example.com', title: 'Example' },
    ]);
  });

  it('omits grounding from result when groundingMetadata is absent', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: capturingFetch(genFixture).fn });
    const out = await c.generate({ prompt: 'leaf' });
    expect(out.grounding).toBeUndefined();
  });

  it('omits grounding when webSearchQueries is empty and no groundingChunks', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixtureEmptyGrounding = {
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'abc123' } }] },
        groundingMetadata: { webSearchQueries: [], groundingChunks: [] },
      }],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixtureEmptyGrounding).fn });
    const out = await c.generate({ prompt: 'leaf' });
    expect(out.grounding).toBeUndefined();
  });

  it('skips groundingChunks entries that have no .web (defensive parse)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = {
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'abc123' } }] },
        groundingMetadata: {
          webSearchQueries: ['q'],
          groundingChunks: [
            { web: { uri: 'https://a.example', title: 'A' } },
            { retrievedContext: { text: 'no web key here' } }, // must be dropped
            {},                                                  // must be dropped
          ],
        },
      }],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixture).fn });
    const out = await c.generate({ prompt: 'leaf' });
    expect(out.grounding!.sources).toEqual([{ uri: 'https://a.example', title: 'A' }]);
  });
});

// ---------------------------------------------------------------------------
// interact()
// ---------------------------------------------------------------------------

/** A minimal Interactions API success response with one image in steps[]. */
function makeInteractFixture(id = 'interact-id-1', extraSteps: unknown[] = []): unknown {
  return {
    id,
    status: 'completed',
    model: 'gemini-3.1-flash-image',
    object: 'interaction',
    created: 1_000_000,
    updated: 1_000_001,
    usage: {},
    steps: [
      {
        type: 'thought',
        summary: [{ type: 'text', text: 'thinking…' }],
      },
      {
        type: 'model_output',
        content: [
          { type: 'image', mime_type: 'image/jpeg', data: 'abc123' },
        ],
      },
      ...extraSteps,
    ],
  };
}

/** A minimal Interactions response carrying one inline video in steps[]. */
function makeVideoFixture(id = 'vid-1'): unknown {
  return {
    id,
    status: 'completed',
    object: 'interaction',
    steps: [
      { type: 'thought', summary: [{ type: 'text', text: '…' }] },
      { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'VIDEOBYTES' }] },
    ],
  };
}

describe('generateVideo', () => {
  it('POSTs to /interactions with a video response_format, inline delivery, and the omni default model', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeVideoFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.generateVideo({ input: 'a cat surfing', aspectRatio: '9:16', task: 'text_to_video' });
    expect(cap.calls[0].url).toMatch(/\/v1beta\/interactions$/);
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.model).toBe('gemini-omni-flash-preview');
    expect(sent.response_format.type).toBe('video');
    expect(sent.response_format.delivery).toBe('inline');
    expect(sent.response_format.aspect_ratio).toBe('9:16');
    expect(sent.generation_config.video_config.task).toBe('text_to_video');
    expect(r.id).toBe('vid-1');
    expect(r.videos).toEqual([{ base64: 'VIDEOBYTES', mimeType: 'video/mp4' }]);
  });

  it('passes previous_interaction_id for an edit', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeVideoFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateVideo({ input: 'brighter', task: 'edit', previousInteractionId: 'vid-0' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.previous_interaction_id).toBe('vid-0');
  });

  it('throws an actionable error when the response contains no video', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({
      fetchImpl: mockFetch({ id: 'x', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'blocked' }] }] }),
    });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/no video/i);
  });
});

/** A minimal Interactions response carrying one inline audio in steps[]. */
function makeMusicFixture(id = 'mus-1'): unknown {
  return {
    id,
    status: 'completed',
    object: 'interaction',
    steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: 'AUDIOBYTES' }] }],
  };
}

describe('generateMusic', () => {
  it('POSTs to /interactions with an audio response_format and the clip default model', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeMusicFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.generateMusic({ input: 'lofi beat' });
    expect(cap.calls[0].url).toMatch(/\/v1beta\/interactions$/);
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.model).toBe('lyria-3-clip-preview');
    expect(sent.response_format.type).toBe('audio');
    expect(r.id).toBe('mus-1');
    expect(r.audios).toEqual([{ base64: 'AUDIOBYTES', mimeType: 'audio/mpeg' }]);
  });

  it('includes audio_format and uses the given model', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeMusicFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateMusic({ input: 'song', model: 'lyria-3-pro-preview', audioFormat: 'wav' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.model).toBe('lyria-3-pro-preview');
    expect(sent.response_format.audio_format).toBe('wav');
  });

  it('throws an actionable error when the response contains no audio', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({
      fetchImpl: mockFetch({ id: 'x', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'blocked' }] }] }),
    });
    await expect(c.generateMusic({ input: 'x' })).rejects.toThrow(/no audio/i);
  });
});

describe('interact', () => {
  it('POSTs to /v1beta/interactions without the obsolete Api-Revision header (API is GA)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a red circle' });
    expect(cap.calls[0].url).toMatch(/\/v1beta\/interactions$/);
    expect((cap.calls[0].init.headers as Record<string, string>)['Api-Revision']).toBeUndefined();
    expect((cap.calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
  });

  it('sets response_format.mime_type to image/jpeg', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.response_format.mime_type).toBe('image/jpeg');
    expect(sent.response_format.type).toBe('image');
  });

  it('includes aspect_ratio in response_format when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle', aspectRatio: '16:9' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.response_format.aspect_ratio).toBe('16:9');
  });

  it('omits aspect_ratio from response_format when not provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.response_format.aspect_ratio).toBeUndefined();
  });

  it('includes image_size in response_format when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle', imageSize: '2K' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.response_format.image_size).toBe('2K');
  });

  it('includes previous_interaction_id when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'now add a square', previousInteractionId: 'prior-id-42' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.previous_interaction_id).toBe('prior-id-42');
  });

  it('omits previous_interaction_id when not provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.previous_interaction_id).toBeUndefined();
  });

  it('maps input images to {type, mime_type, data} parts in the input array', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({
      input: 'edit this',
      images: [{ base64: 'QQ==', mimeType: 'image/png' }],
    });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.input[0]).toEqual({ type: 'text', text: 'edit this' });
    expect(sent.input[1]).toEqual({ type: 'image', mime_type: 'image/png', data: 'QQ==' });
  });

  it('sends only a text part when no images provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'generate a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.input).toEqual([{ type: 'text', text: 'generate a circle' }]);
  });

  it('includes generation_config.thinking_level when thinkingLevel provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'circle', thinkingLevel: 'high' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generation_config).toEqual({ thinking_level: 'high' });
  });

  it('omits generation_config when thinkingLevel not provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.generation_config).toBeUndefined();
  });

  it('parses id and image from steps[].content', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture('my-id-99'));
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const result = await c.interact({ input: 'circle' });
    expect(result.id).toBe('my-id-99');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({ base64: 'abc123', mimeType: 'image/jpeg' });
  });

  it('collects text parts from steps[] into result.text', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = {
      id: 'txt-id',
      steps: [
        { type: 'model_output', content: [
          { type: 'image', mime_type: 'image/jpeg', data: 'imgdata' },
          { type: 'text', text: 'Here you go.' },
        ]},
      ],
    };
    const cap = capturingFetch(fixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const result = await c.interact({ input: 'circle' });
    expect(result.text).toBe('Here you go.');
  });

  it('surfaces ONLY model_output text — thought-step reasoning is dropped', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = {
      id: 'sum-id',
      steps: [
        // internal reasoning — must NOT leak to the caller
        { type: 'thought', summary: [{ type: 'text', text: 'internal reasoning' }, { type: 'image', mime_type: 'image/jpeg', data: 'draft' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'A teal circle.' }, { type: 'image', mime_type: 'image/jpeg', data: 'img' }] },
      ],
    };
    const cap = capturingFetch(fixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const result = await c.interact({ input: 'circle' });
    expect(result.images).toHaveLength(1);       // the thought "draft" image is excluded
    expect(result.images[0].base64).toBe('img');
    expect(result.text).toBe('A teal circle.');  // not "internal reasoning"
  });

  it('throws McpToolError with "no image" when steps contain no image part', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = { id: 'blocked', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'blocked' }] }] };
    const cap = capturingFetch(fixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await expect(c.interact({ input: 'x' })).rejects.toThrow(/no image/i);
  });

  it('throws a status-carrying error including the API message on non-2xx', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const errorBody = { error: { message: 'Invalid request', code: 'invalid_request' } };
    const c = new GeminiClient({ fetchImpl: mockFetch(errorBody, false, 400) });
    // assert the status code AND the upstream error.message land in the thrown error
    await expect(c.interact({ input: 'x' })).rejects.toThrow(/Gemini Interactions error 400[\s\S]*Invalid request/);
  });

  it('throws when no API key is set (deferred config)', async () => {
    delete process.env.GEMINI_API_KEY;
    const c = new GeminiClient();
    await expect(c.interact({ input: 'x' })).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('includes top-level tools:[{type:"google_search"}] when googleSearch is true', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle', googleSearch: true });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toEqual([{ type: 'google_search' }]);
  });

  it('parses grounding queries from the google_search_call step', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = {
      id: 'gs-id',
      steps: [
        { type: 'google_search_call', search_type: 'web_search', arguments: { queries: ['weather in SF', 'sf forecast'] } },
        { type: 'google_search_result', result: [{ search_suggestions: '<style>…</style>' }] },
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: 'img' }] },
      ],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixture).fn });
    const r = await c.interact({ input: 'sf weather infographic', googleSearch: true });
    expect(r.grounding).toEqual({ queries: ['weather in SF', 'sf forecast'] });
  });

  it('omits grounding when there is no google_search_call step', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: capturingFetch(makeInteractFixture()).fn });
    const r = await c.interact({ input: 'a circle' });
    expect(r.grounding).toBeUndefined();
  });

  it('omits tools from interact body when googleSearch is not set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toBeUndefined();
  });

  it('sends search_types on the google_search tool (implying grounding) when searchTypes is set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a butterfly painting', searchTypes: ['web_search', 'image_search'] });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toEqual([{ type: 'google_search', search_types: ['web_search', 'image_search'] }]);
  });

  it('does not add search_types when only googleSearch:true is set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle', googleSearch: true });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toEqual([{ type: 'google_search' }]);
  });

  it('surfaces deduped search_suggestions in grounding when image_search was requested (ToS display requirement)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Live-verified shape (2026-07-06): one call/result pair per search type;
    // a call's `arguments` can be null; result[].search_suggestions is an HTML chip.
    const fixture = {
      id: 'is-id',
      steps: [
        { type: 'google_search_call', search_type: 'web_search', arguments: null },
        { type: 'google_search_result', result: [{ search_suggestions: '<div>chip</div>' }, { search_suggestions: '<div>chip</div>' }] },
        { type: 'google_search_call', search_type: 'image_search', arguments: { queries: ['Timareta butterfly'] } },
        { type: 'google_search_result', result: [{ search_suggestions: '<div>other</div>' }] },
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: 'img' }] },
      ],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixture).fn });
    const r = await c.interact({ input: 'butterfly', searchTypes: ['web_search', 'image_search'] });
    expect(r.grounding?.queries).toEqual(['Timareta butterfly']);
    expect(r.grounding?.search_suggestions).toEqual(['<div>chip</div>', '<div>other</div>']);
  });

  it('omits search_suggestions from grounding when image_search was not requested', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fixture = {
      id: 'ws-id',
      steps: [
        { type: 'google_search_call', search_type: 'web_search', arguments: { queries: ['sf weather'] } },
        { type: 'google_search_result', result: [{ search_suggestions: '<div>chip</div>' }] },
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: 'img' }] },
      ],
    };
    const c = new GeminiClient({ fetchImpl: capturingFetch(fixture).fn });
    const r = await c.interact({ input: 'sf weather', googleSearch: true });
    expect(r.grounding).toEqual({ queries: ['sf weather'] });
  });

  it('retries a 404 on a chained call (store lag) and succeeds when the id appears', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // Live-observed (2026-07-06): a freshly created interaction id can 404 for
    // a short window right after its turn returns — the store is eventually
    // consistent. First two attempts 404, third finds it.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls <= 2) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'Requested entity was not found.', code: 'not_found' } }) };
      }
      return { ok: true, status: 200, json: async () => makeInteractFixture(), text: async () => JSON.stringify(makeInteractFixture()) };
    }) as unknown as typeof fetch;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const c = new GeminiClient({ fetchImpl, sleep });
    const r = await c.interact({ input: 'make it blue', previousInteractionId: 'v1_fresh' });
    expect(r.id).toBeDefined();
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('maps a persistent 404 on a chained call to an actionable error after exhausting retries', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'Requested entity was not found.', code: 'not_found' } }) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    const err = await c
      .interact({ input: 'make it blue', previousInteractionId: 'v1_stale' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e as Error & { hint?: string });
    expect(calls).toBe(3);
    expect(err.message).toMatch(/404 for a chained request/i);
    expect(err.message).toContain('v1_stale');
    expect(err.message).toMatch(/55 days|1 day/);
    expect(err.hint).toMatch(/without previous_interaction_id/i);
    expect(err.hint).toMatch(/re-attach/i); // media-agnostic hint (shared by interact/video/music)
  });

  it('does not claim the interaction expired — it surfaces the upstream 404 body verbatim', async () => {
    // The one 404 body observed live is generic ("Requested entity was not
    // found.") — it never names WHICH entity. An unknown model id and an expired
    // files/… uri produce the same shape, so asserting "your chain expired"
    // fabricates a cause and hides the real one.
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchImpl = (async () => ({
      ok: false, status: 404, json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'models/gemini-9-imaginary is not found.', code: 'not_found' } }),
    })) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    const err = await c
      .interact({ input: 'make it blue', previousInteractionId: 'v1_stale' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e as Error & { hint?: string });
    expect(err.message).toContain('gemini-9-imaginary'); // the real cause survives
    expect(err.message).not.toMatch(/was not found \(retried/i); // no fabricated verdict
    expect(err.message).toMatch(/does not necessarily mean|not necessarily/i);
  });

  it('throws a ChainedRequest404Error carrying the id and upstream text so callers can probe', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchImpl = (async () => ({
      ok: false, status: 404, json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'Requested entity was not found.', code: 'not_found' } }),
    })) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    const err = await c
      .interact({ input: 'make it blue', previousInteractionId: 'v1_stale' })
      .then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
    // Discriminable by type (not message-matching) — tools/interact.ts keys its
    // sidecar re-anchor off this, and the id names which sidecar to re-attach.
    expect(err).toBeInstanceOf(ChainedRequest404Error);
    expect((err as ChainedRequest404Error).previousInteractionId).toBe('v1_stale');
    expect((err as ChainedRequest404Error).upstreamMessage).toMatch(/Requested entity was not found/);
  });

  it('passes a 404 through untouched (no retries) when no previous_interaction_id was sent', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'Requested entity was not found.', code: 'not_found' } }) };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(c.interact({ input: 'a circle' })).rejects.toThrow(/Gemini Interactions error 404/);
    expect(calls).toBe(1);
  });

  it('includes video input entry when videoUrl is set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'describe this video', videoUrl: 'https://www.youtube.com/watch?v=xyz' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.input[0]).toEqual({ type: 'text', text: 'describe this video' });
    expect(sent.input).toContainEqual({ type: 'video', uri: 'https://www.youtube.com/watch?v=xyz', mime_type: 'video/mp4' });
  });
});

// ── uploadVideo (Files API resumable upload) ────────────────────────────────
// Live-verified flow (docs/GEMINI-API.md "Files API — local video upload"):
//   1. POST /upload/v1beta/files (start) → empty body, x-goog-upload-url header
//   2. POST <upload-url> (upload, finalize) → { file: { …, state } }
//   3. GET /v1beta/files/<id> until state ACTIVE (response is UNWRAPPED)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

type UploadCall = { url: string; init: RequestInit };

/** Sequenced mock fetch for the 3-step upload flow. Each entry describes one response. */
function uploadFetch(responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown }>): {
  fn: typeof fetch;
  calls: UploadCall[];
} {
  const calls: UploadCall[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({ url, init });
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=UID&upload_protocol=resumable';
const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
const fileObj = (state: string) => ({
  name: 'files/abc123',
  uri: FILE_URI,
  mimeType: 'video/mp4',
  state,
  expirationTime: '2026-06-14T15:26:39Z',
});

describe('uploadVideo', () => {
  let dir: string;
  let videoPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gemini-upload-'));
    videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('not really mp4 bytes'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs start → upload,finalize → poll-to-ACTIVE and returns the file uri', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([
      { headers: { 'x-goog-upload-url': UPLOAD_URL } },
      { body: { file: fileObj('PROCESSING') } },
      { body: fileObj('ACTIVE') }, // poll response is unwrapped
    ]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    const up = await c.uploadVideo(videoPath, 'video/mp4');

    expect(up).toMatchObject({ uri: FILE_URI, name: 'files/abc123', mimeType: 'video/mp4' });
    expect(up.expirationTime).toBe('2026-06-14T15:26:39Z');
    expect(mock.calls).toHaveLength(3);

    // start: /upload/v1beta prefix, resumable protocol headers, api key, display_name body
    const start = mock.calls[0];
    expect(start.url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files');
    const sh = new Headers(start.init.headers as HeadersInit);
    expect(sh.get('x-goog-api-key')).toBe('test-key');
    expect(sh.get('x-goog-upload-protocol')).toBe('resumable');
    expect(sh.get('x-goog-upload-command')).toBe('start');
    expect(sh.get('x-goog-upload-header-content-length')).toBe('20');
    expect(sh.get('x-goog-upload-header-content-type')).toBe('video/mp4');
    expect(JSON.parse(start.init.body as string)).toEqual({ file: { display_name: 'clip.mp4' } });

    // upload+finalize: posts the BLOB (file-backed, streamed) to the session url
    const fin = mock.calls[1];
    expect(fin.url).toBe(UPLOAD_URL);
    const fh = new Headers(fin.init.headers as HeadersInit);
    expect(fh.get('x-goog-upload-offset')).toBe('0');
    expect(fh.get('x-goog-upload-command')).toBe('upload, finalize');
    expect(fin.init.body).toBeInstanceOf(Blob);
    expect((fin.init.body as Blob).size).toBe(20);

    // poll: GET the files/<id> resource on the normal /v1beta base
    expect(mock.calls[2].url).toBe('https://generativelanguage.googleapis.com/v1beta/files/abc123');
    expect(mock.calls[2].init.method).toBe('GET');
  });

  it('skips polling when finalize already reports ACTIVE', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([
      { headers: { 'x-goog-upload-url': UPLOAD_URL } },
      { body: { file: fileObj('ACTIVE') } },
    ]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    const up = await c.uploadVideo(videoPath, 'video/mp4');
    expect(up.uri).toBe(FILE_URI);
    expect(mock.calls).toHaveLength(2);
  });

  it('throws an actionable error when the start response lacks x-goog-upload-url', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([{ headers: {} }]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    await expect(c.uploadVideo(videoPath, 'video/mp4')).rejects.toThrow(/upload/i);
  });

  it('throws a redacted error on a non-2xx start response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([{ status: 403, body: { error: { message: 'denied' } } }]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    await expect(c.uploadVideo(videoPath, 'video/mp4')).rejects.toThrow(/403/);
  });

  it('throws when processing ends in FAILED', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([
      { headers: { 'x-goog-upload-url': UPLOAD_URL } },
      { body: { file: fileObj('PROCESSING') } },
      { body: fileObj('FAILED') },
    ]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    await expect(c.uploadVideo(videoPath, 'video/mp4')).rejects.toThrow(/FAILED/);
  });

  it('gives up after the poll budget when the file never leaves PROCESSING', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let slept = 0;
    const mock = uploadFetch([
      { headers: { 'x-goog-upload-url': UPLOAD_URL } },
      { body: { file: fileObj('PROCESSING') } },
      { body: fileObj('PROCESSING') }, // repeated for every poll
    ]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => { slept++; } });
    await expect(c.uploadVideo(videoPath, 'video/mp4')).rejects.toThrow(/still processing/i);
    expect(slept).toBeGreaterThan(0);
    expect(slept).toBeLessThan(1000); // bounded, not infinite
  });

  it('rejects a server-returned file name that is not files/<id> (path-injection guard)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = uploadFetch([
      { headers: { 'x-goog-upload-url': UPLOAD_URL } },
      { body: { file: { ...fileObj('PROCESSING'), name: 'files/../models/evil' } } },
    ]);
    const c = new GeminiClient({ fetchImpl: mock.fn, sleep: async () => {} });
    await expect(c.uploadVideo(videoPath, 'video/mp4')).rejects.toThrow(/unexpected file name/i);
  });
});

describe('video mime passthrough', () => {
  it('generate uses videoMimeType for the file_data part when given', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(genFixture);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generate({ prompt: 'v', videoUrl: FILE_URI, videoMimeType: 'video/webm' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.contents[0].parts).toContainEqual({ file_data: { file_uri: FILE_URI, mime_type: 'video/webm' } });
  });

  it('interact uses videoMimeType for the video input when given', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'v', videoUrl: FILE_URI, videoMimeType: 'video/webm' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.input).toContainEqual({ type: 'video', uri: FILE_URI, mime_type: 'video/webm' });
  });
});
