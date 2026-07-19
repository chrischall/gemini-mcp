import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSidecars, findInteractionImages, latestInteractionId } from '../src/sidecar.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-sidecar-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Write an image + its `<image>.json` sidecar, stamped at `mtime` seconds. */
function seed(base: string, interactionId: string, mtime: number): string {
  const image = join(dir, `${base}.jpg`);
  writeFileSync(image, 'not-a-real-jpeg');
  const sidecar = `${image}.json`;
  writeFileSync(sidecar, JSON.stringify({ interaction_id: interactionId, images: [image] }));
  utimesSync(sidecar, mtime, mtime);
  return image;
}

describe('readSidecars', () => {
  it('returns records newest-first', async () => {
    seed('v10', 'id-10', 1_000);
    seed('v11', 'id-11', 2_000);
    const records = await readSidecars(dir);
    expect(records.map((r) => r.interactionId)).toEqual(['id-11', 'id-10']);
  });

  it('returns [] for a directory that does not exist', async () => {
    expect(await readSidecars(join(dir, 'nope'))).toEqual([]);
  });

  it('ignores malformed JSON and sidecars with no interaction id', async () => {
    seed('good', 'id-good', 1_000);
    writeFileSync(join(dir, 'broken.jpg.json'), '{not json');
    writeFileSync(join(dir, 'idless.jpg.json'), JSON.stringify({ model: 'x', images: [] }));
    const records = await readSidecars(dir);
    expect(records.map((r) => r.interactionId)).toEqual(['id-good']);
  });

  it('drops image paths that no longer exist on disk', async () => {
    const image = seed('gone', 'id-gone', 1_000);
    rmSync(image);
    const [record] = await readSidecars(dir);
    expect(record.images).toEqual([]);
  });
});

describe('findInteractionImages', () => {
  it('returns the images recorded for a specific interaction id', async () => {
    seed('v10', 'id-10', 1_000);
    const wanted = seed('v11', 'id-11', 2_000);
    expect(await findInteractionImages(dir, 'id-11')).toEqual([wanted]);
  });

  it('returns [] when the id is not on disk', async () => {
    seed('v10', 'id-10', 1_000);
    expect(await findInteractionImages(dir, 'id-missing')).toEqual([]);
  });
});

describe('latestInteractionId', () => {
  it('returns the newest sidecar interaction id', async () => {
    seed('v10', 'id-10', 1_000);
    seed('v11', 'id-11', 2_000);
    expect(await latestInteractionId(dir)).toBe('id-11');
  });

  it('returns undefined when the directory has no sidecars', async () => {
    expect(await latestInteractionId(dir)).toBeUndefined();
  });
});
