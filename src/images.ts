import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { readEnvVar, McpToolError } from '@chrischall/mcp-utils';

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

/** Sniff MIME type from the first bytes of an image buffer. */
function sniffMimeBytes(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/** Decode base64 image bytes and write to disk (creating dir). Returns the absolute path. */
export async function writeImage(dir: string, base: string, base64: string, mimeType: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  const path = await uniquePath(dir, base, ext);
  await writeFile(path, Buffer.from(base64, 'base64'));
  return resolve(path);
}

/**
 * Resolve an image path, checking (in order):
 *  1. Absolute path that exists → returned as-is.
 *  2. `GEMINI_INPUT_DIR` env var is set → look for `join(inputDir, p)`.
 *  3. Relative to cwd → `resolve(p)`.
 * Throws a helpful `McpToolError` if none are found.
 */
export function resolveImagePath(p: string): string {
  if (isAbsolute(p) && existsSync(p)) return p;
  const inputDir = readEnvVar('GEMINI_INPUT_DIR');
  if (inputDir) {
    // NOTE: a `../`-bearing `p` can escape inputDir. Acceptable for a local,
    // single-user MCP — the caller already has the user's own filesystem access.
    const candidate = join(inputDir, p);
    if (existsSync(candidate)) return candidate;
  }
  const cwd = resolve(p);
  if (existsSync(cwd)) return cwd;
  const hint = 'Set GEMINI_INPUT_DIR to a directory containing your images, or pass an absolute path.';
  throw new McpToolError(
    `Image not found: ${p}` + (inputDir ? ` (also searched GEMINI_INPUT_DIR=${inputDir})` : ''),
    { hint },
  );
}

/** Read an image file into `{ base64, mimeType }` for an inline_data part. */
export async function readImageAsInline(path: string): Promise<{ base64: string; mimeType: string }> {
  const resolved = resolveImagePath(path);
  const buf = await readFile(resolved);
  const mimeType = sniffMimeBytes(buf);
  return { base64: buf.toString('base64'), mimeType };
}

/**
 * Accept either a data URI (`data:image/png;base64,XXXX`) or raw base64.
 * For raw base64, MIME is sniffed from the decoded bytes.
 */
export function decodeImageInput(input: string): { base64: string; mimeType: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith('data:')) {
    // data:<mediatype>[;param=value…];base64,<data> — tolerate extra params
    // (e.g. charset) between the type and the base64 marker. Don't silently
    // fall through to the raw-base64 path: a malformed data URI would decode to
    // garbage bytes and ship corrupted data to the API.
    const marker = trimmed.indexOf(';base64,');
    if (marker === -1) {
      throw new Error(`Unsupported data URI (expected ;base64,<data>): ${trimmed.slice(0, 48)}…`);
    }
    // MIME runs from after "data:" to the first ';' (a param sep or the base64 marker).
    const mimeType = trimmed.slice(5, trimmed.indexOf(';', 5)) || 'image/png';
    return { mimeType, base64: trimmed.slice(marker + ';base64,'.length) };
  }
  // Raw base64 — sniff from decoded bytes
  const buf = Buffer.from(trimmed, 'base64');
  return { base64: trimmed, mimeType: sniffMimeBytes(buf) };
}

/** Load images from file paths (via readImageAsInline) and raw base64 strings (via decodeImageInput), paths first. */
export async function loadImageInputs(
  paths: string[] = [],
  base64s: string[] = [],
): Promise<{ base64: string; mimeType: string }[]> {
  const fromPaths = await Promise.all(paths.map((p) => readImageAsInline(p)));
  const fromBase64s = base64s.map((b) => decodeImageInput(b));
  return [...fromPaths, ...fromBase64s];
}

/**
 * Aggregate image inputs from all sources: clipboard (macOS only), file paths, and base64 strings.
 * Clipboard image is prepended if `from_clipboard` is true.
 */
export async function gatherImageInputs(opts: {
  images?: string[];
  images_base64?: string[];
  from_clipboard?: boolean;
}): Promise<{ base64: string; mimeType: string }[]> {
  // Only load the clipboard module when actually requested (keeps the child_process
  // path off the default code path).
  const clipboardImages = opts.from_clipboard
    ? [await (await import('./clipboard.js')).readClipboardImage()]
    : [];
  const fileImages = await loadImageInputs(opts.images, opts.images_base64);
  return [...clipboardImages, ...fileImages];
}

/** Caller-supplied filename → safe base name (no extension). */
export function baseName(name: string): string {
  // Strip known image extensions
  const stripped = name.replace(/\.(png|jpe?g|webp)$/i, '');
  // Replace non-safe chars with hyphens, collapse repeats, trim edges
  const safe = stripped
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'image';
}

/** per-call → $GEMINI_OUTPUT_DIR → cwd. */
export function resolveOutputDir(perCall: string | undefined): string {
  return perCall?.trim() || readEnvVar('GEMINI_OUTPUT_DIR') || process.cwd();
}
