import { describe, it, expect } from 'vitest';
import { readUsage, sumUsage, type TokenUsage } from '../src/usage.js';

/**
 * Both Gemini APIs report what a call cost in tokens, and this server threw it
 * away. They report it differently: `generateContent` returns camelCase
 * `usageMetadata`, the Interactions API returns snake_case `usage` with
 * different field NAMES (not just different casing) and two fields
 * generateContent has no equivalent for. Both shapes below are copied from
 * live responses, not invented.
 */
describe('readUsage', () => {
  it('reads a generateContent usageMetadata block', () => {
    // Verbatim from a live gemini-3.1-flash-lite-image call.
    const u = readUsage({
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 1418,
        totalTokenCount: 1425,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 7 }],
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
      },
    });
    expect(u).toEqual({ input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 });
  });

  it('reads an Interactions usage block, whose field names differ', () => {
    // Verbatim from a live /v1beta/interactions call.
    const u = readUsage({
      usage: {
        total_tokens: 1509,
        total_input_tokens: 8,
        total_output_tokens: 1501,
        input_tokens_by_modality: [{ modality: 'text', tokens: 8 }],
        output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }],
        total_cached_tokens: 0,
        total_thought_tokens: 0,
      },
    });
    expect(u).toEqual({ input_tokens: 8, output_tokens: 1501, total_tokens: 1509, image_tokens: 1120 });
  });

  it('carries cached and thought tokens only when they are non-zero', () => {
    // They matter for cost — cached input is discounted — but reporting a
    // constant 0 on every call is noise.
    const u = readUsage({
      usage: { total_tokens: 10, total_input_tokens: 4, total_output_tokens: 6, total_cached_tokens: 3, total_thought_tokens: 2 },
    });
    expect(u).toMatchObject({ cached_tokens: 3, thought_tokens: 2 });
  });

  it('returns undefined when the response carries no usage at all', () => {
    // Never invent a zero: "we do not know" and "it cost nothing" are
    // different claims, and a caller summing costs must be able to tell.
    expect(readUsage({})).toBeUndefined();
    expect(readUsage(undefined)).toBeUndefined();
    expect(readUsage({ usageMetadata: {} })).toBeUndefined();
  });

  it('survives a modality list that is missing or malformed', () => {
    const u = readUsage({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } });
    expect(u).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });
});

describe('sumUsage', () => {
  const a: TokenUsage = { input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 };
  const b: TokenUsage = { input_tokens: 8, output_tokens: 1501, total_tokens: 1509, image_tokens: 1120 };

  it('adds up the calls a single tool made', () => {
    // `count: 2` is two billable requests; reporting only the first would
    // understate the call by half.
    expect(sumUsage([a, b])).toEqual({ input_tokens: 15, output_tokens: 2919, total_tokens: 2934, image_tokens: 2240 });
  });

  it('ignores gaps rather than treating them as zero', () => {
    expect(sumUsage([a, undefined, b])?.total_tokens).toBe(2934);
  });

  it('returns undefined when nothing is known, so silence stays silence', () => {
    expect(sumUsage([])).toBeUndefined();
    expect(sumUsage([undefined, undefined])).toBeUndefined();
  });
});

/**
 * A replayed result must not be counted as fresh spend.
 *
 * `dispatch()` serves a matching `idempotency_key` from the registry without
 * making an upstream call — that is the whole point of it. The recorded result
 * still carries the ORIGINAL call's `usage`, so a caller adding up a workflow
 * would count tokens that were billed once as billed twice.
 */
describe('reused results and spend', () => {
  it('marks replayed usage as already-billed rather than dropping or repeating it', async () => {
    const { annotateReusedUsage } = await import('../src/usage.js');
    const meta = { model: 'm', usage: { input_tokens: 7, output_tokens: 1418, total_tokens: 1425 } };
    const out = annotateReusedUsage({ ...meta });
    // The numbers stay — they describe the generation you are looking at —
    // but they are labelled so a total can exclude them.
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 1418, total_tokens: 1425 });
    expect(out.usage_billed).toBe(false);
  });

  it('leaves a result with no usage alone', () => {
    // Nothing known stays nothing known; it must not become "billed: false",
    // which would read as a positive claim about a call we know nothing about.
    return import('../src/usage.js').then(({ annotateReusedUsage }) => {
      expect(annotateReusedUsage({ model: 'm' })).toEqual({ model: 'm' });
    });
  });
});
