import { describe, it, expect } from 'vitest';
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

  it('prices the session and dates the rates it used', async () => {
    // A cost figure is only as trustworthy as the card behind it, so the date
    // travels with the number rather than living in a doc nobody reads.
    const client = new GeminiClient({ apiKey: 'k' });
    client.session.recordUsage(
      { input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 },
      'gemini-3.1-flash-lite-image',
    );
    const h = await harness(client);
    const out = parseToolResult<{ estimated_cost_usd: number; priced_calls: number; rates_published: string }>(
      await h.callTool('gemini_token_usage', {}),
    );
    await h.close();
    expect(out.estimated_cost_usd).toBeCloseTo(0.03404875, 8);
    expect(out.priced_calls).toBe(1);
    expect(out.rates_published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says so when some calls could not be priced, instead of undercounting silently', async () => {
    // A model absent from the rate card contributes tokens and no cost. A
    // total that quietly omitted it would read as complete. (Veo is the
    // example here: this server does not use it, so it has no rate.)
    const client = new GeminiClient({ apiKey: 'k' });
    client.session.recordUsage({ input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 }, 'gemini-3.1-flash-lite-image');
    client.session.recordUsage({ input_tokens: 5, output_tokens: 500, total_tokens: 505 }, 'veo-3.1-generate-preview');
    const h = await harness(client);
    const out = parseToolResult<{ billed_calls: number; priced_calls: number; note: string }>(
      await h.callTool('gemini_token_usage', {}),
    );
    await h.close();
    expect(out.billed_calls).toBe(2);
    expect(out.priced_calls).toBe(1);
    expect(out.note).toMatch(/1 of 2 billed calls/);
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

/**
 * End to end: a real response shape → client → session → tool meta.
 *
 * The normalizer and the tool were each unit-tested, and the wiring BETWEEN
 * them was not — which is exactly where the first version of this feature was
 * broken (usage was recorded at the return statement, so a billed call that a
 * safety filter emptied never counted). These drive a usage-bearing body
 * through a mocked fetchImpl and assert on what comes out the far end.
 */
describe('usage wiring, end to end', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  // The usageMetadata block verbatim from a live gemini-3.1-flash-lite-image call.
  const USAGE = {
    promptTokenCount: 7,
    candidatesTokenCount: 1418,
    totalTokenCount: 1425,
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
  };

  const imageResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('carries a generateContent usage block into the result meta', async () => {
    const { registerGenerateTools } = await import('../../src/tools/generate.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gemini-usage-'));
    try {
      const fetchImpl = (async () =>
        imageResponse({
          candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG } }] } }],
          usageMetadata: USAGE,
        })) as unknown as typeof fetch;
      const client = new GeminiClient({ apiKey: 'k', fetchImpl });
      const h = await createTestHarness((s) => registerGenerateTools(s, client));
      const meta = parseToolResult<{ usage?: Record<string, number> }>(
        await h.callTool('gemini_image_generate', { prompt: 'a leaf', output_dir: dir }),
      );
      await h.close();

      expect(meta.usage).toEqual({ input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 });
      // …and the same call moved the session total, which is what the report tool reads.
      expect(client.session.usageTotal?.total_tokens).toBe(1425);
      expect(client.session.billedCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a billed call that returned no image, because it was still billed', async () => {
    // The bug the first version of this shipped with: the "returned no image"
    // throw happens after the response lands, so recording at the return
    // dropped precisely the calls a spend total needs to see.
    const { registerGenerateTools } = await import('../../src/tools/generate.js');
    const fetchImpl = (async () =>
      imageResponse({ candidates: [{ content: { parts: [{ text: 'blocked' }] } }], usageMetadata: USAGE })) as unknown as typeof fetch;
    const client = new GeminiClient({ apiKey: 'k', fetchImpl });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));

    const res = await h.callTool('gemini_image_generate', { prompt: 'a leaf', inline: true });
    await h.close();

    expect(res.isError).toBe(true);                       // no image came back…
    expect(client.session.usageTotal?.total_tokens).toBe(1425);  // …and it still cost 1425.
  });
});
