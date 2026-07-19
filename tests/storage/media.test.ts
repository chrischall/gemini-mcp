import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createDiskSink, createR2Sink, type MediaBucket, type MediaItem } from '../../src/storage/media.js';

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
    const refs = await createDiskSink().persist([item('hello')], { output_dir: dir });
    expect(refs).toHaveLength(1);
    expect(isAbsolute(refs[0])).toBe(true);
    expect(refs[0]).toBe(join(dir, 'hello.png'));
    expect(await readFile(refs[0])).toEqual(Buffer.from(PNG_B64, 'base64'));
  });

  it('picks the extension from the MIME type', async () => {
    const refs = await createDiskSink().persist(
      [item('clip', 'video/mp4'), item('track', 'audio/mpeg'), item('shot', 'image/jpeg')],
      { output_dir: dir },
    );
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
    const refs = await createDiskSink().persist([item('env-dir')], {});
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
    const refs = await createR2Sink(bucket, { publicBaseUrl: 'https://media.example.com' }).persist(
      [item('hello')],
      {},
    );

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
    expect(bucket.puts[0].key.startsWith('media/')).toBe(true);
  });

  it('ignores output_dir — there is no filesystem to point it at', async () => {
    const bucket = fakeBucket();
    await createR2Sink(bucket, { publicBaseUrl: 'https://media.example.com' }).persist([item('x')], {
      output_dir: '/tmp/nope',
    });
    expect(bucket.puts[0].key).not.toContain('tmp');
  });

  it('returns an r2:// ref (NOT a fabricated https URL) when no public base URL is configured', async () => {
    const bucket = fakeBucket();
    const refs = await createR2Sink(bucket, { bucketName: 'gemini-connector-media' }).persist([item('x')], {});
    expect(refs[0].startsWith('r2://gemini-connector-media/')).toBe(true);
  });

  it('describes itself honestly for the result payload', async () => {
    const withUrl = createR2Sink(fakeBucket(), { publicBaseUrl: 'https://media.example.com' });
    expect(withUrl.note()).toMatch(/URL/i);

    const withoutUrl = createR2Sink(fakeBucket(), {});
    expect(withoutUrl.note()).toMatch(/not.*publicly|no public/i);
  });
});
