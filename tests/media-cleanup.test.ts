import { describe, it, expect, vi } from 'vitest';
import { cleanupExpiredMedia, retentionMsFromDays, type CleanupBucket } from '../src/media-cleanup.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-29T12:00:00Z');

function fakeBucket(objects: Array<{ key: string; ageDays: number }>, pageSize = 1000): CleanupBucket & { deleted: string[] } {
  const all = objects.map((o) => ({ key: o.key, uploaded: new Date(NOW - o.ageDays * DAY) }));
  const deleted: string[] = [];
  return {
    deleted,
    async list({ cursor, limit }) {
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(start + Math.min(limit ?? pageSize, pageSize), all.length);
      return { objects: all.slice(start, end), truncated: end < all.length, cursor: String(end) };
    },
    async delete(keys) {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
}

describe('retentionMsFromDays', () => {
  it('defaults to 7 days for anything missing or nonsensical', () => {
    for (const bad of [undefined, '', 'soon', '0', '-3']) {
      expect(retentionMsFromDays(bad)).toBe(7 * DAY);
    }
  });

  it('honours a configured value', () => {
    expect(retentionMsFromDays('2')).toBe(2 * DAY);
    expect(retentionMsFromDays(30)).toBe(30 * DAY);
  });
});

describe('cleanupExpiredMedia', () => {
  it('deletes only objects older than the retention window', async () => {
    const bucket = fakeBucket([
      { key: 'gen/old-1.png', ageDays: 30 },
      { key: 'gen/fresh.png', ageDays: 1 },
      { key: 'gen/old-2.png', ageDays: 8 },
      { key: 'gen/edge.png', ageDays: 6.9 },
    ]);
    const result = await cleanupExpiredMedia(bucket, 7 * DAY, { now: () => NOW });

    expect(bucket.deleted.sort()).toEqual(['gen/old-1.png', 'gen/old-2.png']);
    expect(result).toEqual({ scanned: 4, deleted: 2, truncated: false });
  });

  it('deletes nothing when everything is fresh', async () => {
    const bucket = fakeBucket([{ key: 'gen/a.png', ageDays: 0 }, { key: 'gen/b.png', ageDays: 3 }]);
    const result = await cleanupExpiredMedia(bucket, 7 * DAY, { now: () => NOW });

    expect(bucket.deleted).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  it('pages through a truncated listing', async () => {
    const bucket = fakeBucket(
      Array.from({ length: 25 }, (_, i) => ({ key: `gen/old-${i}.png`, ageDays: 10 })),
      10,
    );
    const result = await cleanupExpiredMedia(bucket, 7 * DAY, { now: () => NOW });

    expect(result.scanned).toBe(25);
    expect(bucket.deleted).toHaveLength(25);
  });

  it('stops at maxObjects and says so, rather than blowing the subrequest budget', async () => {
    const bucket = fakeBucket(
      Array.from({ length: 100 }, (_, i) => ({ key: `gen/old-${i}.png`, ageDays: 10 })),
      10,
    );
    const result = await cleanupExpiredMedia(bucket, 7 * DAY, { now: () => NOW, maxObjects: 30 });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBeLessThanOrEqual(30);
    // What it did find, it deleted — the remainder waits for the next run.
    expect(bucket.deleted).toHaveLength(result.deleted);
  });

  it('scopes the sweep to the generated-media prefix', async () => {
    const list = vi.fn(async () => ({ objects: [], truncated: false, cursor: undefined }));
    await cleanupExpiredMedia({ list, delete: async () => {} } as unknown as CleanupBucket, 7 * DAY, { now: () => NOW });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'gen/' }));
  });
});
