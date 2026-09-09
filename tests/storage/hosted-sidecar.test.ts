import { describe, it, expect } from 'vitest';
import { createR2Sink, type MediaBucket } from '../../src/storage/media.js';

/**
 * The hosted answer to the `<image>.json` sidecar.
 *
 * On disk, `gemini_interact` drops a sidecar next to every image recording the
 * interaction id that produced it. That file is what makes a lost response
 * survivable: the chain can be continued, and a chained 404 can be re-anchored
 * on the image the dead interaction actually made. The hosted deployment had
 * none of it — no filesystem, so no sidecar — and the result was exactly the
 * failure the disk build was hardened against, with the id gone the moment a
 * response was dropped.
 *
 * An object store does not need a filesystem to hold a small JSON record. The
 * sidecar lives beside its media under the same key plus `.json`, so the
 * retention sweep that removes the image removes its record with it, and a
 * listing must not mistake one for the other.
 */

function bucket(): MediaBucket & { objects: Map<string, { bytes: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, options) {
      const view = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      objects.set(key, { bytes: new Uint8Array(view), contentType: options?.httpMetadata?.contentType });
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) as ArrayBuffer,
        httpMetadata: { contentType: hit.contentType },
      };
    },
    async list({ prefix, limit }) {
      const keys = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit ?? 1000).map((key) => ({ key, size: objects.get(key)!.bytes.byteLength })), truncated: false };
    },
  };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sink(b: MediaBucket) {
  return createR2Sink(b, { tenant: 't', publicBaseUrl: 'https://cdn.example' });
}

describe('hosted sidecars', () => {
  it('writes a record beside the media it describes', async () => {
    const b = bucket();
    const s = sink(b);
    const [stored] = await s.persist([{ base: 'poster', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(stored.key!, { interaction_id: 'v1_abc', prompt: 'a red poster', model: 'gemini-3.1-flash-image' });

    const record = JSON.parse(new TextDecoder().decode(b.objects.get(`${stored.key}.json`)!.bytes));
    expect(record).toMatchObject({ interaction_id: 'v1_abc', prompt: 'a red poster', model: 'gemini-3.1-flash-image' });
    expect(typeof record.created).toBe('string');
  });

  it('does not list a sidecar as if it were media', async () => {
    // The record sits under the same prefix as the image. A listing that
    // reported it would offer a JSON blob as a recent generation, and its
    // signed URL as something to look at.
    const b = bucket();
    const s = sink(b);
    const [stored] = await s.persist([{ base: 'poster', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(stored.key!, { interaction_id: 'v1_abc' });

    const listed = await s.listRecent!({ limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe(stored.key);
  });

  it('pairs each listed object with its record', async () => {
    const b = bucket();
    const s = sink(b);
    const [stored] = await s.persist([{ base: 'poster', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(stored.key!, { interaction_id: 'v1_abc', prompt: 'a red poster' });

    const listed = await s.listRecent!({ limit: 10 });
    expect(listed[0].interactionId).toBe('v1_abc');
    expect(listed[0].prompt).toBe('a red poster');
  });

  it('lists media that has no record at all', async () => {
    // Every generation before this shipped has no sidecar, and a sink whose
    // write failed has none either. Recovery is best-effort: a missing record
    // must cost the entry its metadata, never its place in the listing.
    const b = bucket();
    const s = sink(b);
    const [stored] = await s.persist([{ base: 'old', base64: PNG, mimeType: 'image/png' }], {});
    const listed = await s.listRecent!({ limit: 10 });
    expect(listed[0].key).toBe(stored.key);
    expect(listed[0].interactionId).toBeUndefined();
  });

  it('finds the media an interaction produced, which is what re-anchoring needs', async () => {
    const b = bucket();
    const s = sink(b);
    const [first] = await s.persist([{ base: 'one', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(first.key!, { interaction_id: 'v1_one' });
    const [second] = await s.persist([{ base: 'two', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(second.key!, { interaction_id: 'v1_two' });

    expect((await s.findByInteraction!('v1_one'))?.key).toBe(first.key);
    expect((await s.findByInteraction!('v1_two'))?.key).toBe(second.key);
    // Match by id ONLY. Re-anchoring on the wrong picture silently corrupts the
    // edit, so an unknown id has to come back empty rather than newest-wins.
    expect(await s.findByInteraction!('v1_missing')).toBeUndefined();
  });

  it('stops at the first match instead of reading every record', async () => {
    // Each record is its OWN object, so "check them all" is a round trip per
    // item on a tool call. A lookup walks newest-first and stops as soon as it
    // matches, which for a re-anchor is nearly always the previous turn.
    // (`latestInteractionId` is the exception and reads the newest day out:
    // within a day, key order is random, so it has to compare timestamps.)
    const b = bucket();
    const s = sink(b);
    const keys: string[] = [];
    for (const n of ['one', 'two', 'three']) {
      const [stored] = await s.persist([{ base: n, base64: PNG, mimeType: 'image/png' }], {});
      await s.writeSidecar!(stored.key!, { interaction_id: `v1_${n}`, kind: 'image' });
      keys.push(stored.key!);
    }
    let reads = 0;
    const counting = { ...b, get: async (k: string) => { if (k.endsWith('.json')) reads++; return b.get!(k); } };
    const counted = sink(counting);
    // The first entry the walk reaches is a match, so exactly one record is read.
    const first = (await counted.listRecent!({ limit: 1 }))[0];
    reads = 0;
    await counted.findByInteraction!(first.interactionId!);
    expect(reads).toBe(1);
  });

  it('gives up after a bounded number of reads rather than walking everything', async () => {
    const b = bucket();
    const s = sink(b);
    for (let i = 0; i < 60; i++) {
      const [stored] = await s.persist([{ base: `n${i}`, base64: PNG, mimeType: 'image/png' }], {});
      await s.writeSidecar!(stored.key!, { interaction_id: `v1_${i}`, kind: 'image' });
    }
    let reads = 0;
    const counting = { ...b, get: async (k: string) => { if (k.endsWith('.json')) reads++; return b.get!(k); } };
    expect(await sink(counting).findByInteraction!('v1_nope')).toBeUndefined();
    expect(reads).toBeLessThanOrEqual(41); // the budget, not the 60 stored

    // And a HIT reads each record once: the scan hands the one it is holding to
    // the decorator rather than fetching the same object twice. Asked for the
    // first entry the walk reaches, that is exactly one read.
    const s2 = sink(counting);
    const first = (await s2.listRecent!({ limit: 1 }))[0];
    reads = 0;
    expect(await s2.findByInteraction!(first.interactionId!)).toBeDefined();
    expect(reads).toBe(1);
  });

  it('picks the newest record by its timestamp, not by key order', async () => {
    // Keys sort by day, then by a RANDOM id — so within a day, key order is
    // arbitrary. Reading "the newest" off that order hands continue_last a
    // turn from earlier in the session, silently resuming the wrong chain.
    const b = bucket();
    let clock = Date.parse('2026-09-09T10:00:00Z');
    const s = createR2Sink(b, {
      tenant: 't',
      publicBaseUrl: 'https://cdn.example',
      now: () => new Date(clock),
      // Descending ids, so key order is the exact REVERSE of write order.
      randomId: () => `id${String(900 - Math.floor((clock - Date.parse('2026-09-09T10:00:00Z')) / 1000)).padStart(4, '0')}`,
    });
    for (const id of ['v1_first', 'v1_second', 'v1_third']) {
      const [stored] = await s.persist([{ base: id, base64: PNG, mimeType: 'image/png' }], {});
      await s.writeSidecar!(stored.key!, { interaction_id: id, kind: 'image' });
      clock += 60_000;
    }
    expect(await s.latestInteractionId!('image')).toBe('v1_third');
  });

  it('keeps video and music ids out of the image chain', async () => {
    // gemini_interact's continue_last reads this. A chained Lyria call is a
    // documented 400, so handing it a music id turns a convenience into a
    // guaranteed failure — and a video id would resume the wrong medium.
    const b = bucket();
    let clock = Date.parse('2026-09-09T10:00:00Z');
    const s = createR2Sink(b, { tenant: 't', publicBaseUrl: 'https://cdn.example', now: () => new Date(clock) });
    const [img] = await s.persist([{ base: 'poster', base64: PNG, mimeType: 'image/png' }], {});
    await s.writeSidecar!(img.key!, { interaction_id: 'v1_image', kind: 'image' });
    clock += 60_000;
    const [clip] = await s.persist([{ base: 'clip', base64: PNG, mimeType: 'video/mp4' }], {});
    await s.writeSidecar!(clip.key!, { interaction_id: 'v1_video', kind: 'video' });

    expect(await s.latestInteractionId!('image')).toBe('v1_image');
    expect(await s.latestInteractionId!('video')).toBe('v1_video');
  });

  it('answers cleanly on a bucket that cannot list', async () => {
    // A put-only bucket is a supported shape (tests use one). A lookup must
    // come back empty so the caller raises its own actionable error, rather
    // than throwing a TypeError from inside the sink.
    const putOnly = { put: async () => {} } as unknown as MediaBucket;
    const s = createR2Sink(putOnly, { tenant: 't' });
    await expect(s.latestInteractionId!('image')).resolves.toBeUndefined();
    await expect(s.findByInteraction!('v1_x')).resolves.toBeUndefined();
  });

  it('reaches as many generations as it did before records shared the prefix', async () => {
    // Sidecars land in the same listing as their media, so a fixed page budget
    // reaches roughly half as many generations. The budget moved with it —
    // reporting `truncated` sooner would send someone to re-pay for an image
    // that is right there.
    const b = bucket();
    const s = createR2Sink(b, { tenant: 't', publicBaseUrl: 'https://cdn.example' });
    for (let i = 0; i < 60; i++) {
      const [stored] = await s.persist([{ base: `n${String(i).padStart(2, '0')}`, base64: PNG, mimeType: 'image/png' }], {});
      await s.writeSidecar!(stored.key!, { interaction_id: `v1_${i}`, kind: 'image' });
    }
    // A store that hands back 10 objects per page: 120 objects is 12 pages of
    // media+record pairs, past the budget of 10 that covered 100 media alone.
    const paged: MediaBucket = {
      ...b,
      list: async ({ prefix, cursor }) => {
        const keys = [...(b as unknown as { objects: Map<string, unknown> }).objects.keys()]
          .filter((k) => !prefix || k.startsWith(prefix)).sort();
        const start = cursor ? keys.indexOf(cursor) : 0;
        const slice = keys.slice(start, start + 10);
        const next = keys[start + 10];
        return { objects: slice.map((key) => ({ key })), truncated: Boolean(next), cursor: next };
      },
    };
    const page = await createR2Sink(paged, { tenant: 't', publicBaseUrl: 'https://cdn.example' }).listRecentPage!({ limit: 60 });
    expect(page.media).toHaveLength(60);
    expect(page.truncated).toBe(false);
  });

  it('never throws when the store misbehaves — recovery is best-effort', async () => {
    const b = bucket();
    const broken: MediaBucket = { ...b, put: async () => { throw new Error('store down'); } };
    const s = sink(broken);
    await expect(s.writeSidecar!('gen/t/2026-09-09/x.png', { interaction_id: 'v1' })).resolves.toBeUndefined();
  });
});
