import { describe, expect, it } from 'vitest';
import { createR2Sink, type MediaBucket } from '../../src/storage/media.js';

/**
 * Orphan recovery.
 *
 * When a background job dies with its machine, the bytes it managed to write
 * are still in `gen/` — they were paid for, and until now there was no way to
 * see them. Every ref the caller ever held was a signed URL inside a result
 * that got lost with the job, so a finished-but-unreachable image was
 * indistinguishable from one that never existed, and the only recourse was to
 * pay for the generation a second time.
 *
 * The object keys carry the date (`gen/<tenant>/YYYY-MM-DD/<id>-<base>.png`),
 * so "what did I generate recently" is answerable from a listing alone — no
 * extra index to keep in step, and it works for media written by a process that
 * is long gone.
 */

function fakeBucket(keys: string[]): MediaBucket & { listed: Array<{ prefix?: string }> } {
  const listed: Array<{ prefix?: string }> = [];
  return {
    listed,
    async put() {
      return undefined;
    },
    async get() {
      return { arrayBuffer: async () => new ArrayBuffer(0) };
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string }) {
      listed.push({ prefix: options.prefix });
      return {
        objects: keys.filter((k) => !options.prefix || k.startsWith(options.prefix)).map((key) => ({ key, size: 1024 })),
        truncated: false,
      };
    },
  } as MediaBucket & { listed: Array<{ prefix?: string }> };
}

const TENANT = 'a632ccd72524';
const KEYS = [
  `gen/${TENANT}/2026-08-17/aaaa1111-old-thing.png`,
  `gen/${TENANT}/2026-08-18/bbbb2222-summer-camp-adventure.png`,
  `gen/${TENANT}/2026-08-19/cccc3333-summer-camp-adventure-2.png`,
  'gen/ffffffffffff/2026-08-19/dddd4444-someone-elses.png',
];

function sink(keys = KEYS) {
  const bucket = fakeBucket(keys);
  return {
    bucket,
    sink: createR2Sink(bucket, {
      links: { base: 'https://host/b/reg', media: (key, exp, sig) => `https://host/b/reg/${key}?exp=${exp}&sig=${sig}`, upload: () => '' },
      sign: async () => 'SIG',
      urlTtlMs: 3600_000,
      tenant: TENANT,
      now: () => new Date('2026-08-19T12:00:00Z'),
    }),
  };
}

describe('listRecent', () => {
  it('lists this account\'s generated media, newest first', async () => {
    const { sink: s } = sink();
    const found = await s.listRecent!({ limit: 10 });
    expect(found.map((f) => f.name)).toEqual([
      'summer-camp-adventure-2',
      'summer-camp-adventure',
      'old-thing',
    ]);
    expect(found[0].day).toBe('2026-08-19');
  });

  it('never lists another account\'s objects', async () => {
    const { sink: s, bucket } = sink();
    const found = await s.listRecent!({ limit: 10 });
    expect(found.some((f) => f.key.includes('ffffffffffff'))).toBe(false);
    // And it asks the store only for its own prefix, rather than filtering
    // someone else's keys after the fact.
    expect(bucket.listed[0]?.prefix).toBe(`gen/${TENANT}/`);
  });

  it('hands back a fetchable URL, not a bare key — a recovered image must be openable', async () => {
    const { sink: s } = sink();
    const [newest] = await s.listRecent!({ limit: 1 });
    expect(newest.url).toMatch(/^https:\/\/host\/b\/reg\/gen\//);
    expect(newest.url).toContain('sig=SIG');
  });

  it('honours the limit', async () => {
    const { sink: s } = sink();
    expect(await s.listRecent!({ limit: 2 })).toHaveLength(2);
  });

  it('filters to a day window when asked', async () => {
    const { sink: s } = sink();
    const found = await s.listRecent!({ limit: 10, sinceDay: '2026-08-18' });
    expect(found.map((f) => f.day)).toEqual(['2026-08-19', '2026-08-18']);
  });

  it('skips keys that do not carry a parseable day rather than throwing', async () => {
    const { sink: s } = sink([`gen/${TENANT}/not-a-date/x.png`, `gen/${TENANT}/2026-08-19/ok.png`]);
    const found = await s.listRecent!({ limit: 10 });
    expect(found.map((f) => f.name)).toEqual(['ok']);
  });

  it('is absent on the disk sink, where local paths are the recovery path', async () => {
    const { createDiskSink } = await import('../../src/storage/media.js');
    expect(createDiskSink().listRecent).toBeUndefined();
  });
});

describe('listRecent is honest about incomplete coverage', () => {
  /**
   * "No silent caps." The walk is bounded, so on a large bucket the listing is
   * a subset — and a subset presented as "newest first" reads as the complete
   * picture. That is the exact failure mode this tool exists to prevent: a
   * caller concluding their image is gone and paying to make it again.
   */
  function pagedBucket(pages: number) {
    let served = 0;
    return {
      async put() { return undefined; },
      async get() { return { arrayBuffer: async () => new ArrayBuffer(0) }; },
      async list() {
        served += 1;
        return {
          objects: [{ key: `gen/${TENANT}/2026-08-1${served % 10}/${served}-thing.png`, size: 1 }],
          truncated: served < pages,
          cursor: `c${served}`,
        };
      },
    } as never;
  }

  function pagedSink(pages: number) {
    return createR2Sink(pagedBucket(pages), {
      links: { base: 'https://host/b/reg', media: (k, e, s) => `https://host/b/reg/${k}?exp=${e}&sig=${s}`, upload: () => '' },
      sign: async () => 'SIG',
      urlTtlMs: 3600_000,
      tenant: TENANT,
      now: () => new Date('2026-08-19T12:00:00Z'),
    });
  }

  it('reports complete coverage when the walk reached the end', async () => {
    expect((await pagedSink(3).listRecentPage!({ limit: 50 })).truncated).toBe(false);
  });

  it('reports truncation when the page budget ran out first', async () => {
    expect((await pagedSink(500).listRecentPage!({ limit: 50 })).truncated).toBe(true);
  });
});
