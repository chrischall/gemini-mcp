import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
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

// chrischall/fleet-audit#473: the output dir defaults to cwd, which can be a
// cloned repo. A planted sidecar must not be able to name arbitrary local files
// for the chain re-anchor to read and upload without the confirm gate.
describe('planted sidecars', () => {
  let outside: string;
  beforeEach(() => { outside = mkdtempSync(join(tmpdir(), 'gemini-sidecar-outside-')); });
  afterEach(() => { rmSync(outside, { recursive: true, force: true }); });

  it('ignores a .json that is not named after an output file (<file>.<ext>.json)', async () => {
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ interaction_id: 'v1_bogus', images: [] }));
    expect(await readSidecars(dir)).toEqual([]);
    expect(await latestInteractionId(dir)).toBeUndefined();
  });

  it('never lists a file outside the output dir', async () => {
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    seed('real', 'id-real', 1_000);
    writeFileSync(join(dir, 'x.png.json'), JSON.stringify({ interaction_id: 'v1_bogus', images: [secret] }));
    expect(await findInteractionImages(dir, 'v1_bogus')).toEqual([]);
  });

  it('never lists a file in the output dir that has no sidecar of its own', async () => {
    const stray = join(dir, 'notes.txt');
    writeFileSync(stray, 'not an output');
    writeFileSync(join(dir, 'x.png.json'), JSON.stringify({ interaction_id: 'v1_bogus', images: [stray] }));
    expect(await findInteractionImages(dir, 'v1_bogus')).toEqual([]);
  });

  it('never lists a symlink, even one with a sidecar', async () => {
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    const link = join(dir, 'x.png');
    symlinkSync(secret, link);
    writeFileSync(`${link}.json`, JSON.stringify({ interaction_id: 'v1_bogus', images: [link] }));
    expect(await findInteractionImages(dir, 'v1_bogus')).toEqual([]);
  });

  it('still lists every image of a multi-image turn (each has its own sidecar)', async () => {
    const a = join(dir, 'set-01.png');
    const b = join(dir, 'set-02.png');
    for (const img of [a, b]) {
      writeFileSync(img, 'png');
      writeFileSync(`${img}.json`, JSON.stringify({ interaction_id: 'id-set', images: [a, b] }));
    }
    expect(await findInteractionImages(dir, 'id-set')).toEqual([a, b]);
  });
});
