import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiClient } from '../src/client.js';

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

  it('maps a non-2xx to a redacted McpToolError', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: mockFetch({ error: 'nope' }, false, 403) });
    await expect(c.listModels()).rejects.toThrow(/Gemini API 403/);
  });
});

const genFixture = JSON.parse(readFileSync(join(FIX, 'generate-response.json'), 'utf8'));

function capturingFetch(body: unknown): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
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

describe('interact', () => {
  it('POSTs to /v1beta/interactions with the Api-Revision header', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a red circle' });
    expect(cap.calls[0].url).toMatch(/\/v1beta\/interactions$/);
    expect((cap.calls[0].init.headers as Record<string, string>)['Api-Revision']).toBe('2026-05-20');
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

  it('throws McpToolError with API message on non-2xx', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const errorBody = { error: { message: 'Invalid request', code: 'invalid_request' } };
    const c = new GeminiClient({ fetchImpl: mockFetch(errorBody, false, 400) });
    // assert the status code AND the extracted error.message land in the thrown error
    await expect(c.interact({ input: 'x' })).rejects.toThrow(/Gemini Interactions API 400: Invalid request/);
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

  it('omits tools from interact body when googleSearch is not set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capturingFetch(makeInteractFixture());
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'a circle' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.tools).toBeUndefined();
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
