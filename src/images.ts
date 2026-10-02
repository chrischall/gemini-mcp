import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve, isAbsolute } from 'node:path';
import {
  assertPathWithinRoots,
  expandPath,
  fileBlob,
  readEnvVar,
  McpToolError,
  readFileHead,
  resolveOutputDir as resolveSharedOutputDir,
  sniffMimeBytes as sniffSharedMime,
  writeFileSafe,
  writeUniqueFile,
  type EnvSource,
} from '@chrischall/mcp-utils';

/**
 * `GEMINI_UPLOAD_DIR` — the optional allow-list for local files streamed to
 * the Files API (`gemini_upload_file` `path`, `video_path`). One or more
 * directories separated by the platform path delimiter (`:` / `;`); `~` is
 * expanded by mcp-utils. Unset → `undefined` → uploads stay unconfined.
 * The paths are model-chosen, so a prompt-injected path could otherwise send
 * any readable file to Google.
 */
export function uploadRoots(): string[] | undefined {
  const roots = readEnvVar('GEMINI_UPLOAD_DIR')?.split(delimiter).map((r) => r.trim()).filter(Boolean);
  return roots && roots.length > 0 ? roots : undefined;
}

/**
 * Turn mcp-utils' bare "outside the allowed directories" refusal into an
 * actionable tool error. The remediation is in the MESSAGE — hosts show the
 * message and drop the hint (see CLAUDE.md, Errors).
 */
export function explainOutsideUploadDir(err: unknown): never {
  if (err instanceof Error && err.message.startsWith('Path is outside the allowed directories')) {
    throw new McpToolError(
      'Refusing to upload a file outside GEMINI_UPLOAD_DIR, which restricts which local files can be uploaded to Google. Move the file into GEMINI_UPLOAD_DIR, or add its directory to GEMINI_UPLOAD_DIR.',
    );
  }
  throw err;
}

/** A path-delimiter list from `name`, trimmed, blanks dropped; `undefined` when empty. */
function rootList(name: string, env: EnvSource): string[] | undefined {
  const roots = readEnvVar(name, { env })?.split(delimiter).map((r) => r.trim()).filter(Boolean);
  return roots && roots.length > 0 ? roots : undefined;
}

/**
 * The folders a local REFERENCE image (`images` / `image_path` paths) may be
 * read from. Those bytes go to Google — inline, or as a Files API upload once a
 * path is reused (inputs.ts) — and the path is model-chosen, so a
 * prompt-injected path could otherwise send any readable file. In order:
 *
 * 1. `GEMINI_REFERENCE_DIR` — one or more folders (`:` / `;` separated, `~` ok);
 * 2. else `GEMINI_UPLOAD_DIR` — the existing allow-list for local files sent to
 *    the Files API, so an operator who restricted uploads gets reference images
 *    restricted too;
 * 3. else, hosted (`MCP_DATA_DIR` set) — only `$MCP_DATA_DIR/uploads`: never the
 *    runner's home, nor the data dir itself (it holds tokens and job state);
 * 4. else `undefined` — a local install with nothing configured stays
 *    unconfined (the user's own files, on their own machine).
 *
 * When confinement is on, `GEMINI_OUTPUT_DIR` (operator config) is added, so
 * this server's own generated images can always be fed back in as references.
 */
export function referenceRoots(env: EnvSource = process.env): string[] | undefined {
  let roots = rootList('GEMINI_REFERENCE_DIR', env) ?? rootList('GEMINI_UPLOAD_DIR', env);
  if (!roots) {
    const dataDir = readEnvVar('MCP_DATA_DIR', { env });
    if (dataDir) roots = [join(dataDir, 'uploads')];
  }
  if (!roots) return undefined;
  const output = readEnvVar('GEMINI_OUTPUT_DIR', { env })?.trim();
  return output && !roots.includes(output) ? [...roots, output] : roots;
}

/** mcp-utils' bare out-of-roots refusal → an actionable reference-image error. */
function explainOutsideReferenceDir(err: unknown, roots: readonly string[]): never {
  if (err instanceof Error && err.message.startsWith('Path is outside the allowed directories')) {
    throw new McpToolError(
      `Refusing to send a reference image from outside the allowed folders (${roots.join(', ')}). ` +
        'Reference images are confined by GEMINI_REFERENCE_DIR (else GEMINI_UPLOAD_DIR; on a hosted server, $MCP_DATA_DIR/uploads). ' +
        'Move the image into one of those folders, or add its folder to GEMINI_REFERENCE_DIR (outside GEMINI_REFERENCE_DIR is refused).',
    );
  }
  throw err;
}

/**
 * Refuse a resolved reference-image path outside {@link referenceRoots} (no-op
 * when unconfined). Checked through symlinks, before the file is stat'ed or read.
 */
export function assertReferenceAllowed(resolvedPath: string): void {
  const roots = referenceRoots();
  if (!roots) return;
  try {
    assertPathWithinRoots(resolvedPath, roots);
  } catch (err) {
    explainOutsideReferenceDir(err, roots);
  }
}

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

/** Sniff MIME type from the first bytes of an image buffer (PNG fallback).
 * Only for bytes that arrive as base64 with no other type information; a LOCAL
 * file goes through {@link localImageMime}, which never guesses. */
function sniffMimeBytes(buf: Buffer): string {
  return sniffImageMime(buf) ?? 'image/png';
}

/**
 * The MIME of a LOCAL image input (PNG/JPEG/WebP, sniffed from its bytes), or a
 * refusal. Never defaults: an unidentifiable file used to be previewed and sent
 * as image/png, so a prompt-injected `images: ['~/.ssh/id_rsa']` showed up in
 * the confirmation preview mislabelled as a PNG (chrischall/fleet-audit#929).
 */
function localImageMime(resolvedPath: string, head: Buffer): string {
  const mime = sniffImageMime(head);
  if (!mime) {
    throw new McpToolError(
      `Cannot tell what kind of image ${resolvedPath} is — its bytes are not PNG, JPEG or WebP, ` +
        'so it is not sent to Gemini as a reference image.',
      { hint: 'Pass a PNG, JPEG or WebP file (convert other formats first).' },
    );
  }
  return mime;
}

/** The image types Gemini takes as reference images — the only sniff results honoured here. */
const REFERENCE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * PNG/JPEG/WebP from the leading bytes (mcp-utils' shared magic-byte sniffer),
 * or `undefined` when it is none of them. The shared sniffer also names GIF,
 * PDF, zip, MIDI and ISO-BMFF; those are deliberately NOT accepted here, so a
 * reference image is still only ever one of the three types Gemini takes.
 */
function sniffImageMime(buf: Buffer): string | undefined {
  const mime = sniffSharedMime(buf);
  return mime !== undefined && REFERENCE_IMAGE_MIMES.has(mime) ? mime : undefined;
}

/** File extension for a media MIME (image/video/audio). Falls back to the MIME
 * subtype, so an unforeseen preview type still writes with a sane extension. */
export function mediaExt(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('png')) return 'png';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('webm')) return 'webm';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  return m.split('/')[1]?.split(';')[0]?.replace(/^x-/, '') || 'bin';
}

/** Decode base64 media bytes (image/video/audio) and write to disk (creating
 * dir), picking the extension from the MIME. Returns the absolute path.
 *
 * Never overwrites: `<base>.<ext>`, then `<base>-2.<ext>`, … — each name is
 * claimed with an exclusive, no-follow create (mcp-utils `writeUniqueFile`), so
 * two writers can't race onto one name and a symlink planted at a name is
 * skipped rather than written through. */
export async function writeMedia(dir: string, base: string, base64: string, mimeType: string): Promise<string> {
  const path = await writeUniqueFile({
    dir,
    baseName: base,
    extension: mediaExt(mimeType),
    bytes: Buffer.from(base64, 'base64'),
  });
  return resolve(path);
}

/** Decode base64 image bytes and write to disk. Returns the absolute path. */
export async function writeImage(dir: string, base: string, base64: string, mimeType: string): Promise<string> {
  return writeMedia(dir, base, base64, mimeType);
}

/**
 * Write `<imagePath>.json` recording generation metadata (notably the
 * interaction id) next to a written image. The MCP host's tools/call timeout
 * can expire while the server-side generation finishes anyway — the response
 * (and its interaction id) is then lost, but this sidecar survives, so the
 * multi-turn chain is recoverable from disk.
 */
export async function writeSidecar(imagePath: string, data: Record<string, unknown>): Promise<void> {
  // overwrite (a re-run may refresh it) but never through a planted symlink.
  await writeFileSafe(`${imagePath}.json`, Buffer.from(JSON.stringify(data, null, 2)), { overwrite: true });
}

/**
 * Resolve an input file path, checking (in order):
 *  1. Absolute path that exists → returned as-is.
 *  2. `GEMINI_INPUT_DIR` env var is set → look for `join(inputDir, p)`.
 *  3. Relative to cwd → `resolve(p)`.
 * Always returns an absolute path (callers compare resolved paths — e.g. the
 * interact re-attach guard — so a relative GEMINI_INPUT_DIR must not leak
 * through). Throws a helpful `McpToolError` (labelled `kind`) if none are found.
 */
function resolveInputPath(p: string, kind: 'Image' | 'Video'): string {
  if (isAbsolute(p) && existsSync(p)) return p;
  const inputDir = readEnvVar('GEMINI_INPUT_DIR');
  if (inputDir) {
    // NOTE: a `../`-bearing `p` can escape inputDir. Acceptable for a local,
    // single-user MCP — the caller already has the user's own filesystem access.
    const candidate = join(inputDir, p);
    if (existsSync(candidate)) return resolve(candidate);
  }
  const cwd = resolve(p);
  if (existsSync(cwd)) return cwd;
  const hint = `Set GEMINI_INPUT_DIR to a directory containing your ${kind.toLowerCase()}s, or pass an absolute path.`;
  throw new McpToolError(
    `${kind} not found: ${p}` + (inputDir ? ` (also searched GEMINI_INPUT_DIR=${inputDir})` : ''),
    { hint },
  );
}

/** Resolve an image path (absolute → GEMINI_INPUT_DIR → cwd). */
export function resolveImagePath(p: string): string {
  return resolveInputPath(p, 'Image');
}

/** Resolve a local video path (absolute → GEMINI_INPUT_DIR → cwd). */
export function resolveVideoPath(p: string): string {
  return resolveInputPath(p, 'Video');
}

/** Video MIME types the Gemini Files API accepts, by file extension
 * (docs/GEMINI-API.md "Files API — local video upload"). */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpg',
  mov: 'video/mov',
  avi: 'video/avi',
  flv: 'video/x-flv',
  webm: 'video/webm',
  wmv: 'video/wmv',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
};

/** MIME type for a video file from its extension; throws for unsupported formats. */
export function videoMimeType(p: string): string {
  const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
  const mime = VIDEO_MIME_BY_EXT[ext];
  if (!mime) {
    throw new McpToolError(`Unsupported video format: ${ext ? `.${ext}` : p}`, {
      hint: `Supported extensions: ${Object.keys(VIDEO_MIME_BY_EXT).map((e) => `.${e}`).join(', ')}`,
    });
  }
  return mime;
}

/** A resolved local input file, described for a confirmation preview. */
export interface LocalInputPreview { path: string; mimeType: string; size: number }

/**
 * The first 16 bytes of a local reference image, confined to
 * {@link referenceRoots} when those are set.
 */
async function readLocalHead(path: string): Promise<Buffer> {
  const roots = referenceRoots();
  try {
    return await readFileHead(path, 16, { ...(roots ? { allowedRoots: roots } : {}) });
  } catch (err) {
    return roots ? explainOutsideReferenceDir(err, roots) : Promise.reject(err);
  }
}

/**
 * Preview a local IMAGE input WITHOUT sending it anywhere: resolve the path to
 * an absolute one, sniff its mime from the leading bytes, and measure its size.
 * Reads the file locally (to sniff/measure) but makes NO network/API call — so a
 * prompt-injected `image_path` (e.g. a local secret) is visible before upload.
 */
export async function previewImageInput(path: string): Promise<LocalInputPreview> {
  const resolved = resolveImagePath(path);
  assertReferenceAllowed(resolved);
  // Read only the header bytes needed to sniff the MIME (≤12), and take the size
  // from stat() — a preview must not load a large reference image into memory
  // just to report it (matches previewVideoInput).
  const { size } = await stat(resolved);
  return { path: resolved, mimeType: localImageMime(resolved, await readLocalHead(resolved)), size };
}

/**
 * Preview a local VIDEO input WITHOUT uploading it: resolve the path, derive its
 * mime from the extension, and measure its size. Makes NO network/API call.
 */
export async function previewVideoInput(path: string): Promise<LocalInputPreview> {
  const resolved = resolveVideoPath(path);
  const { size } = await stat(resolved);
  return { path: resolved, mimeType: videoMimeType(resolved), size };
}

/**
 * Image and audio types the Files API accepts, by extension. Video comes from
 * {@link VIDEO_MIME_BY_EXT} so the two lists cannot disagree.
 */
const UPLOAD_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  ...VIDEO_MIME_BY_EXT,
};

/**
 * The MIME a local file should be uploaded to the Files API as, or `undefined`
 * when it cannot be identified. Bytes win for the image formats we can sniff
 * (a PNG saved as `.jpg` is still a PNG); otherwise the extension decides,
 * over image, video AND audio types. Never guesses: `gemini_upload_file` used
 * to label every unrecognised file image/png (chrischall/fleet-audit#117).
 */
export async function detectUploadMime(resolvedPath: string): Promise<string | undefined> {
  // Confined to GEMINI_UPLOAD_DIR when set — the same roots the upload itself
  // (fileBlob in client.ts) enforces, so an out-of-root path is refused here,
  // before the confirmation preview, rather than after it.
  const roots = uploadRoots();
  let head: Buffer;
  try {
    head = await readFileHead(resolvedPath, 16, { ...(roots ? { allowedRoots: roots } : {}) });
  } catch (err) {
    explainOutsideUploadDir(err);
  }
  const sniffed = sniffImageMime(head);
  if (sniffed) return sniffed;
  const ext = resolvedPath.includes('.') ? resolvedPath.slice(resolvedPath.lastIndexOf('.') + 1).toLowerCase() : '';
  return UPLOAD_MIME_BY_EXT[ext];
}

/**
 * Read a model-supplied reference image into `{ base64, mimeType }` for an
 * inline_data part, confined to {@link referenceRoots} when those are set
 * (mcp-utils `fileBlob` with `allowedRoots`, checked through symlinks).
 */
export async function readImageAsInline(path: string): Promise<{ base64: string; mimeType: string }> {
  const resolved = resolveImagePath(path);
  const roots = referenceRoots();
  let buf: Buffer;
  try {
    buf = Buffer.from(await (await fileBlob(resolved, { label: 'Image', ...(roots ? { allowedRoots: roots } : {}) })).arrayBuffer());
  } catch (err) {
    if (roots) explainOutsideReferenceDir(err, roots);
    throw err;
  }
  const mimeType = localImageMime(resolved, buf);
  return { base64: buf.toString('base64'), mimeType };
}

/**
 * Read an image THIS server wrote (an interaction's output, found by its
 * sidecar under the GEMINI_OUTPUT_DIR-confined {@link lookupOutputDir}) for
 * re-anchoring a chain. Not model-chosen, so not subject to the reference
 * roots — a chain must recover its own output wherever output_dir put it.
 */
export async function readOutputImageAsInline(path: string): Promise<{ base64: string; mimeType: string }> {
  const buf = await readFile(path);
  return { base64: buf.toString('base64'), mimeType: localImageMime(path, buf) };
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

/** Caller-supplied filename → safe base name (no extension). */
export function baseName(name: string): string {
  // Strip a known media extension (image / video / audio) so writeMedia doesn't
  // double it (e.g. "clip.mp4" → "clip" → "clip.mp4").
  const stripped = name.replace(/\.(png|jpe?g|webp|mp4|mov|webm|mp3|wav|ogg)$/i, '');
  // Replace non-safe chars with hyphens, collapse repeats, trim edges
  const safe = stripped
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'image';
}

/**
 * The output directory to LOOK IN (sidecar lookups: `continue_last`'s disk
 * fallback, the chain-404 re-anchor) — the same resolution and the same
 * GEMINI_OUTPUT_DIR confinement as {@link resolveOutputDir}, but read-only:
 * it never creates the directory, so a lookup that writes nothing leaves no
 * empty folder behind. A missing directory simply has no sidecars.
 */
export function lookupOutputDir(perCall: string | undefined): string {
  const trimmed = perCall?.trim() || undefined;
  const configured = readEnvVar('GEMINI_OUTPUT_DIR');
  const raw = trimmed ?? configured;
  if (!raw) return process.cwd();
  const dir = expandPath(raw);
  if (trimmed && configured) assertPathWithinRoots(dir, [configured]);
  return dir;
}

/**
 * per-call → $GEMINI_OUTPUT_DIR → cwd (mcp-utils `resolveOutputDir`: `~` and
 * relative paths expanded, the directory created; a per-call dir confined to
 * GEMINI_OUTPUT_DIR when that is set). A blank per-call value
 * counts as unset, so it falls through to the env var rather than to cwd.
 */
export function resolveOutputDir(perCall: string | undefined): string {
  // output_dir is model-chosen: once the operator sets GEMINI_OUTPUT_DIR, a
  // per-call directory must stay inside it (checked through symlinks). Unset
  // keeps the old, unconfined behaviour (the fleet pattern, as in splitwise-mcp).
  const configured = readEnvVar('GEMINI_OUTPUT_DIR');
  return resolveSharedOutputDir(perCall?.trim() || undefined, 'GEMINI_OUTPUT_DIR', {
    ...(configured ? { allowedRoots: [configured] } : {}),
  });
}
