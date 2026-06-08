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
});
