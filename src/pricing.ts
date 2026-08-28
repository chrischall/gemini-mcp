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
 * Everything not in the card prices as `undefined` rather than zero. Video and
 * music are billed per second, not per token, so they are deliberately absent
 * — a token-based estimate for them would be wrong in kind, not just degree.
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
  /** Image output — the expensive one. */
  image_output: number;
}

/**
 * Paid-tier rates, USD per 1M tokens. Image generation has no free tier.
 * `-preview` ids are priced as their GA twin (see {@link normalizeModel}).
 */
export const RATE_CARD: Readonly<Record<string, ModelRates>> = Object.freeze({
  'gemini-3-pro-image': { input: 2.0, text_output: 12.0, image_output: 120.0 },
  'gemini-3.1-flash-image': { input: 0.5, text_output: 3.0, image_output: 60.0 },
  'gemini-3.1-flash-lite-image': { input: 0.25, text_output: 1.5, image_output: 30.0 },
  'gemini-2.5-flash-image': { input: 0.3, text_output: 3.0, image_output: 30.23 },
});

/** What one call cost, and how that total was arrived at. */
export interface CostEstimate {
  usd: number;
  breakdown: { input_usd: number; text_output_usd: number; image_usd: number };
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
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelRates>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...RATE_CARD };
    return { ...RATE_CARD, ...parsed };
  } catch {
    return { ...RATE_CARD };
  }
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

  const imageTokens = usage.image_tokens ?? 0;
  // Whatever the API did not attribute to images is text/thinking output.
  const textTokens = Math.max(0, usage.output_tokens - imageTokens);
  const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;

  const input_usd = per(usage.input_tokens, rates.input);
  const text_output_usd = per(textTokens, rates.text_output);
  const image_usd = per(imageTokens, rates.image_output);

  const shipped = RATE_CARD[key];
  const overridden =
    !shipped ||
    shipped.input !== rates.input ||
    shipped.text_output !== rates.text_output ||
    shipped.image_output !== rates.image_output;

  return {
    usd: input_usd + text_output_usd + image_usd,
    breakdown: { input_usd, text_output_usd, image_usd },
    priced_at: PRICED_AT,
    ...(overridden ? { overridden: true } : {}),
  };
}

/**
 * Attach a cost estimate to a result's meta, when the model has a rate.
 *
 * Silent when it does not — video and music are billed per second, so a
 * token-priced figure for them would be wrong in kind. An absent
 * `cost_estimate` beside a present `usage` means "not priceable", which is
 * the honest answer rather than a zero.
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
