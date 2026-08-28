/**
 * Turning tokens into money.
 *
 * This is possible — and only just — because image output is billed per token
 * like everything else, at a rate 20-40x the text-output rate. Google's
 * published per-image prices ARE that arithmetic: 1120 image tokens at
 * $30/1M is the $0.0336 quoted for a 1K flash-lite image, and 2000 at $120/1M
 * is the $0.24 quoted for a 4K pro image. `tests/pricing.test.ts` reconciles
 * every rate against a published per-image figure, so a typo here fails as an
 * equality rather than becoming a plausible wrong number.
 *
 * The consequence for the caller: output tokens MUST be split into image and
 * text before pricing. Billing an image model's text tokens at the image rate
 * overstates them twentyfold.
 *
 * ## Why a shipped default, and why it is dated
 *
 * A hardcoded rate card goes stale silently, and a confident wrong cost is
 * worse than no cost because people act on it. Two things keep that honest
 * here: every estimate carries {@link PRICED_AT}, the date these rates were
 * read from Google's pricing page, so a caller can see the card's age; and
 * `GEMINI_RATE_CARD` overrides or extends it without editing the package, so
 * a stale number is the operator's to fix in their own environment rather
 * than something they must wait on a release for.
 *
 * Everything not in the card prices as `undefined` rather than zero.
 *
 * Video and music ARE in the card, contrary to the first version of this
 * module. `gemini-omni-flash` — the model this server's video tool uses — is
 * token-billed at $17.50/1M (~5,792 tokens per second of 720p, which is the
 * ~$0.10/second Google quotes); it is Veo that bills per second, and this
 * server does not use Veo. Lyria genuinely is not token-billed: it charges per
 * song, which {@link ModelRates.per_generation} exists for.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (paid tier, USD).
 */
import { readEnvVar } from '@chrischall/mcp-utils';
import type { TokenUsage } from './usage.js';

/** The date the shipped rates were read from Google's pricing page. */
export const PRICED_AT = '2026-08-28';

/** USD per 1,000,000 tokens. */
export interface ModelRates {
  input: number;
  /** Text and "thinking" output. */
  text_output: number;
  /** Image output — 20-40x the text rate on the same model. */
  image_output?: number;
  /** Video output. Omni is token-billed ($17.50/1M ≈ 5,792 tokens per second of 720p). */
  video_output?: number;
  /** Audio output. */
  audio_output?: number;
  /**
   * A flat price per generation, for models billed that way rather than by
   * token. Lyria charges per song, so its token counts describe the work and
   * say nothing about the bill; when this is set it IS the cost and the
   * per-token rates are ignored.
   */
  per_generation?: number;
}

/**
 * Paid-tier rates, USD per 1M tokens. Image generation has no free tier.
 * `-preview` ids are priced as their GA twin (see {@link normalizeModel}).
 */
export const RATE_CARD: Readonly<Record<string, ModelRates>> = Object.freeze({
  'gemini-3-pro-image': { input: 2.0, text_output: 12.0, image_output: 120.0 },
  'gemini-3.1-flash-image': { input: 0.5, text_output: 3.0, image_output: 60.0 },
  'gemini-3.1-flash-lite-image': { input: 0.25, text_output: 1.5, image_output: 30.0 },
  // Google publishes 2.5-flash-image's output as $0.039 PER IMAGE at 1290
  // tokens, not as a per-1M rate. 0.039 / 1290 * 1e6 = 30.23 — a back-derived
  // figure, unlike the four above which are published per-1M directly. The
  // test reconciles it against the $0.039 it came from.
  'gemini-2.5-flash-image': { input: 0.3, text_output: 3.0, image_output: 30.2326 },
  // Omni is token-billed for video: $17.50/1M, ~5,792 tokens per second of
  // 720p, which is the ~$0.10/second Google quotes. Veo is the per-second
  // family; this server does not use it.
  'gemini-omni-flash': { input: 0.5, text_output: 3.0, image_output: 60.0, video_output: 17.5 },
  // Lyria bills per song, so tokens describe the work and not the bill.
  'lyria-3-clip': { input: 0, text_output: 0, per_generation: 0.04 },
  'lyria-3-pro': { input: 0, text_output: 0, per_generation: 0.08 },
});

/** What one call cost, and how that total was arrived at. */
export interface CostEstimate {
  usd: number;
  breakdown: {
    input_usd: number;
    text_output_usd: number;
    image_usd: number;
    video_usd: number;
    audio_usd: number;
    /** Set instead of the above when the model bills a flat rate per call. */
    per_generation_usd?: number;
  };
  /** The rate-card date, so a caller can see how old these numbers are. */
  priced_at: string;
  /** True when the figure used an operator-supplied rate rather than the shipped one. */
  overridden?: boolean;
}

/** `foo-preview` prices as `foo` — the fleet uses both spellings. */
function normalizeModel(model: string): string {
  return model.replace(/-preview$/, '');
}

/**
 * The effective rate card: the shipped one, with `GEMINI_RATE_CARD` merged
 * over it. A malformed override is ignored rather than thrown — the cost
 * figure is a convenience and the generation is the job, so a bad rate card
 * must not fail every call.
 */
export function loadRateCard(env: Record<string, string | undefined> = process.env): Record<string, ModelRates> {
  const raw = readEnvVar('GEMINI_RATE_CARD', { env });
  if (!raw) return { ...RATE_CARD };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...RATE_CARD };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...RATE_CARD };

  // Merge PER FIELD, not per model. A shallow per-model merge let a partial
  // override — `{"gemini-3-pro-image": {"image_output": 100}}`, the obvious
  // thing to write when one rate moves — drop `input` and `text_output`
  // entirely, and an undefined rate multiplied by a token count is NaN. That
  // NaN then flowed into the session accumulator, where it is absorbing: one
  // bad call and every later total reads NaN for the rest of the session.
  const out: Record<string, ModelRates> = { ...RATE_CARD };
  for (const [model, override] of Object.entries(parsed as Record<string, unknown>)) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
    // Store under the SAME key `estimateCost` looks up. Writing the raw key
    // meant an override for `lyria-3-clip-preview` — the id a caller actually
    // holds, since the video and music models are preview-only — landed under
    // that key while lookup normalized to `lyria-3-clip`, so it was silently
    // ignored: the operator's rate was accepted, stored, and never used.
    const key = normalizeModel(model);
    const merged: Record<string, unknown> = { ...(RATE_CARD[key] ?? {}), ...(out[key] ?? {}) };
    for (const [field, value] of Object.entries(override as Record<string, unknown>)) {
      // Only finite numbers get in. A string, null or NaN in the override is
      // dropped rather than propagated into arithmetic.
      if (typeof value === 'number' && Number.isFinite(value)) merged[field] = value;
    }
    // A model still lacking the two mandatory rates cannot be priced at all,
    // and half a rate card is worse than none.
    if (typeof merged.input === 'number' && typeof merged.text_output === 'number') {
      out[key] = merged as unknown as ModelRates;
    }
  }
  return out;
}

/**
 * Estimate what a call cost, or `undefined` when there is no rate for the
 * model — never a zero, which would read as "this was free".
 */
export function estimateCost(
  model: string,
  usage: TokenUsage,
  env: Record<string, string | undefined> = process.env,
): CostEstimate | undefined {
  const card = loadRateCard(env);
  const key = normalizeModel(model);
  const rates = card[key];
  if (!rates) return undefined;

  const per = (tokens: number, rate: number | undefined) =>
    // An absent rate prices as zero, never NaN. A modality with no published
    // rate is not evidence of spend, and NaN is absorbing — it would poison
    // every later total in the session.
    typeof rate === 'number' && Number.isFinite(rate) ? (tokens * rate) / 1_000_000 : 0;

  // Billed per call, not per token: the tokens describe the work and say
  // nothing about the bill, so pricing them would double-count.
  if (typeof rates.per_generation === 'number') {
    return {
      usd: rates.per_generation,
      breakdown: {
        input_usd: 0, text_output_usd: 0, image_usd: 0, video_usd: 0, audio_usd: 0,
        per_generation_usd: rates.per_generation,
      },
      priced_at: PRICED_AT,
      ...(overriddenFor(key, rates) ? { overridden: true } : {}),
    };
  }

  const imageTokens = usage.image_tokens ?? 0;
  const videoTokens = usage.video_tokens ?? 0;
  const audioTokens = usage.audio_tokens ?? 0;
  // Whatever the API attributed to no modality is text/thinking output — the
  // cheap end, so an unrecognised modality understates rather than inflates.
  const textTokens = Math.max(0, usage.output_tokens - imageTokens - videoTokens - audioTokens);

  const input_usd = per(usage.input_tokens, rates.input);
  const text_output_usd = per(textTokens, rates.text_output);
  const image_usd = per(imageTokens, rates.image_output);
  const video_usd = per(videoTokens, rates.video_output);
  const audio_usd = per(audioTokens, rates.audio_output);

  return {
    usd: input_usd + text_output_usd + image_usd + video_usd + audio_usd,
    breakdown: { input_usd, text_output_usd, image_usd, video_usd, audio_usd },
    priced_at: PRICED_AT,
    ...(overriddenFor(key, rates) ? { overridden: true } : {}),
  };
}

/** Did any rate for this model come from the operator rather than the shipped card? */
function overriddenFor(key: string, rates: ModelRates): boolean {
  const shipped = RATE_CARD[key];
  if (!shipped) return true;
  return (Object.keys(rates) as Array<keyof ModelRates>).some((f) => rates[f] !== shipped[f]);
}

/**
 * Attach a cost estimate to a result's meta, when the model has a rate.
 *
 * Silent when it does not — a model absent from the rate card. An absent
 * `cost_estimate` beside a present `usage` means "no rate for this model",
 * which is the honest answer rather than a zero.
 */
export function attachCost(
  meta: Record<string, unknown>,
  model: string,
  usage: TokenUsage | undefined,
): Record<string, unknown> {
  if (!usage) return meta;
  const cost = estimateCost(model, usage);
  if (cost) meta.cost_estimate = cost;
  return meta;
}
