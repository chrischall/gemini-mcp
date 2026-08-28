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

/**
 * A partial override is the obvious thing to write when one rate moves, and it
 * used to poison the session. `{"gemini-3-pro-image": {"image_output": 100}}`
 * replaced the whole model entry, dropping `input` and `text_output`; an
 * undefined rate times a token count is NaN, and NaN is absorbing — one bad
 * call and every later total in the session reads NaN.
 */
describe('a partial rate-card override cannot produce NaN', () => {
  const usage = { input_tokens: 7, output_tokens: 1418, total_tokens: 1425, image_tokens: 1120 };

  it('keeps the shipped rates for fields the override omits', () => {
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'gemini-3-pro-image': { image_output: 100 } }) };
    const c = estimateCost('gemini-3-pro-image', usage, env)!;
    expect(Number.isFinite(c.usd)).toBe(true);
    expect(c.breakdown.image_usd).toBeCloseTo(0.112, 6);            // the override
    expect(c.breakdown.input_usd).toBeCloseTo(0.000014, 9);          // shipped $2.00/1M
    expect(c.breakdown.text_output_usd).toBeCloseTo(0.003576, 6);    // shipped $12.00/1M
    expect(c.overridden).toBe(true);
  });

  it('drops a non-numeric rate rather than letting it reach the arithmetic', () => {
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'gemini-3-pro-image': { image_output: 'free' } }) };
    const c = estimateCost('gemini-3-pro-image', usage, env)!;
    expect(Number.isFinite(c.usd)).toBe(true);
    expect(c.breakdown.image_usd).toBeCloseTo(0.1344, 6);            // unchanged
  });

  it('refuses a new model that does not carry the mandatory rates', () => {
    // Half a rate card is worse than none — it would price as a confident zero.
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'brand-new': { image_output: 5 } }) };
    expect(estimateCost('brand-new', usage, env)).toBeUndefined();
  });
});

describe('video and music', () => {
  it('prices omni video from tokens, at the rate Google quotes per second', () => {
    // $17.50/1M and 5,792 tokens per second of 720p is the ~$0.10/second in
    // the pricing table — the reconciliation that says the rate is right.
    const oneSecond = { input_tokens: 0, output_tokens: 5792, total_tokens: 5792, video_tokens: 5792 };
    expect(estimateCost('gemini-omni-flash-preview', oneSecond)?.usd).toBeCloseTo(0.10136, 5);
  });

  it('bills a Lyria song per generation, ignoring its token counts', () => {
    // Lyria charges per song, so the tokens describe the work and say nothing
    // about the bill. Pricing them too would double-count.
    const noisy = { input_tokens: 9999, output_tokens: 99999, total_tokens: 109998, audio_tokens: 99999 };
    const clip = estimateCost('lyria-3-clip-preview', noisy)!;
    expect(clip.usd).toBe(0.04);
    expect(clip.breakdown.per_generation_usd).toBe(0.04);
    expect(clip.breakdown.audio_usd).toBe(0);
    expect(estimateCost('lyria-3-pro-preview', noisy)?.usd).toBe(0.08);
  });

  it('reconciles gemini-2.5-flash-image against the $0.039 per image it was derived from', () => {
    // This rate is BACK-DERIVED: Google publishes $0.039/image at 1290 tokens,
    // not a per-1M figure. The reconciliation is the only thing keeping the
    // division honest.
    const oneImage = { input_tokens: 0, output_tokens: 1290, total_tokens: 1290, image_tokens: 1290 };
    expect(estimateCost('gemini-2.5-flash-image', oneImage)?.usd).toBeCloseTo(0.039, 4);
  });

  it('prices an unattributed modality as text, which understates rather than inflates', () => {
    const u = { input_tokens: 0, output_tokens: 1000, total_tokens: 1000 };
    const c = estimateCost('gemini-3.1-flash-lite-image', u)!;
    expect(c.breakdown.text_output_usd).toBeCloseTo(0.0015, 8);
    expect(c.breakdown.image_usd + c.breakdown.video_usd + c.breakdown.audio_usd).toBe(0);
  });
});

/**
 * The video and music models are preview-only, so `gemini-omni-flash-preview`
 * and `lyria-3-clip-preview` are the ids a caller actually holds — and the ids
 * they would naturally key an override by. Storing overrides under the raw key
 * while looking them up normalized meant those entries were accepted, stored,
 * and never used: the operator's rate was silently ignored.
 */
describe('rate-card overrides keyed by a -preview id', () => {
  const oneSecond = { input_tokens: 0, output_tokens: 5792, total_tokens: 5792, video_tokens: 5792 };

  it('applies an override keyed by the preview id', () => {
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'gemini-omni-flash-preview': { video_output: 35 } }) };
    const c = estimateCost('gemini-omni-flash-preview', oneSecond, env)!;
    expect(c.breakdown.video_usd).toBeCloseTo(0.20272, 5);   // 5792 x $35/1M
    expect(c.overridden).toBe(true);
  });

  it('applies it to the GA id too, since they price as one model', () => {
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'gemini-omni-flash-preview': { video_output: 35 } }) };
    expect(estimateCost('gemini-omni-flash', oneSecond, env)?.breakdown.video_usd).toBeCloseTo(0.20272, 5);
  });

  it('overrides a per-generation price by its preview id', () => {
    const env = { GEMINI_RATE_CARD: JSON.stringify({ 'lyria-3-clip-preview': { input: 0, text_output: 0, per_generation: 0.06 } }) };
    expect(estimateCost('lyria-3-clip-preview', { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, env)?.usd).toBe(0.06);
  });
});

/**
 * Omni's rates, each reconciled against something Google states.
 *
 * The first version of this entry had three of four numbers wrong — a $60
 * image-output rate invented by copying flash-image, and input/text rates a
 * third of the real ones — because only the video rate had been looked up and
 * the rest were assumed. These pin every figure that has a published
 * cross-check.
 */
describe('gemini-omni-flash', () => {
  it('prices one second of 720p video at the ~$0.10 Google quotes', () => {
    // "5,792 tokens per second of 720p video" at $17.50/1M.
    const oneSecond = { input_tokens: 0, output_tokens: 5792, total_tokens: 5792, video_tokens: 5792 };
    expect(estimateCost('gemini-omni-flash', oneSecond)?.usd).toBeCloseTo(0.10136, 5);
  });

  it('bills its text output at $9.00/1M, not the $3.00 copied from flash-image', () => {
    const u = { input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000 };
    expect(estimateCost('gemini-omni-flash', u)?.breakdown.text_output_usd).toBeCloseTo(9.0, 6);
  });

  it('bills its input at $1.50/1M', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 };
    expect(estimateCost('gemini-omni-flash', u)?.breakdown.input_usd).toBeCloseTo(1.5, 6);
  });

  it('charges nothing for image output, because no image rate is published for it', () => {
    // The honest consequence of having no rate: zero, not an invented figure.
    const u = { input_tokens: 0, output_tokens: 1120, total_tokens: 1120, image_tokens: 1120 };
    expect(estimateCost('gemini-omni-flash', u)?.breakdown.image_usd).toBe(0);
  });
});
