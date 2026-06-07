import { describe, it, expect } from 'vitest';
import { GeminiClient } from '../src/client.js';

describe('GeminiClient config', () => {
  it('constructs without a key (deferred) and throws only on use', async () => {
    delete process.env.GEMINI_API_KEY;
    const c = new GeminiClient();
    await expect(c.listModels()).rejects.toThrow(/GEMINI_API_KEY/);
  });
});
