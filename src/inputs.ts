import { McpToolError } from '@chrischall/mcp-utils';
import type { GeminiClient, ImageInput } from './client.js';
import { IMAGE_INLINE_MAX_BYTES, fileNameFromUrl } from './fetch-image.js';
import { base64ToBytes, bytesToBase64 } from './bytes.js';

/**
 * The one place the four ways of naming a reference image converge.
 *
 * | Param              | Where the bytes are | Costs model context? |
 * |--------------------|---------------------|----------------------|
 * | `images`           | local disk (stdio)  | no                   |
 * | `images_base64`    | the tool-call JSON  | **yes — ~14k tokens per JPEG** |
 * | `images_url`       | a public https URL  | no (the server fetches) |
 * | `images_file_uris` | Gemini Files API    | no (a `files/…` ref) |
 * | `images_r2_keys`   | the connector's own store (hosted) | no (the server reads its bucket) |
 *
 * Everything downstream — `client.generate`, `client.interact`,
 * `generateVideo`, `generateMusic` — sees only {@link ImageInput}, so a new
 * input form is a change here and nowhere else.
 *
 * Two behaviours are worth knowing about because they cost an upstream call:
 *
 *  - A fetched URL over {@link IMAGE_INLINE_MAX_BYTES} is uploaded to the Files
 *    API and referenced by uri, because `generateContent` caps a whole request
 *    near 20 MB and two large inline references would fail the request itself.
 *  - On a filesystem-backed runtime, the SECOND time a session references the
 *    same local path (same mtime + size), it is uploaded once and referenced by
 *    uri from then on. The first reference stays inline: uploading a picture
 *    used once would add a round trip for nothing.
 */

/** Every image-input param a tool can accept, in one shape. */
export interface ImageInputArgs {
  /** Local file paths — filesystem runtimes only. */
  images?: string[];
  /** Raw base64 or `data:` URIs. */
  images_base64?: string[];
  /** Public https URLs the SERVER fetches. */
  images_url?: string[];
  /** Files API references (`files/<id>` or the full uri). */
  images_file_uris?: string[];
  /**
   * `r2_key`s of objects in the connector's OWN store — signed uploads
   * (`PUT /put`) and previously generated media. Hosted connector only: the
   * sink reads its own bucket (tenant-gated), so no bytes pass through the
   * conversation and no signature is needed.
   */
  images_r2_keys?: string[];
  /** macOS clipboard (stdio only). */
  from_clipboard?: boolean;
}

/** What a caller can echo back about how its inputs were resolved. */
export interface ImageInputReport {
  /** One entry per fetched URL, in order. */
  fetched_urls?: Array<{ url: string; mime_type: string; bytes: number; file_uri?: string }>;
  /** Files API references used as-is. */
  file_uris?: string[];
  /** Local paths promoted to a Files API upload on their repeat reference. */
  auto_uploaded?: Array<{ path: string; file_uri: string; expires?: string }>;
  /** Connector-store objects attached by `images_r2_keys`, in order.
   * `file_uri` is present when the object was large enough to be promoted to
   * a Files API reference instead of inlined. */
  r2_keys?: Array<{ r2_key: string; mime_type: string; bytes: number; file_uri?: string }>;
}

export interface ResolvedImageInputs {
  inputs: ImageInput[];
  /** Omitted entirely when nothing noteworthy happened (paths/base64 only). */
  report?: ImageInputReport;
}

/** True when this call carries at least one image input of any kind. */
export function hasImageInput(args: ImageInputArgs): boolean {
  return Boolean(
    args.images?.length ||
      args.images_base64?.length ||
      args.images_url?.length ||
      args.images_file_uris?.length ||
      args.images_r2_keys?.length ||
      args.from_clipboard,
  );
}

/** Conservative TTL when the API doesn't tell us: documented retention is ~48h. */
const ASSUMED_TTL_MS = 47 * 60 * 60 * 1000;

function expiresAtMs(expirationTime: string | undefined, now: number): number {
  if (expirationTime) {
    const t = Date.parse(expirationTime);
    if (Number.isFinite(t)) return t;
  }
  return now + ASSUMED_TTL_MS;
}

/**
 * Resolve every image input a tool was given into {@link ImageInput}s.
 *
 * Order is stable and matches the pre-`images_url` behaviour so existing calls
 * produce byte-identical requests: clipboard, then paths, then base64, then
 * fetched URLs, then Files API references.
 *
 * A URL repeated within one call is fetched ONCE. That is what lets
 * `gemini_image_set` hand the same reference to the master and all N scene
 * generations without paying for N downloads (or N uploads).
 */
export async function resolveImageInputs(args: ImageInputArgs, client: GeminiClient): Promise<ResolvedImageInputs> {
  const report: ImageInputReport = {};
  const inputs: ImageInput[] = [];
  const onDisk = client.mediaSink?.persistsFiles ?? true;

  // 1. clipboard (macOS, stdio only). Imported dynamically so `child_process`
  // stays off the default path — and off the Worker's module graph entirely.
  if (args.from_clipboard) {
    inputs.push(await (await import('./clipboard.js')).readClipboardImage());
  }

  // 2. local paths — inline, unless this session has seen the same file before.
  for (const path of args.images ?? []) {
    inputs.push(await resolveLocalPath(path, client, onDisk, report));
  }

  // 3. raw base64 / data URIs
  if (args.images_base64?.length) {
    const { decodeImageInput } = await import('./images.js');
    for (const b64 of args.images_base64) inputs.push(decodeImageInput(b64));
  }

  // 4. https URLs, fetched by the server. Deduped within the call.
  const fetched = new Map<string, ImageInput>();
  for (const url of args.images_url ?? []) {
    const hit = fetched.get(url);
    if (hit) { inputs.push(hit); continue; }
    const resolved = await resolveUrl(url, client, report);
    fetched.set(url, resolved);
    inputs.push(resolved);
  }

  // 5. Files API references — no bytes move at all.
  const seenUris = new Map<string, ImageInput>();
  for (const ref of args.images_file_uris ?? []) {
    const hit = seenUris.get(ref);
    if (hit) { inputs.push(hit); continue; }
    const file = await client.getFile(ref);
    const input: ImageInput = { uri: file.uri, mimeType: file.mimeType };
    seenUris.set(ref, input);
    (report.file_uris ??= []).push(file.name);
    inputs.push(input);
  }

  // 6. r2_keys — the connector reads its OWN store (tenant-gated), so a signed
  // upload or an earlier generation becomes a reference without a fetch, a
  // signature, or a byte in the conversation. Deduped within the call, same as
  // URLs, and — also same as URLs — a large object is promoted to a Files API
  // reference rather than inlined, because `generateContent` caps a whole
  // request near 20MB and two large inline references would fail it.
  // `readStoredMedia` throws an actionable error for a swept/foreign key.
  const seenKeys = new Map<string, ImageInput>();
  for (const key of args.images_r2_keys ?? []) {
    const hit = seenKeys.get(key);
    if (hit) { inputs.push(hit); continue; }
    const stored = await client.readStoredMedia(key);
    const entry: { r2_key: string; mime_type: string; bytes: number; file_uri?: string } = {
      r2_key: key.trim(),
      mime_type: stored.mimeType,
      bytes: stored.bytes.byteLength,
    };
    (report.r2_keys ??= []).push(entry);
    let input: ImageInput;
    if (stored.bytes.byteLength <= IMAGE_INLINE_MAX_BYTES) {
      input = { base64: bytesToBase64(stored.bytes), mimeType: stored.mimeType };
    } else {
      const displayName = key.trim().split('/').pop() || 'image';
      const uploaded = await client.uploadBytes(stored.bytes, stored.mimeType, displayName);
      entry.file_uri = uploaded.name;
      input = { uri: uploaded.uri, mimeType: uploaded.mimeType };
    }
    seenKeys.set(key, input);
    inputs.push(input);
  }

  return { inputs, report: Object.keys(report).length > 0 ? report : undefined };
}

/**
 * One local path → an inline input, or a Files API reference once this session
 * has referenced the same bytes more than once.
 *
 * Identity is path + mtime + size, so editing the file in place produces a new
 * key rather than silently reusing an upload of the old content.
 */
async function resolveLocalPath(
  path: string,
  client: GeminiClient,
  onDisk: boolean,
  report: ImageInputReport,
): Promise<ImageInput> {
  const { readImageAsInline, resolveImagePath } = await import('./images.js');
  // A runtime with no filesystem never gets here — `assertLocalInputsAvailable`
  // rejects `images` before any of this — but if it somehow did, reading the
  // file is what would fail, so keep the pre-existing error path.
  if (!onDisk) return readImageAsInline(path);

  const { stat } = await import('node:fs/promises');
  const resolved = resolveImagePath(path);
  let key: string | undefined;
  try {
    const { mtimeMs, size } = await stat(resolved);
    // NUL separator, written as the \u0000 ESCAPE and never a literal NUL
    // byte: a literal one makes git classify this whole file as binary and
    // stop diffing it (same trap as fingerprintRequest in jobs.ts). It cannot
    // occur in a path, so no crafted name can straddle a field boundary.
    key = `path\u0000${resolved}\u0000${mtimeMs}\u0000${size}`;
  } catch {
    // Unstattable but resolvable is odd; fall back to plain inline rather than
    // failing a call that would otherwise have worked.
    return readImageAsInline(path);
  }

  const cached = client.session.cachedUpload(key);
  if (cached) return { uri: cached.uri, mimeType: cached.mimeType };

  const references = client.session.countReference(key);
  const inline = await readImageAsInline(resolved);
  if (references < 2) return inline;

  // Second sighting: pay one upload now so every later reference is free.
  // Best-effort — an upload failure must not fail a call that inline handles
  // perfectly well.
  try {
    const bytes = base64ToBytes(inline.base64);
    const displayName = resolved.split(/[\\/]/).pop() || 'image';
    const uploaded = await client.uploadBytes(bytes, inline.mimeType, displayName);
    client.session.uploadCache.set(key, {
      name: uploaded.name,
      uri: uploaded.uri,
      mimeType: uploaded.mimeType,
      expiresAtMs: expiresAtMs(uploaded.expirationTime, Date.now()),
    });
    (report.auto_uploaded ??= []).push({ path: resolved, file_uri: uploaded.name, expires: uploaded.expirationTime });
    return { uri: uploaded.uri, mimeType: uploaded.mimeType };
  } catch {
    return inline;
  }
}

/** One https URL → inline bytes, or a Files API reference when it's large. */
async function resolveUrl(url: string, client: GeminiClient, report: ImageInputReport): Promise<ImageInput> {
  const fetched = await client.fetchRemoteImage(url);
  const entry: { url: string; mime_type: string; bytes: number; file_uri?: string } = {
    url,
    mime_type: fetched.mimeType,
    bytes: fetched.size,
  };
  (report.fetched_urls ??= []).push(entry);

  if (fetched.size <= IMAGE_INLINE_MAX_BYTES) {
    return { base64: bytesToBase64(fetched.bytes), mimeType: fetched.mimeType };
  }
  // 'image' here: this path is `images_url`, which only ever carries images.
  const displayName = fileNameFromUrl(url, 'image');
  const uploaded = await client.uploadBytes(fetched.bytes, fetched.mimeType, displayName);
  entry.file_uri = uploaded.name;
  return { uri: uploaded.uri, mimeType: uploaded.mimeType };
}

/**
 * Guard for tools that REQUIRE at least one reference image
 * (`gemini_image_edit`). Names every accepted param, in the order a caller
 * should prefer them — the context-free ones first.
 */
export function requireImageInput(args: ImageInputArgs): void {
  if (hasImageInput(args)) return;
  throw new McpToolError(
    'Provide at least one input image via `images_url` (an https URL the server fetches), `images_file_uris` ' +
      '(from gemini_upload_file), `images_r2_keys` (a hosted-connector upload or earlier generation), ' +
      '`images` (a local path), `images_base64`, or `from_clipboard`.',
  );
}
