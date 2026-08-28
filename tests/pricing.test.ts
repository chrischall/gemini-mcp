import { describe, it, expect } from 'vitest';
import { estimateCost, loadRateCard, RATE_CARD, PRICED_AT } from '../src/pricing.js';

/**
 * The published per-image prices are the token maths, which is the whole
 * reason a cost estimate is possible at all: image output is billed per token
 * like everything else, just at a rate 20-40x the text-output rate. Splitting
 * output into image vs text is therefore not a nicety — get it wrong and the
 * answer is off by more than an order of magnitude.
 *
 * Each case below reconciles against a price Google publishes per image, so a
 * drift in either the rates or the arithmetic shows up as a failing equality
 * rather than a plausible wrong number.
 */
describe('estimateCost reconciles with the published per-image prices', () => {
  const oneImage = (imageTokens: number) => ({
    input_tokens: 0,
    output_tokens: imageTokens,
    total_tokens: imageTokens,
    image_tokens: imageTokens,
  });

  it('gemini-3.1-flash-lite-image 1K → $0.0336', () => {
    expect(estimateCost('gemini-3.1-flash-lite-image', oneImage(1120))?.usd).toBeCloseTo(0.0336, 6);
  });

  it('gemini-3.1-flash-image 1K → $0.067', () => {
    expect(estimateCost('gemini-3.1-flash-image', oneImage(1120))?.usd).toBeCloseTo(0.0672, 6);
  });

  it('gemini-3-pro-image 1K → $0.134, and 4K → $0.24', () => {
    expect(estimateCost('gemini-3-pro-image', oneImage(1120))?.usd).toBeCloseTo(0.1344, 6);
    expect(estimateCost('gemini-3-pro-image', oneImage(2000))?.usd).toBeCloseTo(0.24, 6);
  });

  it('bills text output at the TEXT rate, not the image rate', () => {
    // The 20x gap: 298 text tokens at $1.50/1M is $0.000447. Billing them as
    // image tokens would say $0.00894 — twenty times too much.
    const c = estimateCost('gemini-3.1-flash-lite-image', {
      input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120,
    })!;
    expect(c.breakdown.image_usd).toBeCloseTo(0.0336, 6);
    expect(c.breakdown.text_output_usd).toBeCloseTo(0.000447, 6);
    expect(c.breakdown.input_usd).toBeCloseTo(0.00000175, 9);
    // 0.00000175 + 0.000447 + 0.0336, to the cent-fraction that matters.
    expect(c.usd).toBeCloseTo(0.03404875, 8);
  });

  it('treats all output as text when the API broke out no image tokens', () => {
    const c = estimateCost('gemini-3.1-flash-lite-image', { input_tokens: 10, output_tokens: 100, total_tokens: 110 })!;
    expect(c.breakdown.image_usd).toBe(0);
    expect(c.breakdown.text_output_usd).toBeCloseTo(0.00015, 9);
  });

  it('returns undefined for a model it has no rate for, rather than guessing', () => {
    // An invented number is worse than none: someone would act on it.
    expect(estimateCost('veo-3.1-generate-preview', oneImage(1120))).toBeUndefined();
    expect(estimateCost('gemini-9-unreleased', oneImage(1120))).toBeUndefined();
  });

  it('prices a -preview model id the same as its GA twin', () => {
    // The fleet uses both `gemini-3-pro-image` and `gemini-3-pro-image-preview`.
    expect(estimateCost('gemini-3-pro-image-preview', oneImage(1120))?.usd)
      .toBe(estimateCost('gemini-3-pro-image', oneImage(1120))?.usd);
  });

  it('states when the rates were published, so a stale card is visible', () => {
    expect(PRICED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(estimateCost('gemini-3-pro-image', oneImage(1120))?.priced_at).toBe(PRICED_AT);
  });
});

describe('loadRateCard', () => {
  it('lets an operator override a rate without editing the package', () => {
    const card = loadRateCard({
      GEMINI_RATE_CARD: JSON.stringify({ 'gemini-3.1-flash-lite-image': { input: 1, text_output: 2, image_output: 3 } }),
    });
    expect(card['gemini-3.1-flash-lite-image']).toEqual({ input: 1, text_output: 2, image_output: 3 });
  });

  it('lets an operator add a model the shipped card does not know', () => {
    const card = loadRateCard({ GEMINI_RATE_CARD: JSON.stringify({ 'some-new-model': { input: 1, text_output: 2, image_output: 3 } }) });
    expect(card['some-new-model']).toBeDefined();
    // …without losing the shipped entries.
    expect(card['gemini-3-pro-image']).toEqual(RATE_CARD['gemini-3-pro-image']);
  });

  it('ignores an unparseable override rather than failing every generation', () => {
    // A malformed rate card must not take the server down; the cost figure is
    // a convenience and the generation is the job.
    expect(loadRateCard({ GEMINI_RATE_CARD: 'not json' })).toEqual(RATE_CARD);
    expect(loadRateCard({})).toEqual(RATE_CARD);
  });
});
