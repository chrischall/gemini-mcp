import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiClient } from '../src/client.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const listFixture = JSON.parse(readFileSync(join(FIX, 'list-models-response.json'), 'utf8'));

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
  });

  it('maps a non-2xx to a redacted McpToolError', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const c = new GeminiClient({ fetchImpl: mockFetch({ error: 'nope' }, false, 403) });
    await expect(c.listModels()).rejects.toThrow(/Gemini API 403/);
  });
});
