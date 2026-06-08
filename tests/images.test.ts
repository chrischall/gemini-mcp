import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, writeImage, readImageAsInline, resolveOutputDir } from '../src/images.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-img-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('slugify', () => {
  it('lowercases, hyphenates, trims, and caps length', () => {
    expect(slugify('A Cute Fox!! Named Rusty')).toBe('a-cute-fox-named-rusty');
    expect(slugify('   ')).toBe('image');
  });
});

describe('writeImage', () => {
  it('writes base64 PNG bytes and returns the path', async () => {
    const p = await writeImage(dir, 'fox', PNG_B64, 'image/png');
    expect(p).toBe(join(dir, 'fox.png'));
    expect(readFileSync(p).slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  it('does not overwrite — bumps a numeric suffix', async () => {
    const a = await writeImage(dir, 'fox', PNG_B64, 'image/png');
    const b = await writeImage(dir, 'fox', PNG_B64, 'image/png');
    expect(a).toBe(join(dir, 'fox.png'));
    expect(b).toBe(join(dir, 'fox-2.png'));
  });
});

describe('readImageAsInline', () => {
  it('reads a file into base64 + mime type', async () => {
    const p = join(dir, 'in.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    const r = await readImageAsInline(p);
    expect(r).toEqual({ base64: PNG_B64, mimeType: 'image/png' });
  });
});

describe('resolveOutputDir', () => {
  it('prefers per-call, falls back to cwd when env unset', () => {
    delete process.env.GEMINI_OUTPUT_DIR;
    expect(resolveOutputDir('/tmp/x')).toBe('/tmp/x');
    expect(resolveOutputDir(undefined)).toBe(process.cwd());
  });
});
