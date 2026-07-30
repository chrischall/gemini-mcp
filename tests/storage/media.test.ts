import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createDiskSink, createR2Sink, type MediaBucket, type MediaItem } from '../../src/storage/media.js';

/** Sinks return PersistedMedia records; most assertions here only want the ref. */
function toRefs(persisted: Array<{ ref: string }>): string[] {
  return persisted.map((p) => p.ref);
}


const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

function item(base: string, mimeType = 'image/png', base64 = PNG_B64): MediaItem {
  return { base, base64, mimeType };
}

describe('createDiskSink', () => {
  let dir: string;
  const savedOutputDir = process.env.GEMINI_OUTPUT_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gemini-sink-'));
  });
  afterEach(() => {
    if (savedOutputDir === undefined) delete process.env.GEMINI_OUTPUT_DIR;
    else process.env.GEMINI_OUTPUT_DIR = savedOutputDir;
  });

  it('reports a filesystem-backed runtime', () => {
    expect(createDiskSink().persistsFiles).toBe(true);
    expect(createDiskSink().kind).toBe('disk');
  });

  it('writes bytes to the per-call output_dir and returns ABSOLUTE paths', async () => {
    const refs = toRefs(await createDiskSink().persist([item('hello')], { output_dir: dir }));
    expect(refs).toHaveLength(1);
    expect(isAbsolute(refs[0])).toBe(true);
    expect(refs[0]).toBe(join(dir, 'hello.png'));
    expect(await readFile(refs[0])).toEqual(Buffer.from(PNG_B64, 'base64'));
  });

  it('picks the extension from the MIME type', async () => {
    const refs = toRefs(await createDiskSink().persist(
      [item('clip', 'video/mp4'), item('track', 'audio/mpeg'), item('shot', 'image/jpeg')],
      { output_dir: dir },
    ));
    expect(refs.map((r) => r.split('/').pop())).toEqual(['clip.mp4', 'track.mp3', 'shot.jpg']);
  });

  it('de-duplicates colliding names exactly as writeMedia does (name, name-2, name-3)', async () => {
    const sink = createDiskSink();
    await sink.persist([item('dup')], { output_dir: dir });
    await sink.persist([item('dup')], { output_dir: dir });
    await sink.persist([item('dup')], { output_dir: dir });
    expect((await readdir(dir)).sort()).toEqual(['dup-2.png', 'dup-3.png', 'dup.png']);
  });

  it('falls back to $GEMINI_OUTPUT_DIR when no per-call dir is given', async () => {
    process.env.GEMINI_OUTPUT_DIR = dir;
    const refs = toRefs(await createDiskSink().persist([item('env-dir')], {}));
    expect(refs[0]).toBe(join(dir, 'env-dir.png'));
  });
});

describe('createR2Sink', () => {
  function fakeBucket(): MediaBucket & { puts: Array<{ key: string; bytes: Uint8Array; httpMetadata?: unknown }> } {
    const puts: Array<{ key: string; bytes: Uint8Array; httpMetadata?: unknown }> = [];
    return {
      puts,
      async put(key, value, options) {
        puts.push({ key, bytes: new Uint8Array(value as ArrayBuffer), httpMetadata: options?.httpMetadata });
        return {};
      },
    };
  }

  it('reports that it does NOT persist files (no filesystem, no sidecars)', () => {
    expect(createR2Sink(fakeBucket(), {}).persistsFiles).toBe(false);
    expect(createR2Sink(fakeBucket(), {}).kind).toBe('r2');
  });

  it('puts the decoded bytes with a MIME-derived extension and content type', async () => {
    const bucket = fakeBucket();
    const refs = toRefs(await createR2Sink(bucket, { publicBaseUrl: 'https://media.example.com' }).persist(
      [item('hello')],
      {},
    ));

    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0].key).toMatch(/\.png$/);
    expect(Buffer.from(bucket.puts[0].bytes)).toEqual(Buffer.from(PNG_B64, 'base64'));
    expect(bucket.puts[0].httpMetadata).toMatchObject({ contentType: 'image/png' });
    expect(refs[0]).toBe(`https://media.example.com/${bucket.puts[0].key}`);
  });

  it('never collides two objects generated in the same call', async () => {
    const bucket = fakeBucket();
    await createR2Sink(bucket, {}).persist([item('same'), item('same'), item('same')], {});
    expect(new Set(bucket.puts.map((p) => p.key)).size).toBe(3);
  });

  it('sanitises the caller-supplied base name so it cannot escape the key prefix', async () => {
    const bucket = fakeBucket();
    await createR2Sink(bucket, {}).persist([item('../../etc/passwd')], {});
    expect(bucket.puts[0].key).not.toContain('..');
    // `gen/`, not `media/`: objects are served at /media/<key>, and a `media`
    // prefix would make every URL read /media/media/….
    expect(bucket.puts[0].key.startsWith('gen/')).toBe(true);
  });

  it('ignores output_dir — there is no filesystem to point it at', async () => {
    const bucket = fakeBucket();
    await createR2Sink(bucket, { publicBaseUrl: 'https://media.example.com' }).persist([item('x')], {
      output_dir: '/tmp/nope',
    });
    expect(bucket.puts[0].key).not.toContain('tmp');
  });

  it('returns a SIGNED connector URL when no public base URL is configured — the zero-config path', async () => {
    // This is the normal case: MEDIA_PUBLIC_BASE_URL was never set in practice,
    // and the old `r2://bucket/key` ref meant every hosted generation was
    // invisible to the person who asked for it.
    const bucket = fakeBucket();
    const persisted = await createR2Sink(bucket, {
      signedBaseUrl: 'https://connector.example.com/media',
      sign: async (key, exp) => `sig-${key.length}-${exp}`,
      urlTtlMs: 3600_000,
      now: () => new Date('2026-07-29T12:00:00Z'),
    }).persist([item('x')], {});

    expect(persisted[0].ref).toMatch(/^https:\/\/connector\.example\.com\/media\/gen\//);
    expect(persisted[0].ref).toContain('exp=');
    expect(persisted[0].ref).toContain('sig=');
    expect(persisted[0].key).toBe(bucket.puts[0].key);
    expect(persisted[0].expiresAt).toBe('2026-07-29T13:00:00.000Z');
  });

  it('never emits an r2:// ref any more, in any configuration', async () => {
    const configs = [
      { publicBaseUrl: 'https://media.example.com' },
      { signedBaseUrl: 'https://c.example.com/media', sign: async () => 'sig', urlTtlMs: 1000 },
      { bucketName: 'gemini-connector-media' },
    ];
    for (const cfg of configs) {
      const persisted = await createR2Sink(fakeBucket(), cfg).persist([item('x')], {});
      expect(persisted[0].ref).not.toMatch(/^r2:\/\//);
    }
  });

  it('describes itself honestly for the result payload', async () => {
    const withUrl = createR2Sink(fakeBucket(), { publicBaseUrl: 'https://media.example.com' });
    expect(withUrl.note()).toMatch(/URL/i);

    const withoutUrl = createR2Sink(fakeBucket(), {});
    expect(withoutUrl.note()).toMatch(/not.*publicly|no public/i);
  });

  /** fakeBucket plus the `get` a real R2 binding has, backed by what was put. */
  function readableBucket() {
    const base = fakeBucket();
    return {
      ...base,
      puts: base.puts,
      async get(key: string) {
        const hit = base.puts.find((p) => p.key === key);
        if (!hit) return null;
        return {
          arrayBuffer: async () => hit.bytes.buffer as ArrayBuffer,
          httpMetadata: hit.httpMetadata as { contentType?: string },
        };
      },
    };
  }

  describe('read() — a generated image becoming a reference image', () => {
    it('returns the stored bytes and content type for a key it persisted', async () => {
      const bucket = readableBucket();
      const sink = createR2Sink(bucket, {});
      await sink.persist([item('cat')], {});

      const stored = await sink.read!(bucket.puts[0].key);
      expect(Buffer.from(stored!.bytes)).toEqual(Buffer.from(PNG_B64, 'base64'));
      expect(stored!.mimeType).toBe('image/png');
    });

    it('returns undefined for a swept key, and on a bucket with no get()', async () => {
      const sink = createR2Sink(readableBucket(), {});
      await expect(sink.read!('gen/never-existed.png')).resolves.toBeUndefined();
      // A put-only binding (older test fakes) must degrade, not throw.
      await expect(createR2Sink(fakeBucket(), {}).read!('gen/x.png')).resolves.toBeUndefined();
    });
  });

  describe('resign() — a fresh URL without a fresh (billed) generation', () => {
    const signedOpts = {
      signedBaseUrl: 'https://connector.example.com/media',
      sign: async (key: string, exp: number) => `sig-${key.length}-${exp}`,
      urlTtlMs: 3600_000,
      now: () => new Date('2026-07-30T12:00:00Z'),
    };

    it('mints a new signed URL + expiry for an object still in storage', async () => {
      const bucket = readableBucket();
      const sink = createR2Sink(bucket, signedOpts);
      await sink.persist([item('cat')], {});

      const fresh = await sink.resign!(bucket.puts[0].key);
      expect(fresh!.key).toBe(bucket.puts[0].key);
      expect(fresh!.ref).toMatch(/^https:\/\/connector\.example\.com\/media\/gen\/.*exp=/);
      expect(fresh!.expiresAt).toBe('2026-07-30T13:00:00.000Z');
    });

    it('refuses to re-sign a swept key — a fresh link that 404s is no fix', async () => {
      const sink = createR2Sink(readableBucket(), signedOpts);
      await expect(sink.resign!('gen/swept.png')).resolves.toBeUndefined();
    });
  });
});
