// Reference images (`images` / `image_path` local paths) are read and sent to
// Google — inline, or as a Files API upload once reused — so they get the same
// opt-in confinement as uploads: GEMINI_REFERENCE_DIR, else GEMINI_UPLOAD_DIR,
// else (hosted, MCP_DATA_DIR set) $MCP_DATA_DIR/uploads, else unconfined.
// GEMINI_OUTPUT_DIR is added to any active roots so this server's own
// generated images can always be fed back in.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { referenceRoots, readImageAsInline, readOutputImageAsInline, previewImageInput } from '../src/images.js';
import { resolveImageInputs } from '../src/inputs.js';
import { SessionState } from '../src/session.js';
import { createDiskSink } from '../src/storage/media.js';
import type { GeminiClient } from '../src/client.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const KEYS = ['GEMINI_REFERENCE_DIR', 'GEMINI_UPLOAD_DIR', 'GEMINI_OUTPUT_DIR', 'MCP_DATA_DIR'] as const;

let base: string;
let root: string;
let outside: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-ref-')));
  root = join(base, 'refs');
  mkdirSync(root);
  writeFileSync(join(root, 'ok.png'), PNG);
  outside = join(base, 'secret.png');
  writeFileSync(outside, PNG);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(base, { recursive: true, force: true });
});

describe('referenceRoots', () => {
  it('unset everywhere (local) → undefined: reference images stay unconfined', () => {
    expect(referenceRoots({})).toBeUndefined();
  });
  it('GEMINI_REFERENCE_DIR wins, as a delimiter list, plus GEMINI_OUTPUT_DIR', () => {
    expect(referenceRoots({
      GEMINI_REFERENCE_DIR: ` /a${delimiter}${delimiter}~/b `, GEMINI_UPLOAD_DIR: '/up', GEMINI_OUTPUT_DIR: '/out', MCP_DATA_DIR: '/data',
    })).toEqual(['/a', '~/b', '/out']);
  });
  it('falls back to GEMINI_UPLOAD_DIR — the existing "local files sent to Google" allow-list', () => {
    expect(referenceRoots({ GEMINI_UPLOAD_DIR: '/up' })).toEqual(['/up']);
  });
  it('hosted (MCP_DATA_DIR set) confines by default to $MCP_DATA_DIR/uploads', () => {
    expect(referenceRoots({ MCP_DATA_DIR: '/data' })).toEqual([join('/data', 'uploads')]);
    expect(referenceRoots({ MCP_DATA_DIR: '/data', GEMINI_OUTPUT_DIR: '/out' })).toEqual([join('/data', 'uploads'), '/out']);
  });
  it('a blank or delimiter-only value counts as unset', () => {
    expect(referenceRoots({ GEMINI_REFERENCE_DIR: delimiter, GEMINI_UPLOAD_DIR: '  ' })).toBeUndefined();
    expect(referenceRoots({ GEMINI_REFERENCE_DIR: ' ', MCP_DATA_DIR: '/data' })).toEqual([join('/data', 'uploads')]);
  });
  it('GEMINI_OUTPUT_DIR alone does not switch confinement on', () => {
    expect(referenceRoots({ GEMINI_OUTPUT_DIR: '/out' })).toBeUndefined();
  });
});

describe('reference image reads', () => {
  it('unconfined when nothing is configured', async () => {
    expect((await readImageAsInline(outside)).mimeType).toBe('image/png');
    expect((await previewImageInput(outside)).size).toBe(PNG.length);
  });

  it('GEMINI_REFERENCE_DIR: inside is read, outside is refused with an actionable message', async () => {
    process.env.GEMINI_REFERENCE_DIR = root;
    expect((await readImageAsInline(join(root, 'ok.png'))).mimeType).toBe('image/png');
    await expect(readImageAsInline(outside)).rejects.toThrow(/outside GEMINI_REFERENCE_DIR/);
    await expect(previewImageInput(outside)).rejects.toThrow(/outside GEMINI_REFERENCE_DIR/);
  });

  it('falls back to GEMINI_UPLOAD_DIR', async () => {
    process.env.GEMINI_UPLOAD_DIR = root;
    await expect(readImageAsInline(outside)).rejects.toThrow(/GEMINI_REFERENCE_DIR/);
    expect((await previewImageInput(join(root, 'ok.png'))).mimeType).toBe('image/png');
  });

  it('hosted default refuses a path outside $MCP_DATA_DIR/uploads', async () => {
    process.env.MCP_DATA_DIR = base;
    mkdirSync(join(base, 'uploads'));
    writeFileSync(join(base, 'uploads', 'in.png'), PNG);
    expect((await readImageAsInline(join(base, 'uploads', 'in.png'))).mimeType).toBe('image/png');
    await expect(readImageAsInline(outside)).rejects.toThrow(/outside/);
  });

  it('refuses a symlink inside the root that points out of it', async () => {
    process.env.GEMINI_REFERENCE_DIR = root;
    symlinkSync(outside, join(root, 'link.png'));
    await expect(readImageAsInline(join(root, 'link.png'))).rejects.toThrow(/outside/);
  });

  it('GEMINI_OUTPUT_DIR images stay usable as references once confinement is on', async () => {
    const out = join(base, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'gen.png'), PNG);
    process.env.GEMINI_REFERENCE_DIR = root;
    process.env.GEMINI_OUTPUT_DIR = out;
    expect((await readImageAsInline(join(out, 'gen.png'))).mimeType).toBe('image/png');
  });

  it("re-anchoring reads this server's own output off disk without the reference roots", async () => {
    process.env.GEMINI_REFERENCE_DIR = root;
    expect((await readOutputImageAsInline(outside)).mimeType).toBe('image/png');
  });
});

describe('resolveImageInputs funnel', () => {
  it('refuses an out-of-root `images` path before reading or uploading it', async () => {
    process.env.GEMINI_REFERENCE_DIR = root;
    const uploadBytes = vi.fn();
    const client = { mediaSink: createDiskSink(), session: new SessionState(), uploadBytes } as unknown as GeminiClient;
    await expect(resolveImageInputs({ images: [outside] }, client)).rejects.toThrow(/outside GEMINI_REFERENCE_DIR/);
    expect(uploadBytes).not.toHaveBeenCalled();
    const ok = await resolveImageInputs({ images: [join(root, 'ok.png')] }, client);
    expect(ok.inputs).toHaveLength(1);
  });
});
