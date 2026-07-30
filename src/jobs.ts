import { randomUUID, createHash } from 'node:crypto';
import { textResult, McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { downloadFilename } from './media-endpoint.js';

/**
 * In-memory job registry backing idempotency (#53) and the async job pattern
 * (#52). Nothing is persisted; a restart forgets all jobs.
 *
 * Why a registry at all: when an MCP host times out a long generation the
 * server-side call usually finishes anyway, so a blind re-issue would dispatch a
 * second *billable* upstream request. `dispatch` deduplicates identical requests
 * that are still in flight, and — when the caller supplies an `idempotency_key`
 * — returns a recently-completed result instead of regenerating.
 *
 * **Scoping is a security property, not a detail.** This state used to live in
 * module-level Maps. On the hosted connector that is a cross-tenant leak: one
 * Cloudflare isolate is shared by many Durable Object instances, so every
 * authenticated session saw the same registry. Because the idempotency lookup
 * keys on the caller-supplied string alone, user B calling any generation tool
 * with a colliding `idempotency_key` — "1", "test", "retry" — was handed user
 * A's recorded result verbatim: A's media refs, A's interaction id, A's
 * prompt-derived meta. The keyless in-flight path leaked the same way via
 * `fingerprintRequest` (which excludes the seed, the output path and the API
 * key), silently billing B's generation to A.
 *
 * So a registry is now an INSTANCE, owned by one `SessionState`, owned by one
 * `GeminiClient` — and the connector builds one client per authenticated
 * session. Never reintroduce module-level mutable state here. The stdio server
 * is single-user, so its one singleton client is correctly its one session.
 * Covered by tests/session-isolation.test.ts.
 */

type JobStatus = 'running' | 'done' | 'failed';

interface JobEntry {
  jobId: string;
  toolName: string;
  fingerprint: string;
  idempotencyKey?: string;
  status: JobStatus;
  promise: Promise<CallToolResult>;
  result?: CallToolResult; // set on 'done' — replayed by getJobResult
  error?: { message: string; hint?: string }; // set on 'failed'
  createdAt: number;
  settledAt?: number;
}

/** Recently-completed jobs are reusable by key for this long, then evicted. */
const JOB_TTL_MS = 600_000; // 10 min
/** Hard cap on retained entries (oldest-settled evicted first). */
const JOB_MAX = 64;

function isExpired(entry: JobEntry, now: number): boolean {
  return entry.settledAt !== undefined && now - entry.settledAt > JOB_TTL_MS;
}

/**
 * A stable hash of a request's identity, namespaced by tool. Callers pass the
 * fields that make two calls "the same generation" — resolved model, prompt,
 * image params, input digests, etc. — but MUST exclude the server-picked seed
 * and output path, so a blind re-issue of the same args hashes identically.
 *
 * The separator is NUL, which cannot occur in a tool name, so no crafted name
 * can straddle the boundary and collide with another tool's fingerprint. Keep
 * it written as the \u0000 ESCAPE, never a literal NUL byte: a literal one
 * makes git classify this whole file as binary and stop diffing it, which is
 * how it originally landed here unreviewed.
 */
export function fingerprintRequest(toolName: string, parts: unknown): string {
  return createHash('sha256').update(`${toolName}\u0000${JSON.stringify(parts)}`).digest('hex');
}

/**
 * Re-mint any media URLs a recorded result carries, before it is replayed.
 *
 * A recorded result can outlive the signed URLs inside it — and after a change
 * to the result shape it can even carry the OLD shape entirely. Either way the
 * caller gets something that looks right and does not work. Re-signing from the
 * `r2_key`, which is stable, fixes both: an expired link becomes a live one,
 * and a legacy entry gains the `url`/`curl_hint` fields the current shape has.
 *
 * Best-effort by design. A replay that cannot be refreshed is still a valid
 * replay — the point of idempotency is not billing twice, and failing here
 * would trade a stale URL for no result at all.
 */
async function refreshMedia(result: CallToolResult, sink: MediaResigner | undefined): Promise<CallToolResult> {
  const first = result.content?.[0];
  if (!sink?.resign || !first || first.type !== 'text') return result;
  let body: Record<string, unknown>;
  try { body = JSON.parse(first.text) as Record<string, unknown>; } catch { return result; }

  const entries = Array.isArray(body.media) ? (body.media as Array<Record<string, unknown>>) : [];
  if (!entries.some((e) => typeof e.r2_key === 'string')) return result;

  // Per ENTRY, not per key: filtering first would shift every assignment after
  // an entry without an r2_key and truncate the flat list below.
  const refreshed = await Promise.all(entries.map(async (e) => {
    if (typeof e.r2_key !== 'string') return undefined;
    try { return await sink.resign!(e.r2_key); } catch { return undefined; }
  }));
  if (refreshed.every((r) => r === undefined)) return result;

  const mediaKeyName = ['images', 'videos', 'audios'].find((k) => Array.isArray(body[k]));
  const refs: string[] = [];
  refreshed.forEach((fresh, i) => {
    if (!fresh) { refs.push(String(entries[i]?.url ?? '')); return; }
    // Drop the recorded expiry rather than carrying it over: a re-signed URL
    // has its own deadline (or none, on a public-bucket sink), and the old one
    // would mislabel a live link as expired.
    const { expires_at: _stale, ...rest } = entries[i];
    entries[i] = {
      ...rest,
      url: fresh.ref,
      ...(fresh.expiresAt ? { expires_at: fresh.expiresAt } : {}),
      curl_hint: `curl -sS -o ${downloadFilename(fresh.key ?? 'media')} "${fresh.ref}"`,
    };
    refs.push(fresh.ref);
  });
  body.media = entries;
  if (mediaKeyName) body[mediaKeyName] = refs;
  body.media_urls_refreshed = true;
  return { ...result, content: [{ ...first, text: JSON.stringify(body, null, 2) }, ...(result.content ?? []).slice(1)] };
}

/** The slice of a MediaSink this module needs, kept structural to avoid a cycle. */
export interface MediaResigner {
  resign?(key: string): Promise<{ ref: string; key?: string; expiresAt?: string } | undefined>;
}

/** Clone `result`, adding `reused: true` + `reused_job_id` to its meta block. */
function annotateReused(result: CallToolResult, jobId: string): CallToolResult {
  const content = result.content ?? [];
  const first = content[0];
  if (first && first.type === 'text') {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(first.text); } catch { obj = {}; }
    obj.reused = true;
    obj.reused_job_id = jobId;
    return { ...result, content: [{ ...first, text: JSON.stringify(obj, null, 2) }, ...content.slice(1)] };
  }
  // No text meta block (e.g. inline mode with empty meta) — prepend one.
  return {
    ...result,
    content: [{ type: 'text', text: JSON.stringify({ reused: true, reused_job_id: jobId }, null, 2) }, ...content],
  };
}

export interface DispatchOpts {
  toolName: string;
  fingerprint: string;
  /** When set, unlocks reuse of a recently-*completed* job (not just in-flight). */
  idempotencyKey?: string;
  /** Return a `{ job_id, status }` handle immediately instead of awaiting work. */
  async?: boolean;
}

/** Immediate handle for an async call — the caller polls `gemini_get_result`. */
function jobHandle(jobId: string, status: JobStatus): CallToolResult {
  return textResult({
    job_id: jobId,
    status,
    hint: `Generation running in the background. Poll gemini_get_result with job_id "${jobId}" until status is "done" (results are per-process and expire ~10 min after completion).`,
  });
}

/**
 * One session's jobs. Construct one per session and never share it — see the
 * cross-tenant note at the top of this file. Reachable as
 * `client.session.jobs`.
 */
export class JobRegistry {
  /**
   * Lets a replayed result have its media URLs re-minted. Set by the session
   * that owns this registry; absent on stdio, where refs are file paths that
   * never expire.
   */
  resigner: MediaResigner | undefined;

  private readonly jobs = new Map<string, JobEntry>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey -> jobId
  private readonly runningByFingerprint = new Map<string, string>(); // fingerprint -> jobId (only while running)

  /** Drop every job. Used by `SessionState.reset()` (tests) — not by handlers. */
  reset(): void {
    this.jobs.clear();
    this.byKey.clear();
    this.runningByFingerprint.clear();
  }

  /** Drop expired entries, then enforce JOB_MAX by evicting oldest-settled first. */
  private evict(now: number): void {
    for (const [id, entry] of this.jobs) {
      if (isExpired(entry, now)) this.remove(id, entry);
    }
    if (this.jobs.size < JOB_MAX) return;
    const settled = [...this.jobs.values()]
      .filter((e) => e.settledAt !== undefined)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    for (const e of settled) {
      if (this.jobs.size < JOB_MAX) break;
      this.remove(e.jobId, e);
    }
  }

  private remove(id: string, entry: JobEntry): void {
    this.jobs.delete(id);
    if (entry.idempotencyKey !== undefined && this.byKey.get(entry.idempotencyKey) === id) this.byKey.delete(entry.idempotencyKey);
    if (this.runningByFingerprint.get(entry.fingerprint) === id) this.runningByFingerprint.delete(entry.fingerprint);
  }

  /**
   * Run `work` under the registry, deduplicating where safe:
   * - with an `idempotencyKey`: attach to a matching `running` OR recently-`done`
   *   job (not `failed`, not expired);
   * - without a key: attach only to a matching **in-flight** job by fingerprint
   *   (two truly-simultaneous identical requests are a timeout-retry race, never
   *   an intentional variation).
   * On a dedup hit the shared result is returned with `reused: true`. When
   * `async` is set, a `{ job_id, status }` handle is returned immediately (no
   * await) and the caller retrieves the result via `getResult`. Otherwise a
   * new job runs synchronously and failures propagate to the caller as before.
   *
   * Both dedup paths are scoped to THIS registry, i.e. to one session — a
   * colliding `idempotency_key` or an identical prompt from another user is a
   * different registry and therefore a genuinely separate generation.
   */
  async dispatch(opts: DispatchOpts, work: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const { toolName, fingerprint, idempotencyKey, async } = opts;
    const now = Date.now();

    let hit: JobEntry | undefined;
    if (idempotencyKey !== undefined) {
      const id = this.byKey.get(idempotencyKey);
      const entry = id ? this.jobs.get(id) : undefined;
      if (entry && entry.status !== 'failed' && !isExpired(entry, now)) hit = entry;
    } else {
      const id = this.runningByFingerprint.get(fingerprint);
      const entry = id ? this.jobs.get(id) : undefined;
      if (entry && entry.status === 'running') hit = entry;
    }
    if (hit) {
      if (async) return jobHandle(hit.jobId, hit.status);
      // Refresh before annotating: a recorded result can outlive the signed
      // URLs inside it, and replaying an expired link is its own kind of wrong
      // answer — it looks like success.
      return annotateReused(await refreshMedia(await hit.promise, this.resigner), hit.jobId);
    }

    const jobId = randomUUID();
    this.evict(now);
    const promise = work();
    const entry: JobEntry = { jobId, toolName, fingerprint, idempotencyKey, status: 'running', promise, createdAt: now };
    this.jobs.set(jobId, entry);
    if (idempotencyKey !== undefined) this.byKey.set(idempotencyKey, jobId);
    this.runningByFingerprint.set(fingerprint, jobId);
    promise.then(
      (res) => { entry.status = 'done'; entry.result = res; entry.settledAt = Date.now(); },
      (err: unknown) => {
        entry.status = 'failed';
        entry.error = { message: err instanceof Error ? err.message : String(err), hint: (err as { hint?: string })?.hint };
        entry.settledAt = Date.now();
      },
    ).finally(() => {
      if (this.runningByFingerprint.get(fingerprint) === jobId) this.runningByFingerprint.delete(fingerprint);
    });
    if (async) return jobHandle(jobId, 'running');
    return promise;
  }

  /**
   * Retrieve an async job by id (backs the `gemini_get_result` tool):
   * `running` → a status handle; `done` → the recorded result payload;
   * `failed` → the recorded error; unknown/expired → an actionable error.
   *
   * A job id from ANOTHER session is simply not in this registry, so it takes
   * the unknown-id path — the poll tool cannot be used to read another user's
   * result even if they know the uuid.
   */
  getResult(jobId: string): CallToolResult {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      throw new McpToolError(`No job "${jobId}" — unknown or expired.`, {
        hint: 'Jobs live with your session and are evicted ~10 min after completion (or on server restart). If the generation likely finished, check the output dir / <image>.json sidecar instead of polling.',
      });
    }
    if (entry.status === 'running') return jobHandle(jobId, 'running');
    if (entry.status === 'failed') {
      throw new McpToolError(entry.error?.message ?? 'Job failed.', entry.error?.hint ? { hint: entry.error.hint } : undefined);
    }
    // status === 'done' ⇒ the settle handler recorded a result. The guard is only
    // for the impossible case — and must surface it as an error, not a
    // running-style handle that would tell the caller to keep polling forever.
    if (!entry.result) throw new McpToolError(`Job "${jobId}" completed without a recorded result.`);
    return entry.result;
  }
}
