/**
 * Retention for generated media.
 *
 * Every hosted generation writes an object to R2 and nothing ever removed it,
 * so the bucket grew without bound — and the signed links pointing into it are
 * only useful for a couple of days anyway. A scheduled sweep keeps the two in
 * step: objects live `MEDIA_TTL_DAYS` (default 7), and a signed URL's lifetime
 * is clamped to that, so a link never outlives the object behind it.
 *
 * R2 lifecycle rules would be the cheaper mechanism, but they are configured on
 * the bucket rather than in `wrangler.jsonc`, so a fresh deploy of this repo
 * would silently have no retention at all. A cron in the Worker ships with the
 * code.
 */

/** The slice of R2 the sweep needs — structural so tests can fake it. */
export interface CleanupBucket {
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface CleanupOptions {
  prefix?: string;
  now?: () => number;
  /**
   * Cap on objects examined per run, so one invocation cannot exceed the
   * Worker's subrequest budget on a very large bucket. Whatever is missed is
   * picked up by the next run rather than failing this one.
   */
  maxObjects?: number;
}

export interface CleanupResult {
  scanned: number;
  deleted: number;
  /** True when the cap stopped the sweep early — the rest waits for next time. */
  truncated: boolean;
}

const DEFAULT_MAX_OBJECTS = 5_000;
/** R2 accepts bulk deletes in batches; 1000 is the documented ceiling. */
const DELETE_BATCH = 1_000;

/** Days → ms, defaulting to 7 for anything missing or nonsensical. */
export function retentionMsFromDays(days: string | number | undefined): number {
  const n = Number(days);
  return (Number.isFinite(n) && n > 0 ? n : 7) * 24 * 60 * 60 * 1000;
}

/**
 * Delete generated media older than `retentionMs`. Returns counts rather than
 * logging them, so the caller decides what to do with the numbers and the sweep
 * itself stays testable.
 */
export async function cleanupExpiredMedia(
  bucket: CleanupBucket,
  retentionMs: number,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const now = opts.now?.() ?? Date.now();
  const cutoff = now - retentionMs;
  const maxObjects = opts.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const prefix = opts.prefix ?? 'gen/';

  let cursor: string | undefined;
  let scanned = 0;
  let deleted = 0;
  const doomed: string[] = [];

  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: Math.min(1000, maxObjects - scanned) });
    for (const object of page.objects) {
      scanned++;
      if (object.uploaded.getTime() < cutoff) doomed.push(object.key);
    }
    while (doomed.length >= DELETE_BATCH) {
      const batch = doomed.splice(0, DELETE_BATCH);
      await bucket.delete(batch);
      deleted += batch.length;
    }
    if (!page.truncated || scanned >= maxObjects) {
      if (doomed.length > 0) {
        await bucket.delete(doomed);
        deleted += doomed.length;
      }
      return { scanned, deleted, truncated: page.truncated && scanned >= maxObjects };
    }
    cursor = page.cursor;
  }
}
