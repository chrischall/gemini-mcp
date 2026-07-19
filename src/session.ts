import { JobRegistry } from './jobs.js';

/**
 * Everything the server remembers *between tool calls on behalf of one user*.
 *
 * All of this used to be module-level (`jobs`/`byKey`/`runningByFingerprint` in
 * jobs.ts, `lastInteractionId`/`writtenOutputs` in tools/interact.ts). That is
 * correct for stdio, where a process serves exactly one user — and a
 * cross-tenant leak on the hosted connector, where Cloudflare shares ONE Worker
 * isolate across many Durable Object instances. Module state there is shared by
 * every authenticated claude.ai session in the isolate: the per-session
 * `GeminiClient` isolated the API key but not the memory around it, so a
 * colliding `idempotency_key` replayed another user's result, an identical
 * prompt attached to another user's in-flight (billable) job, and
 * `continue_last: true` resumed another user's interaction under your key.
 *
 * So session memory hangs off the `GeminiClient` — the one object the connector
 * already builds per authenticated session (`buildClient` in src/worker.ts) and
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

  /** Forget everything. Tests use this; nothing in `src/` calls it. */
  reset(): void {
    this.jobs.reset();
    this.lastInteractionId = undefined;
    this.lastMusicInteractionId = undefined;
    this.lastVideoInteractionId = undefined;
    this.writtenOutputs.clear();
  }
}
