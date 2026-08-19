import { randomUUID, createHash } from 'node:crypto';
import { textResult, McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { downloadFilename } from './media-name.js';
import { HEARTBEAT_MS, type JobRecord, type JobStore } from './job-store.js';

/**
 * Job registry backing idempotency (#53) and the async job pattern (#52).
 *
 * In-memory by default — correct for stdio, where the process that starts a
 * generation is the process that finishes it. When a {@link JobStore} is
 * attached (the hosted deployment) each job is ALSO written to durable storage,
 * because there the process does not reliably outlive the work: see the header
 * of `src/job-store.ts` for the machine-lifecycle reason, which is not
 * guessable from this file.
 *
 * Why a registry at all: when an MCP host times out a long generation the
 * server-side call usually finishes anyway, so a blind re-issue would dispatch a
 * second *billable* upstream request. `dispatch` deduplicates identical requests
 * that are still in flight, and — when the caller supplies an `idempotency_key`
 * — returns a recently-completed result instead of regenerating.
 *
 * **Scoping is a security property, not a detail.** This state used to live in
 * module-level Maps. On the hosted connector that is a cross-tenant leak: one
 * child process serves every session of this registration, so every
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
  /**
   * Serializes this job's durable writes. Two writers race for one record — the
   * heartbeat and the settle handler — and the record they write is not
   * commutative: `running` on top of `done` reads as an executor that vanished,
   * turning a successful generation into a reported failure. Chaining makes the
   * order of ISSUE the order of ARRIVAL.
   */
  writeChain?: Promise<unknown>;
}

/** Recently-completed jobs are reusable by key for this long, then evicted. */
const JOB_TTL_MS = 600_000; // 10 min

/**
 * How long a DURABLE record stays reusable by idempotency key.
 *
 * Longer than {@link JOB_TTL_MS} on purpose: the in-memory window is bounded by
 * a process that no longer exists, and the case this covers — a retry after the
 * hosted machine went to sleep — can easily land further out than ten minutes.
 * Still bounded, because a stored record survives for the blob store's ~30-day
 * retention and silently replaying a month-old generation is a wrong answer
 * that looks like a cache hit.
 *
 * 24h is also the longest a signed media link can live here, so a replay inside
 * this window is one whose URLs can still be re-minted from their keys.
 */
const DURABLE_JOB_REUSE_MS = 24 * 60 * 60 * 1000;
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
  // A multi-image set also carries a bundle zip; its link expires like any
  // other and re-signs from its own r2_key. Best-effort, like the rest.
  const bundle = body.bundle as Record<string, unknown> | undefined;
  if (bundle && typeof bundle.r2_key === 'string') {
    try {
      const fresh = await sink.resign!(bundle.r2_key);
      if (fresh) {
        const { expires_at: _staleBundle, ...rest } = bundle;
        body.bundle = {
          ...rest,
          url: fresh.ref,
          ...(fresh.expiresAt ? { expires_at: fresh.expiresAt } : {}),
          curl_hint: `curl -sS -o ${downloadFilename(fresh.key ?? 'media')} "${fresh.ref}"`,
        };
        body.bundle_url = fresh.ref;
      }
    } catch { /* an un-refreshed bundle link is still a valid replay */ }
  }
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
  /**
   * Wait up to this long for the result; if the work is still running when the
   * budget expires, return the `{ job_id, status }` handle instead (the work
   * continues; the caller polls `gemini_get_result`). The middle ground
   * between fully-synchronous (risks the host's tools/call timeout) and
   * `async` (never waits). Ignored when `async` is set.
   */
  waitMs?: number;
}

/** Immediate handle for an async call — the caller polls `gemini_get_result`. */
function jobHandle(jobId: string, status: JobStatus, durable = false): CallToolResult {
  return textResult({
    job_id: jobId,
    status,
    hint: durable
      ? `Generation running in the background. Poll gemini_get_result with job_id "${jobId}" until status is "done". The job record is stored durably, so a poll still works if this connector restarts — but background work is NOT restarted, so a long generation is safer with max_wait_ms than with async.`
      : `Generation running in the background. Poll gemini_get_result with job_id "${jobId}" until status is "done" (results are per-process and expire ~10 min after completion).`,
  });
}

/**
 * Whether a result is worth persisting to the durable store.
 *
 * A hosted result is a small JSON manifest of `r2_key`s, which is exactly what
 * a restart needs — the keys outlive every signed URL and `refreshMedia`
 * re-signs from them. An `inline: true` result is raw base64 image bytes: too
 * big to keep, and pointless to keep, since nothing about it survives usefully.
 * Recording the omission is what lets a poll say *why* rather than reporting a
 * success with nothing in it.
 */
const MAX_PERSISTED_RESULT_BYTES = 64 * 1024;

function persistableResult(result: CallToolResult): { result?: CallToolResult; resultOmitted?: 'inline' | 'too_large' } {
  if ((result.content ?? []).some((block) => block.type !== 'text')) return { resultOmitted: 'inline' };
  try {
    if (JSON.stringify(result).length > MAX_PERSISTED_RESULT_BYTES) return { resultOmitted: 'too_large' };
  } catch {
    return { resultOmitted: 'too_large' };
  }
  return { result };
}

/**
 * Await `promise` for at most `waitMs`; `undefined` means the budget expired
 * with the work still pending (rejections propagate as usual). The timer never
 * holds the process open, and a late rejection after the budget expired is
 * already handled by the registry's own settle handlers.
 */
function awaitWithBudget(promise: Promise<CallToolResult>, waitMs: number): Promise<CallToolResult | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), waitMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
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

  /**
   * Durable backing for this registry, when the deployment has somewhere to put
   * it. Absent on a local stdio install, where the process that starts a
   * generation is the process that finishes it and a `Map` is the whole truth.
   *
   * Present on the hosted connector, where it is load-bearing: see the header of
   * `src/job-store.ts` for why an in-memory-only registry cannot work on a
   * machine that stops whenever no request is in flight.
   */
  store: JobStore | undefined;

  /**
   * When set, `async: true` is served as a bounded in-band wait instead of an
   * immediate hand-off.
   *
   * Set by the hosted client, because there the two are not the trade-off they
   * look like. Returning immediately releases the request, and the released
   * request is the thing keeping the executor alive — so `async: true` is
   * precisely the way to get a generation killed. Waiting holds the machine up
   * until the work is done. If the budget still expires the caller gets the same
   * job handle it asked for, now backed by a durable record.
   */
  asyncWaitFallbackMs: number | undefined;

  /** Injectable clock (tests). */
  now: () => number = () => Date.now();

  private readonly jobs = new Map<string, JobEntry>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey -> jobId
  private readonly runningByFingerprint = new Map<string, string>(); // fingerprint -> jobId (only while running)
  /** Durable bookkeeping still in flight — awaited by `drain()` in tests. */
  private readonly pending = new Set<Promise<unknown>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  /** Drop every job. Used by `SessionState.reset()` (tests) — not by handlers. */
  reset(): void {
    this.jobs.clear();
    this.byKey.clear();
    this.runningByFingerprint.clear();
    this.stopHeartbeat();
  }

  /** Await outstanding durable writes. Tests only — handlers never need it. */
  async drain(): Promise<void> {
    // Yield a macrotask first so a settle handler that has already fired gets
    // its write queued before we look. Deliberately flushes only what is
    // ISSUABLE: a job still running has no terminal write to wait for, and
    // blocking on one would hang any test that drains before finishing a job.
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.pending.size) return;
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * Re-stamp every running job's durable record.
   *
   * This is what separates "still working" from "the machine went away": a
   * reader compares the stamp against `EXECUTOR_LOST_AFTER_MS`, so a 12-scene
   * set that legitimately runs for ten minutes stays `running` while a job whose
   * child was killed goes terminal within three missed beats.
   */
  async beat(): Promise<void> {
    if (!this.store) return;
    await Promise.allSettled(
      [...this.jobs.values()]
        .filter((e) => e.status === 'running')
        // The status is re-read INSIDE the queued task, not sampled here: a job
        // that finishes while this beat waits its turn must not have `running`
        // written back over its terminal record.
        .map((e) => this.writeRecord(e, { onlyWhileRunning: true })),
    );
  }

  /**
   * Queue one durable write for `entry`, after any write already in flight for
   * it. `onlyWhileRunning` drops the write if the job settled in the meantime —
   * which is what makes a late heartbeat a no-op rather than a resurrection.
   */
  private writeRecord(entry: JobEntry, opts: { onlyWhileRunning?: boolean } = {}): Promise<unknown> {
    const next = (entry.writeChain ?? Promise.resolve()).then(async () => {
      if (opts.onlyWhileRunning && entry.status !== 'running') return;
      await this.store!.put(this.recordFor(entry, this.now()));
    }, () => undefined);
    entry.writeChain = next;
    return next;
  }

  private recordFor(entry: JobEntry, updatedAt: number): JobRecord {
    return {
      jobId: entry.jobId,
      toolName: entry.toolName,
      fingerprint: entry.fingerprint,
      ...(entry.idempotencyKey !== undefined ? { idempotencyKey: entry.idempotencyKey } : {}),
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.status === 'done' && entry.result ? persistableResult(entry.result) : {}),
    };
  }

  /** Run `p` as durable bookkeeping: tracked for `drain()`, never thrown from. */
  private track(p: Promise<unknown>): void {
    const wrapped = p.catch(() => undefined).finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.store) return;
    this.heartbeatTimer = setInterval(() => {
      if (![...this.jobs.values()].some((e) => e.status === 'running')) {
        this.stopHeartbeat();
        return;
      }
      this.track(this.beat());
    }, HEARTBEAT_MS);
    // Never hold the process open for bookkeeping.
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
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
    const { toolName, fingerprint, idempotencyKey } = opts;
    // Hosted, an immediate hand-off is what gets the executor reclaimed, so
    // `async` is honoured by HOLDING the request rather than releasing it.
    const degrade = opts.async === true && this.asyncWaitFallbackMs !== undefined;
    const async = degrade ? false : opts.async;
    const waitMs = degrade ? (opts.waitMs ?? this.asyncWaitFallbackMs) : opts.waitMs;
    const now = this.now();

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

    // Nothing in memory, but the key may name a job an earlier child ran. Only
    // an explicit key unlocks this — the same rule the in-memory path uses, so
    // a deliberate same-prompt variation is never silently deduplicated.
    if (!hit && idempotencyKey !== undefined && this.store) {
      const durable = await this.durableByKey(idempotencyKey, fingerprint);
      if (durable) return durable;
    }

    if (hit) {
      if (async) return jobHandle(hit.jobId, hit.status);
      const settled = waitMs !== undefined && hit.status === 'running'
        ? await awaitWithBudget(hit.promise, waitMs)
        : await hit.promise;
      if (settled === undefined) return jobHandle(hit.jobId, 'running');
      // Refresh before annotating: a recorded result can outlive the signed
      // URLs inside it, and replaying an expired link is its own kind of wrong
      // answer — it looks like success.
      return annotateReused(await refreshMedia(settled, this.resigner), hit.jobId);
    }

    const jobId = randomUUID();
    this.evict(now);
    const promise = work();
    const entry: JobEntry = { jobId, toolName, fingerprint, idempotencyKey, status: 'running', promise, createdAt: now };
    this.jobs.set(jobId, entry);
    if (idempotencyKey !== undefined) this.byKey.set(idempotencyKey, jobId);
    this.runningByFingerprint.set(fingerprint, jobId);

    // Write the "running" record BEFORE the work can finish. A record that only
    // appeared on completion would be missing for exactly the window this whole
    // mechanism exists to cover.
    if (this.store) {
      this.track(this.writeRecord(entry));
      if (idempotencyKey !== undefined) this.track(this.store.putKey(idempotencyKey, jobId));
      this.startHeartbeat();
    }

    const settle = promise.then(
      (res) => { entry.status = 'done'; entry.result = res; entry.settledAt = this.now(); },
      (err: unknown) => {
        entry.status = 'failed';
        entry.error = { message: err instanceof Error ? err.message : String(err), hint: (err as { hint?: string })?.hint };
        entry.settledAt = this.now();
      },
    ).finally(() => {
      if (this.runningByFingerprint.get(fingerprint) === jobId) this.runningByFingerprint.delete(fingerprint);
    });
    if (this.store) void settle.then(() => this.track(this.writeRecord(entry)));

    if (async) return jobHandle(jobId, 'running', this.store !== undefined);
    if (waitMs !== undefined) {
      const settled = await awaitWithBudget(promise, waitMs);
      // Budget expired with the work still running: hand back the job id — the
      // work continues and the caller polls, exactly as with `async: true`,
      // except a fast result would have been returned in-band.
      return settled ?? jobHandle(jobId, 'running', this.store !== undefined);
    }
    return promise;
  }

  /**
   * Resolve an idempotency key against the durable store — the path a retry
   * takes when the child that ran the original job is gone.
   *
   * `undefined` means "nothing durable to reuse", which includes a job that
   * FAILED: a retry after an error must really retry. A job still recorded as
   * running belongs to an executor this process cannot await, so the caller gets
   * the handle back rather than a promise that would never settle.
   */
  private async durableByKey(idempotencyKey: string, fingerprint: string): Promise<CallToolResult | undefined> {
    const id = await this.store!.jobIdForKey(idempotencyKey);
    if (!id) return undefined;
    const record = await this.store!.get(id);
    if (!record) return undefined;
    // An idempotency key is a habit as often as it is a promise — "1", "test",
    // "retry". In memory that was survivable because the entry expired in ten
    // minutes; a durable record lives for the store's retention, so replaying
    // on the key ALONE would hand back a different prompt's image, weeks later,
    // and label it a cache hit. The fingerprint is what makes this idempotency
    // rather than a name lookup: same key + different request is a genuinely
    // new generation.
    if (record.fingerprint !== fingerprint) return undefined;
    if (this.now() - record.updatedAt > DURABLE_JOB_REUSE_MS) return undefined;
    if (record.status === 'running') return jobHandle(id, 'running', true);
    if (record.status !== 'done' || !record.result) return undefined;
    return annotateReused(await refreshMedia(record.result, this.resigner), id);
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
  async getResult(jobId: string): Promise<CallToolResult> {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      const durable = this.store ? await this.store.get(jobId) : undefined;
      if (durable) return this.fromRecord(durable);
      throw new McpToolError(
        this.store
          ? `No job "${jobId}" — no record of it exists. Either the id is wrong, or the job is older than the ${JOB_RECORD_RETENTION_LABEL} job records are kept.`
          : `No job "${jobId}" — unknown or expired.`,
        {
          hint: this.store
            ? 'Job records are stored durably here, so a restart alone does not lose one — an id with no record was never started under this account. Images from a completed run are listed by gemini_list_recent_media.'
            : 'Jobs live with your session and are evicted ~10 min after completion (or on server restart). If the generation likely finished, check the output dir / <image>.json sidecar instead of polling.',
        },
      );
    }
    if (entry.status === 'running') return jobHandle(jobId, 'running', this.store !== undefined);
    if (entry.status === 'failed') {
      throw new McpToolError(entry.error?.message ?? 'Job failed.', entry.error?.hint ? { hint: entry.error.hint } : undefined);
    }
    // status === 'done' ⇒ the settle handler recorded a result. The guard is only
    // for the impossible case — and must surface it as an error, not a
    // running-style handle that would tell the caller to keep polling forever.
    if (!entry.result) throw new McpToolError(`Job "${jobId}" completed without a recorded result.`);
    return entry.result;
  }

  /**
   * Render a durable record as a poll answer — the path taken when the child
   * that ran the job is gone.
   *
   * The three outcomes are kept distinct on purpose. Collapsing "your job
   * failed", "your job was killed" and "no such job" into one message is what
   * made the original bug read as an expiry problem when it was a machine
   * lifecycle problem.
   */
  private async fromRecord(record: JobRecord): Promise<CallToolResult> {
    if (record.status === 'running') return jobHandle(record.jobId, 'running', true);
    if (record.status === 'failed') {
      throw new McpToolError(record.error?.message ?? 'Job failed.', record.error?.hint ? { hint: record.error.hint } : undefined);
    }
    if (record.resultOmitted) {
      // Both reasons mean "the generation happened, the payload is not here",
      // but only one of them is the caller's to change.
      throw new McpToolError(
        record.resultOmitted === 'inline'
          ? `Job "${record.jobId}" finished, but its result was returned inline (base64 image data) and inline results are not stored, so there is nothing to replay. Re-run without \`inline: true\` so the media is stored and returned as URLs, which a poll can replay.`
          : `Job "${record.jobId}" finished, but its result was too large to store (over ${Math.round(MAX_PERSISTED_RESULT_BYTES / 1024)} KB), so there is nothing to replay.`,
        {
          hint: 'The generation itself completed — list what it produced with gemini_list_recent_media rather than paying for it again.',
        },
      );
    }
    if (!record.result) throw new McpToolError(`Job "${record.jobId}" completed without a recorded result.`);
    // Re-sign before replaying: the record outlives the signed URLs inside it,
    // and handing back a dead link is a failure that looks like a success.
    return refreshMedia(record.result, this.resigner);
  }
}

/** How long the host keeps a stored object, quoted in the unknown-job message. */
const JOB_RECORD_RETENTION_LABEL = '30 days';
