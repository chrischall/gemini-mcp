/**
 * What a generation cost, in tokens.
 *
 * Both Gemini APIs already report this and this server used to discard it. The
 * two disagree on more than casing: `generateContent` returns camelCase
 * `usageMetadata` with `promptTokenCount` / `candidatesTokenCount`, while the
 * Interactions API returns snake_case `usage` with `total_input_tokens` /
 * `total_output_tokens` plus cached- and thought-token counts that
 * `generateContent` has no equivalent for. This module is the one place that
 * knows both, so nothing downstream has to.
 *
 * Absence is preserved deliberately. A response with no usage block yields
 * `undefined`, never a zeroed record: "we do not know what this cost" and "this
 * cost nothing" are different claims, and a caller adding up a workflow has to
 * be able to tell them apart.
 */

/** Normalized token usage for one upstream call. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Output tokens attributed to image modality, when the API broke it out. */
  image_tokens?: number;
  /** Output tokens attributed to video modality (omni is token-billed). */
  video_tokens?: number;
  /** Output tokens attributed to audio modality. */
  audio_tokens?: number;
  /** Cached input tokens — discounted upstream, so worth surfacing. */
  cached_tokens?: number;
  /** Reasoning tokens (Interactions only). */
  thought_tokens?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Pull one modality's entry out of either API's by-modality list.
 *
 * Modality matters for money, not just curiosity: each is billed at its own
 * rate, and they differ by more than an order of magnitude (text output vs
 * image output is 20-40x on the same model). A modality nobody breaks out is
 * priced as text, which is the cheap end — so missing one understates rather
 * than inventing spend.
 */
function modalityTokens(list: unknown, modality: string): number | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { modality?: unknown; tokenCount?: unknown; tokens?: unknown };
    // generateContent shouts ("IMAGE"); the Interactions API does not ("image").
    if (typeof e.modality === 'string' && e.modality.toLowerCase() === modality) {
      return num(e.tokenCount) ?? num(e.tokens);
    }
  }
  return undefined;
}

/**
 * Read whichever usage block a response carries, or `undefined` when it
 * carries neither — including the case where the block exists but has no
 * totals in it, which is indistinguishable from absent for our purposes.
 */
export function readUsage(body: unknown): TokenUsage | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { usageMetadata?: Record<string, unknown>; usage?: Record<string, unknown> };

  const meta = b.usageMetadata;
  if (meta) {
    const input = num(meta.promptTokenCount);
    const output = num(meta.candidatesTokenCount);
    const total = num(meta.totalTokenCount);
    if (input !== undefined || output !== undefined || total !== undefined) {
      return compact({
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
        total_tokens: total ?? (input ?? 0) + (output ?? 0),
        image_tokens: modalityTokens(meta.candidatesTokensDetails, 'image'),
        video_tokens: modalityTokens(meta.candidatesTokensDetails, 'video'),
        audio_tokens: modalityTokens(meta.candidatesTokensDetails, 'audio'),
        cached_tokens: num(meta.cachedContentTokenCount),
      });
    }
  }

  const usage = b.usage;
  if (usage) {
    const input = num(usage.total_input_tokens);
    const output = num(usage.total_output_tokens);
    const total = num(usage.total_tokens);
    if (input !== undefined || output !== undefined || total !== undefined) {
      return compact({
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
        total_tokens: total ?? (input ?? 0) + (output ?? 0),
        image_tokens: modalityTokens(usage.output_tokens_by_modality, 'image'),
        video_tokens: modalityTokens(usage.output_tokens_by_modality, 'video'),
        audio_tokens: modalityTokens(usage.output_tokens_by_modality, 'audio'),
        cached_tokens: num(usage.total_cached_tokens),
        thought_tokens: num(usage.total_thought_tokens),
      });
    }
  }
  return undefined;
}

/** Drop the optional counts that are absent or zero — a constant 0 is noise. */
function compact(u: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
  };
  if (u.image_tokens) out.image_tokens = u.image_tokens;
  if (u.video_tokens) out.video_tokens = u.video_tokens;
  if (u.audio_tokens) out.audio_tokens = u.audio_tokens;
  if (u.cached_tokens) out.cached_tokens = u.cached_tokens;
  if (u.thought_tokens) out.thought_tokens = u.thought_tokens;
  return out;
}

/**
 * Add up several calls — `count: N` bills N times, so a tool that reports only
 * the first call understates itself. Gaps are skipped rather than counted as
 * zero; if nothing at all is known the sum is `undefined`, so silence does not
 * turn into a confident total.
 */
export function sumUsage(parts: ReadonlyArray<TokenUsage | undefined>): TokenUsage | undefined {
  const known = parts.filter((p): p is TokenUsage => p !== undefined);
  if (known.length === 0) return undefined;
  return compact(
    known.reduce<TokenUsage>(
      (acc, u) => ({
        input_tokens: acc.input_tokens + u.input_tokens,
        output_tokens: acc.output_tokens + u.output_tokens,
        total_tokens: acc.total_tokens + u.total_tokens,
        image_tokens: (acc.image_tokens ?? 0) + (u.image_tokens ?? 0),
        video_tokens: (acc.video_tokens ?? 0) + (u.video_tokens ?? 0),
        audio_tokens: (acc.audio_tokens ?? 0) + (u.audio_tokens ?? 0),
        cached_tokens: (acc.cached_tokens ?? 0) + (u.cached_tokens ?? 0),
        thought_tokens: (acc.thought_tokens ?? 0) + (u.thought_tokens ?? 0),
      }),
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    ),
  );
}

/**
 * Mark a replayed result's usage as already billed.
 *
 * `JobRegistry.dispatch()` can serve a matching `idempotency_key` from the
 * registry without calling upstream — that is what makes a host-timeout retry
 * free. The recorded result still carries the ORIGINAL call's usage, which is
 * correct as a description of the image you are being handed and wrong as a
 * measure of what this call cost: nothing.
 *
 * So the counts stay and gain `usage_billed: false`, which is what lets a
 * workflow total exclude them. Dropping them instead would be worse — the
 * caller could no longer see how the image was produced — and leaving them
 * unmarked would double-count a generation that was paid for once.
 *
 * A result with no usage at all is left untouched: "unknown" must not turn
 * into the positive claim "not billed".
 */
export function annotateReusedUsage(meta: Record<string, unknown>): Record<string, unknown> {
  if (!meta.usage) return meta;
  meta.usage_billed = false;
  // The cost estimate needs the same treatment for the same reason, and is
  // worse if it does not get it: a token count someone forgets to exclude is a
  // rounding error in a report, a dollar figure is the report. Marked rather
  // than deleted, so the result still shows what the generation cost when it
  // was actually made.
  if (meta.cost_estimate) meta.cost_billed = false;
  return meta;
}
