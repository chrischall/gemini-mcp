import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerUsageTools } from '../../src/tools/usage.js';
import { GeminiClient } from '../../src/client.js';

/**
 * `gemini_token_usage` exists because the obvious design — read the account
 * balance before and after — cannot be built: the Generative Language API has
 * no billing/quota/account resource at all, and Cloud Billing has no balance
 * concept (Google Cloud is post-paid). Tokens are the accurate substitute, and
 * they attribute better than a balance diff ever could.
 */
describe('gemini_token_usage', () => {
  const harness = async (client: GeminiClient) =>
    createTestHarness((s) => registerUsageTools(s, client));

  afterEach(() => { /* each test builds its own client + session */ });

  it('reports nothing spent before anything has run, without inventing a zero', async () => {
    const client = new GeminiClient({ apiKey: 'k' });
    const h = await harness(client);
    const out = parseToolResult<{ usage: unknown; billed_calls: number }>(await h.callTool('gemini_token_usage', {}));
    await h.close();
    // `null`, not `{total_tokens: 0}` — "nothing has run" is not the same
    // claim as "a call cost zero".
    expect(out.usage).toBeNull();
    expect(out.billed_calls).toBe(0);
  });

  it('adds up what the session has spent across calls', async () => {
    const client = new GeminiClient({ apiKey: 'k' });
    client.session.recordUsage({ input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 });
    client.session.recordUsage({ input_tokens: 8, output_tokens: 1501, total_tokens: 1509, image_tokens: 1120 });

    const h = await harness(client);
    const out = parseToolResult<{ usage: Record<string, number>; billed_calls: number }>(
      await h.callTool('gemini_token_usage', {}),
    );
    await h.close();
    expect(out.usage).toEqual({ input_tokens: 15, output_tokens: 2919, total_tokens: 2934, image_tokens: 2240 });
    expect(out.billed_calls).toBe(2);
  });

  it('brackets a workflow: reset zeroes the total AFTER reporting it', async () => {
    // The before/after pattern the balance tool was wanted for — without
    // needing a balance, and without the caller doing arithmetic.
    const client = new GeminiClient({ apiKey: 'k' });
    client.session.recordUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
    const h = await harness(client);

    const first = parseToolResult<{ usage: Record<string, number>; reset?: boolean }>(
      await h.callTool('gemini_token_usage', { reset: true }),
    );
    // The reported figure is what was spent BEFORE the reset, not after.
    expect(first.usage.total_tokens).toBe(3);
    expect(first.reset).toBe(true);

    const second = parseToolResult<{ usage: unknown; billed_calls: number }>(
      await h.callTool('gemini_token_usage', {}),
    );
    await h.close();
    expect(second.usage).toBeNull();
    expect(second.billed_calls).toBe(0);
  });

  it('does not claim to report money', async () => {
    // A cost figure would need a rate card this server deliberately does not
    // hardcode; saying so in the result is what stops a caller assuming it.
    const client = new GeminiClient({ apiKey: 'k' });
    client.session.recordUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
    const h = await harness(client);
    const out = parseToolResult<{ note: string }>(await h.callTool('gemini_token_usage', {}));
    await h.close();
    expect(out.note).toMatch(/tokens only/i);
  });

  it('counts per session, so one tenant cannot read another\'s spend', async () => {
    const a = new GeminiClient({ apiKey: 'a' });
    const b = new GeminiClient({ apiKey: 'b' });
    a.session.recordUsage({ input_tokens: 100, output_tokens: 100, total_tokens: 200 });

    const h = await harness(b);
    const out = parseToolResult<{ usage: unknown }>(await h.callTool('gemini_token_usage', {}));
    await h.close();
    expect(out.usage).toBeNull();
  });
});
