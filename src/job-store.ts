/**
 * The durable half of the job registry (`src/jobs.ts`).
 *
 * ## Why this exists
 *
 * `JobRegistry` keeps jobs in a `Map`, which is exactly right for stdio: the
 * process that starts a generation is the process that finishes it, and if it
 * dies the user is sitting at a terminal watching it die.
 *
 * Hosted, that premise is false in a specific and non-obvious way. The
 * connector is this same stdio server run as a Node child on an mcp-host Fly
 * machine configured `auto_stop_machines = "stop"` with
 * `min_machines_running = 0`. Fly stops that machine when nothing is in
 * flight — mcp-host's own docs put it plainly: *"an open connection is exactly
 * what stops the machine stopping"*. An `async: true` call is a request that
 * answers in milliseconds, so it holds nothing open. The machine stops, the
 * child is killed, and the generation dies **with the only record that it ever
 * existed**. Polling `gemini_get_result` a couple of minutes later reports the
 * id as unknown, which reads like an expiry bug and is actually a machine that
 * went to sleep.
 *
 * This is also why a long `max_wait_ms` works where `async: true` does not: the
 * wait keeps the HTTP request open, and the open request keeps the machine up.
 *
 * ## What durability can and cannot buy here
 *
 * It buys the RECORD, not the EXECUTION. There is no Workflows, no Queue, no
 * Durable Object and no KV in reach — the child's environment is allowlist-only
 * (mcp-host `spawn-env.ts`), and the only durable thing it can address is the
 * blob store its media already goes to. Nothing here resumes a killed
 * generation; re-running it would re-bill it, which is the cost this whole
 * mechanism exists to avoid.
 *
 * So the contract is: a job never silently vanishes, and a job whose executor
 * died ends in a **terminal** state that says so. The bytes a dead job managed
 * to write are still in `gen/`, which is what `gemini_list_recent_media` is
 * for.
 *
 * ## Liveness is a heartbeat, not a guess
 *
 * "Still running" and "the machine ate it" are indistinguishable from a single
 * stored status, and a timeout long enough to be safe for a 12-scene set is far
 * too long to be useful. So a running job re-stamps `updatedAt` on an interval
 * ({@link HEARTBEAT_MS}), and a record whose stamp is older than
 * {@link EXECUTOR_LOST_AFTER_MS} is read as `failed` — decided at READ time, so
 * no boot scan is needed and a machine that never comes back still resolves its
 * jobs the moment anybody asks.
 *
 * Every operation is best-effort and swallows its errors. A durable store that
 * is down must degrade to the in-memory behaviour that came before it, never
 * fail a generation the user is paying for.
 */

import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** How often a running job re-stamps its record so a reader can see it is alive. */
export const HEARTBEAT_MS = 60_000;

/**
 * How stale a `running` record may get before its executor is presumed dead.
 *
 * Three missed heartbeats: long enough that a paused event loop mid-generation
 * is not mistaken for a dead machine, short enough that a caller learns the
 * truth in minutes rather than being told to keep polling forever.
 */
export const EXECUTOR_LOST_AFTER_MS = 3 * HEARTBEAT_MS;

/** Where a job record lives, relative to the store root. */
const PREFIX = 'jobs';

export type JobRecordStatus = 'running' | 'done' | 'failed';

/**
 * One job, as it survives the process that ran it.
 *
 * `result` is the recorded `CallToolResult` — for hosted generations that is a
 * manifest of `r2_key`s, which is small and, crucially, still resolvable after
 * a restart (`refreshMedia` re-signs from the key). An INLINE result is base64
 * image bytes and is deliberately not persisted; `resultOmitted` records that
 * choice so a reader can say why rather than reporting an empty success.
 */
export interface JobRecord {
  jobId: string;
  toolName: string;
  fingerprint: string;
  idempotencyKey?: string;
  status: JobRecordStatus;
  createdAt: number;
  updatedAt: number;
  error?: { message: string; hint?: string };
  result?: CallToolResult;
  /**
   * Why the result was not stored, when it was not. The two reasons need
   * different remediation — "re-run without inline: true" is unactionable
   * advice for a caller who never passed it — so the reason is recorded rather
   * than inferred at read time.
   */
  resultOmitted?: 'inline' | 'too_large';
}

/**
 * The slice of the blob bucket this module needs, kept structural so it can be
 * satisfied by `createBlobBucket` without importing it (and faked in tests).
 */
export interface JobStoreBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface JobStore {
  /** Write (or overwrite) a job record. Best-effort; never throws. */
  put(record: JobRecord): Promise<void>;
  /**
   * Read a job record, applying the executor-lost rule. `undefined` for an
   * absent, unreadable or malformed record — all of which mean "we have nothing
   * durable to say about this id".
   */
  get(jobId: string): Promise<JobRecord | undefined>;
  /** Point an idempotency key at a job id. Best-effort; never throws. */
  putKey(idempotencyKey: string, jobId: string): Promise<void>;
  /** Resolve an idempotency key to a job id, if one was ever recorded. */
  jobIdForKey(idempotencyKey: string): Promise<string | undefined>;
}

export interface JobStoreOptions {
  /**
   * Account namespace — a string, or a thunk when it resolves per request. May
   * be async: the hosted tenant id is a SHA-256 of the session's API key, and
   * the key is read at request time rather than at construction.
   */
  tenant: string | (() => string | Promise<string>);
  now?: () => number;
}

/**
 * An idempotency key is an arbitrary caller-supplied string: it can contain
 * slashes, spaces, or `..`. Hashing it makes the key space closed by
 * construction rather than by escaping, so no crafted key can address an object
 * outside this tenant's prefix.
 */
function keyHash(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

/** Job records over the mcp-host blob store. */
export function createBlobJobStore(bucket: JobStoreBucket, opts: JobStoreOptions): JobStore {
  const now = opts.now ?? (() => Date.now());
  const tenantOf = async () => (typeof opts.tenant === 'function' ? opts.tenant() : opts.tenant);
  const recordKey = async (jobId: string) => `${PREFIX}/${await tenantOf()}/${encodeURIComponent(jobId)}.json`;
  const pointerKey = async (k: string) => `${PREFIX}/${await tenantOf()}/keys/${keyHash(k)}.json`;

  async function writeJson(key: string, value: unknown): Promise<void> {
    try {
      await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
    } catch {
      // A durable write that fails leaves the in-memory registry exactly as
      // capable as it was before this module existed. Failing the generation
      // instead would trade a recoverable gap for a lost paid result.
    }
  }

  async function readJson<T>(key: string): Promise<T | undefined> {
    try {
      const obj = await bucket.get(key);
      if (!obj) return undefined;
      return JSON.parse(new TextDecoder().decode(await obj.arrayBuffer())) as T;
    } catch {
      return undefined;
    }
  }

  return {
    async put(record) {
      await writeJson(await recordKey(record.jobId), record);
    },

    async get(jobId) {
      const record = await readJson<JobRecord>(await recordKey(jobId));
      if (!record || typeof record.status !== 'string') return undefined;
      if (record.status !== 'running') return record;
      if (now() - record.updatedAt <= EXECUTOR_LOST_AFTER_MS) return record;
      // Terminal, and honest about which kind of gone it is. Derived on read
      // rather than persisted: the process that could have written the
      // transition is by definition the one that is no longer there.
      return {
        ...record,
        status: 'failed',
        error: {
          message:
            `Job "${jobId}" was lost: its executor stopped reporting ${Math.round((now() - record.updatedAt) / 1000)}s ` +
            `ago, before the generation finished. This connector runs on a machine that stops when no request is ` +
            `in flight, so background work started with \`async: true\` does not reliably survive.`,
          hint:
            'Re-run with `max_wait_ms` (e.g. 240000) instead of `async: true` — holding the request open keeps the ' +
            'executor alive. Any images the lost run did finish are still stored: list them with ' +
            'gemini_list_recent_media before paying for a regeneration.',
        },
      };
    },

    async putKey(idempotencyKey, jobId) {
      await writeJson(await pointerKey(idempotencyKey), { jobId });
    },

    async jobIdForKey(idempotencyKey) {
      const pointer = await readJson<{ jobId?: string }>(await pointerKey(idempotencyKey));
      return typeof pointer?.jobId === 'string' ? pointer.jobId : undefined;
    },
  };
}
