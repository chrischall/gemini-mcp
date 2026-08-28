import { JobRegistry } from './jobs.js';
import { sumUsage, type TokenUsage } from './usage.js';
import { estimateCost } from './pricing.js';

/**
 * Everything the server remembers *between tool calls on behalf of one user*.
 *
 * All of this used to be module-level (`jobs`/`byKey`/`runningByFingerprint` in
 * jobs.ts, `lastInteractionId`/`writtenOutputs` in tools/interact.ts). That is
 * correct for stdio, where a process serves exactly one user — and a
 * cross-tenant leak on the hosted connector, where ONE child process serves
 * every session of this registration at once (mcp-host runs the stdio server as
 * a supervised child). Module state there is shared by
 * every authenticated claude.ai session on that child: the per-session
 * `GeminiClient` isolated the API key but not the memory around it, so a
 * colliding `idempotency_key` replayed another user's result, an identical
 * prompt attached to another user's in-flight (billable) job, and
 * `continue_last: true` resumed another user's interaction under your key.
 *
 * So session memory hangs off the `GeminiClient` — the one object the connector
 * already builds per authenticated session and
 * threads into every registrar. Handlers reach it as `client.session`.
 *
 * The rule this encodes: **`src/` must hold no module-level mutable state.**
 * If you need to remember something across calls, put it here.
 */
export class SessionState {
  /** Idempotency + async-handle registry for this session (issues #52/#53). */
  readonly jobs = new JobRegistry();

  /**
   * The most recent interaction id THIS session created — what
   * `continue_last: true` resumes. In-memory only, so "last" means "last in
   * this session"; a restart falls back to the newest sidecar on disk.
   */
  lastInteractionId: string | undefined;

  /**
   * The same, for the media-specific tools, which keep their own chains.
   * `gemini_music_generate` IS served by the hosted connector, so this one
   * leaked across tenants exactly as `lastInteractionId` did; video is
   * stdio-only today but carries the identical hazard, so both are scoped here.
   */
  lastMusicInteractionId: string | undefined;
  lastVideoInteractionId: string | undefined;

  /**
   * Absolute paths of every image this session has written. Used to drop a
   * chained call's re-attached prior output: the interaction state already
   * contains that image, and re-sending it as a fresh reference anchors the
   * model against the requested edit.
   */
  readonly writtenOutputs = new Set<string>();

  /**
   * Files API uploads this session can reuse, keyed by an opaque identity
   * string (for a local path: absolute path + mtime + size, so an edited file
   * is a different key rather than a stale hit).
   *
   * Backs the stdio "referenced twice → upload once" optimization: the second
   * time a session sends the same picture, the bytes are replaced by a
   * `files/…` reference that costs nothing to repeat. Session-scoped, like
   * everything else here — a uri is minted by ONE user's API key and is only
   * readable with that key, so sharing this map across the connector's tenants
   * would hand out references another user cannot use and this user did not
   * create.
   */
  readonly uploadCache = new Map<string, CachedUpload>();

  /**
   * How many times each identity has been referenced this session. The
   * threshold for auto-uploading is "more than once", so the count has to
   * outlive the call that first saw it.
   */
  readonly referenceCounts = new Map<string, number>();

  /** Record a reference and return the running total (1 on first sight). */
  countReference(key: string): number {
    const next = (this.referenceCounts.get(key) ?? 0) + 1;
    this.referenceCounts.set(key, next);
    return next;
  }

  /** A cached upload, or `undefined` if absent or past its Files API TTL. */
  cachedUpload(key: string, now = Date.now()): CachedUpload | undefined {
    const hit = this.uploadCache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAtMs <= now) {
      this.uploadCache.delete(key);
      return undefined;
    }
    return hit;
  }

  /**
   * Everything this session has spent, in tokens, across every upstream call.
   *
   * Accumulated in the CLIENT rather than in the tools, so a call that was
   * billed and then failed (a safety filter returning no image, say) still
   * counts — it cost money regardless of whether a tool could use the result.
   * Per session, never module scope: one hosted process serves many tenants,
   * and a shared total would report other people's spend as yours.
   */
  usageTotal: TokenUsage | undefined;

  /** How many upstream calls contributed to {@link usageTotal}. */
  billedCalls = 0;

  /**
   * What this session has spent in USD, priced per call.
   *
   * Accumulated as calls happen rather than derived from {@link usageTotal} at
   * the end, because the total spans models: summing a Pro call's tokens with
   * a Lite call's and pricing the result at one rate would be wrong by up to
   * 4x. Each call is priced against ITS model and only the money is added up.
   *
   * `undefined` while nothing priceable has run — a model absent from the rate
   * card contributes usage but no cost, so a total of `undefined` beside a
   * non-zero usage is meaningful rather than a bug. (Video and music DO price:
   * omni is token-billed and Lyria bills per song. It is an unknown or
   * newly-released model id that goes unpriced.)
   */
  costUsd: number | undefined;

  /** How many of {@link billedCalls} could actually be priced. */
  pricedCalls = 0;

  /**
   * Fold one upstream call's usage into the running totals. `model` is what
   * makes the cost side possible; without it the tokens still count.
   */
  recordUsage(usage: TokenUsage | undefined, model?: string): void {
    if (!usage) return;
    this.usageTotal = sumUsage([this.usageTotal, usage]);
    this.billedCalls += 1;
    if (!model) return;
    const cost = estimateCost(model, usage);
    if (!cost) return;
    this.costUsd = (this.costUsd ?? 0) + cost.usd;
    this.pricedCalls += 1;
  }

  /** Forget everything. Tests use this; nothing in `src/` calls it. */
  reset(): void {
    this.jobs.reset();
    this.usageTotal = undefined;
    this.billedCalls = 0;
    this.costUsd = undefined;
    this.pricedCalls = 0;
    this.lastInteractionId = undefined;
    this.lastMusicInteractionId = undefined;
    this.lastVideoInteractionId = undefined;
    this.writtenOutputs.clear();
    this.uploadCache.clear();
    this.referenceCounts.clear();
  }
}

/** One remembered Files API upload. */
export interface CachedUpload {
  /** `files/<id>` resource name. */
  name: string;
  /** Full uri to reference in a request. */
  uri: string;
  mimeType: string;
  /**
   * When this stops being usable. Derived from the API's `expirationTime` when
   * it sends one, else a conservative 47h — the documented TTL is ~48h, and
   * expiring our copy slightly early costs one re-upload, while expiring it
   * late costs a failed generation.
   */
  expiresAtMs: number;
}
