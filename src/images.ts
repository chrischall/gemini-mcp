import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar } from '@chrischall/mcp-utils';

/** URL/file-safe slug from a prompt; never empty. */
export function slugify(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'image';
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** `<base>.<ext>`, then `<base>-2.<ext>`, … until a free path is found. */
export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = join(dir, `${base}.${ext}`);
  let n = 2;
  while (await exists(candidate)) { candidate = join(dir, `${base}-${n}.${ext}`); n++; }
  return candidate;
}

/** Decode base64 image bytes and write to disk (creating dir). Returns the path. */
export async function writeImage(dir: string, base: string, base64: string, mimeType: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
  const path = await uniquePath(dir, base, ext);
  await writeFile(path, Buffer.from(base64, 'base64'));
  return path;
}

/** Read an image file into `{ base64, mimeType }` for an inline_data part. */
export async function readImageAsInline(path: string): Promise<{ base64: string; mimeType: string }> {
  const buf = await readFile(path);
  const lower = path.toLowerCase();
  const mimeType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  return { base64: buf.toString('base64'), mimeType };
}

/** per-call → $GEMINI_OUTPUT_DIR → cwd. */
export function resolveOutputDir(perCall: string | undefined): string {
  return perCall?.trim() || readEnvVar('GEMINI_OUTPUT_DIR') || process.cwd();
}
