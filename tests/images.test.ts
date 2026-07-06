import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { slugify, writeImage, readImageAsInline, resolveOutputDir, decodeImageInput, loadImageInputs, baseName, resolveImagePath, videoMimeType, resolveVideoPath } from '../src/images.js';

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
  it('reads a file into base64 + mime type (magic-byte sniff: PNG)', async () => {
    const p = join(dir, 'in.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    const r = await readImageAsInline(p);
    expect(r).toEqual({ base64: PNG_B64, mimeType: 'image/png' });
  });

  it('sniffs JPEG magic bytes even without a .jpg extension', async () => {
    // A minimal JPEG starts with FF D8 FF
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const p = join(dir, 'noext');
    writeFileSync(p, jpegBytes);
    const r = await readImageAsInline(p);
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('sniffs WebP magic bytes', async () => {
    // RIFF....WEBP header
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // file size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    const p = join(dir, 'test.webp');
    writeFileSync(p, webpBytes);
    const r = await readImageAsInline(p);
    expect(r.mimeType).toBe('image/webp');
  });
});

describe('decodeImageInput', () => {
  it('parses a data URI into mime + base64', () => {
    const r = decodeImageInput(`data:image/png;base64,${PNG_B64}`);
    expect(r.mimeType).toBe('image/png');
    expect(r.base64).toBe(PNG_B64);
  });

  it('parses a data URI with image/jpeg mime', () => {
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');
    const r = decodeImageInput(`data:image/jpeg;base64,${jpegB64}`);
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.base64).toBe(jpegB64);
  });

  it('sniffs PNG from raw base64 (no data URI prefix)', () => {
    const r = decodeImageInput(PNG_B64);
    expect(r.mimeType).toBe('image/png');
    expect(r.base64).toBe(PNG_B64);
  });

  it('sniffs JPEG from raw base64', () => {
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
    const r = decodeImageInput(jpegB64);
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.base64).toBe(jpegB64);
  });

  it('trims whitespace from input', () => {
    const r = decodeImageInput(`  data:image/png;base64,${PNG_B64}  `);
    expect(r.mimeType).toBe('image/png');
    expect(r.base64).toBe(PNG_B64);
  });

  it('tolerates extra params before the base64 marker (e.g. charset)', () => {
    const r = decodeImageInput(`data:image/png;charset=utf-8;base64,${PNG_B64}`);
    expect(r.mimeType).toBe('image/png');
    expect(r.base64).toBe(PNG_B64);
  });

  it('throws on a malformed data URI rather than silently decoding garbage', () => {
    expect(() => decodeImageInput('data:image/png,not-base64-content')).toThrow(/data URI/i);
  });
});

describe('writeImage extension by mime', () => {
  it('writes .webp for image/webp (not .png)', async () => {
    const p = await writeImage(dir, 'pic', PNG_B64, 'image/webp');
    expect(p.endsWith('.webp')).toBe(true);
  });
  it('writes .jpg for image/jpeg', async () => {
    const p = await writeImage(dir, 'pic', PNG_B64, 'image/jpeg');
    expect(p.endsWith('.jpg')).toBe(true);
  });
});

describe('loadImageInputs', () => {
  it('loads paths via readImageAsInline and base64 via decodeImageInput, paths first', async () => {
    const pngPath = join(dir, 'in.png');
    writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');
    const result = await loadImageInputs([pngPath], [jpegB64]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ base64: PNG_B64, mimeType: 'image/png' });
    expect(result[1].mimeType).toBe('image/jpeg');
  });

  it('handles empty arrays gracefully', async () => {
    const result = await loadImageInputs([], []);
    expect(result).toHaveLength(0);
  });
});

describe('baseName', () => {
  it('strips common image extensions', () => {
    expect(baseName('my-photo.png')).toBe('my-photo');
    expect(baseName('image.jpg')).toBe('image');
    expect(baseName('foo.jpeg')).toBe('foo');
    expect(baseName('bar.webp')).toBe('bar');
  });

  it('replaces invalid chars with hyphens, collapses repeats, trims edges', () => {
    expect(baseName('my image!!file')).toBe('my-image-file');
    expect(baseName('--bad--')).toBe('bad');
    expect(baseName('hello world')).toBe('hello-world');
  });

  it('returns image for empty or all-invalid input', () => {
    expect(baseName('')).toBe('image');
    expect(baseName('!!!')).toBe('image');
    expect(baseName('.png')).toBe('image');
  });
});

describe('resolveOutputDir', () => {
  it('prefers per-call, falls back to cwd when env unset', () => {
    delete process.env.GEMINI_OUTPUT_DIR;
    expect(resolveOutputDir('/tmp/x')).toBe('/tmp/x');
    expect(resolveOutputDir(undefined)).toBe(process.cwd());
  });
});

describe('resolveImagePath', () => {
  afterEach(() => { delete process.env.GEMINI_INPUT_DIR; });

  it('returns an absolute path that exists as-is', () => {
    const p = join(dir, 'abs.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    expect(resolveImagePath(p)).toBe(p);
  });

  it('resolves a bare filename against GEMINI_INPUT_DIR when set', () => {
    const p = join(dir, 'ref.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    process.env.GEMINI_INPUT_DIR = dir;
    expect(resolveImagePath('ref.png')).toBe(join(dir, 'ref.png'));
  });

  it('returns an absolute path even when GEMINI_INPUT_DIR is relative', () => {
    const p = join(dir, 'rel-env.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    process.env.GEMINI_INPUT_DIR = relative(process.cwd(), dir);
    const result = resolveImagePath('rel-env.png');
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolve(dir, 'rel-env.png'));
  });

  it('resolves a bare filename relative to cwd when GEMINI_INPUT_DIR not set', () => {
    // Write a file in cwd that we can reference by bare name
    const filename = 'gemini-test-tmp-resolveImagePath-cwd.png';
    const p = join(process.cwd(), filename);
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    try {
      delete process.env.GEMINI_INPUT_DIR;
      expect(resolveImagePath(filename)).toBe(resolve(filename));
    } finally {
      rmSync(p);
    }
  });

  it('throws a helpful error with hint when file is not found', () => {
    delete process.env.GEMINI_INPUT_DIR;
    expect(() => resolveImagePath('does-not-exist.png')).toThrow(/Image not found/);
  });

  it('throws for an absolute path that does not exist (no silent pass-through)', () => {
    delete process.env.GEMINI_INPUT_DIR;
    expect(() => resolveImagePath('/nonexistent/abs/foo.png')).toThrow(/Image not found/);
  });

  it('mentions GEMINI_INPUT_DIR in the error when it was searched', () => {
    process.env.GEMINI_INPUT_DIR = dir;
    expect(() => resolveImagePath('does-not-exist.png')).toThrow(/GEMINI_INPUT_DIR/);
  });

  it('readImageAsInline uses resolveImagePath — bare filename resolves via GEMINI_INPUT_DIR', async () => {
    const p = join(dir, 'via-env.png');
    writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
    process.env.GEMINI_INPUT_DIR = dir;
    const result = await readImageAsInline('via-env.png');
    expect(result.mimeType).toBe('image/png');
  });
});

describe('videoMimeType', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.MOV', 'video/mov'],
    ['clip.webm', 'video/webm'],
    ['clip.mpeg', 'video/mpeg'],
    ['clip.mpg', 'video/mpg'],
    ['clip.avi', 'video/avi'],
    ['clip.flv', 'video/x-flv'],
    ['clip.wmv', 'video/wmv'],
    ['clip.3gp', 'video/3gpp'],
  ])('maps %s → %s', (name, mime) => {
    expect(videoMimeType(name)).toBe(mime);
  });

  it('throws an actionable error for an unsupported extension', () => {
    expect(() => videoMimeType('clip.mkv')).toThrow(/mkv/);
    expect(() => videoMimeType('clip')).toThrow(/Unsupported video/i);
  });
});

describe('resolveVideoPath', () => {
  it('resolves via GEMINI_INPUT_DIR like image paths', () => {
    const p = join(dir, 'via-env.mp4');
    writeFileSync(p, Buffer.from('x'));
    process.env.GEMINI_INPUT_DIR = dir;
    expect(resolveVideoPath('via-env.mp4')).toBe(p);
  });

  it('throws "Video not found" (not "Image not found") when missing', () => {
    delete process.env.GEMINI_INPUT_DIR;
    expect(() => resolveVideoPath('/nonexistent/clip.mp4')).toThrow(/Video not found/);
  });
});
