/**
 * Where generated media goes.
 *
 * The stdio server writes images/video/audio to the local filesystem. The
 * hosted connector (a Cloudflare Worker) has **no filesystem at all** — no
 * `writeFile`, no output dir, and therefore no `<image>.json` sidecar — so it
 * puts objects into an R2 bucket and hands back URLs instead of paths.
 *
 * `emit()` / `emitMedia()` (tools/shared.ts) route every byte through one of
 * these, so the tool handlers themselves stay transport-neutral. The disk sink
 * is a thin wrapper over the pre-existing `resolveOutputDir` + `writeMedia`
 * behaviour and must stay byte-for-byte equivalent to it.
 */

import { base64ToBytes } from '../bytes.js';

/** One generated item to persist: raw base64 bytes plus the name to store it under. */
export interface MediaItem {
  /** Base filename / object name, WITHOUT an extension (the MIME picks that). */
  base: string;
  base64: string;
  mimeType: string;
}

/** Per-call options a sink may honour. `output_dir` is disk-only. */
export interface PersistOpts {
  /** Local output directory (disk sink only; ignored where there is no disk). */
  output_dir?: string;
}

export interface MediaSink {
  /** `'disk'` (stdio) or `'r2'` (hosted connector) — surfaced in result meta. */
  readonly kind: 'disk' | 'r2';
  /**
   * Whether this runtime has a real filesystem.
   *
   * True → refs returned by {@link persist} are absolute local paths, sidecars
   * can be written next to them, and *local-path inputs* (`images`,
   * `video_path`, `from_clipboard`) are available.
   *
   * False → refs are URLs/object refs, and every disk-backed feature above is
   * genuinely unavailable. Callers MUST gate on this rather than claiming a
   * sidecar or a written path that does not exist.
   */
  readonly persistsFiles: boolean;
  /** Persist each item, returning one ref per item, in the same order. */
  persist(items: MediaItem[], opts: PersistOpts): Promise<string[]>;
  /**
   * One-line, honest description of where the refs point — echoed into the
   * result payload so the caller is never left guessing whether it got a path,
   * a fetchable URL, or an opaque object ref. `undefined` for the disk sink,
   * whose absolute paths speak for themselves (and whose result shape must not
   * change).
   */
  note(): string | undefined;
}

/**
 * The stdio sink: `resolveOutputDir(output_dir)` → `writeMedia` per item, in
 * order (so `uniquePath`'s `name`/`name-2`/`name-3` sequencing is preserved).
 *
 * `node:fs` is reached through a dynamic import so this module stays loadable
 * in a Worker, where the R2 sink is the only one ever constructed.
 */
export function createDiskSink(): MediaSink {
  return {
    kind: 'disk',
    persistsFiles: true,
    async persist(items, opts) {
      const { writeMedia, resolveOutputDir } = await import('../images.js');
      const dir = resolveOutputDir(opts.output_dir);
      const refs: string[] = [];
      // Sequential on purpose: uniquePath checks the filesystem, so writing two
      // colliding names concurrently would race onto the same path.
      for (const it of items) refs.push(await writeMedia(dir, it.base, it.base64, it.mimeType));
      return refs;
    },
    note: () => undefined,
  };
}

/** The slice of R2's `put` this module uses — structural so tests can fake it. */
export interface MediaBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface R2SinkOptions {
  /**
   * Public base URL of the bucket (R2 public dev URL or a custom domain), no
   * trailing slash. Set it and refs are fetchable `https://…` URLs. Leave it
   * unset and refs are `r2://<bucket>/<key>` — deliberately NOT an https URL,
   * because an unconfigured private bucket has none, and inventing one would
   * hand the caller a link that 404s.
   */
  publicBaseUrl?: string;
  /** Bucket name, used only to build the `r2://` ref when no public URL is set. */
  bucketName?: string;
  /** Key prefix (default `media`). */
  prefix?: string;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  randomId?: () => string;
}

const KEY_PREFIX_DEFAULT = 'media';

/** Object-key-safe name: no slashes, no dot-segments, never empty. */
function safeKeySegment(base: string): string {
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'media';
}

/**
 * The hosted-connector sink: one R2 object per generated item.
 *
 * Keys are `<prefix>/<YYYY-MM-DD>/<random>-<base>.<ext>`. The random component
 * is what guarantees uniqueness — R2 `put` overwrites silently, so unlike the
 * disk sink there is no "does it already exist" probe to lean on.
 */
export function createR2Sink(bucket: MediaBucket, opts: R2SinkOptions): MediaSink {
  const prefix = opts.prefix ?? KEY_PREFIX_DEFAULT;
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => crypto.randomUUID().slice(0, 8));
  const base = opts.publicBaseUrl?.replace(/\/+$/, '');

  return {
    kind: 'r2',
    persistsFiles: false,
    async persist(items, _opts) {
      // `mediaExt` is pure string work but lives in images.ts next to node:fs
      // imports; the dynamic import keeps that module off a Worker's eager
      // module graph.
      const { mediaExt } = await import('../images.js');
      const day = now().toISOString().slice(0, 10);
      const refs: string[] = [];
      for (const it of items) {
        const key = `${prefix}/${day}/${randomId()}-${safeKeySegment(it.base)}.${mediaExt(it.mimeType)}`;
        const bytes = base64ToBytes(it.base64);
        await bucket.put(key, bytes, { httpMetadata: { contentType: it.mimeType } });
        refs.push(base ? `${base}/${key}` : `r2://${opts.bucketName ?? 'media'}/${key}`);
      }
      return refs;
    },
    note: () =>
      base
        ? 'Generated media was uploaded to R2; the values above are public URLs, not local file paths. ' +
          'This hosted connector has no filesystem, so `output_dir` is ignored and no <image>.json sidecar is written — capture interaction_id from this result to chain further turns.'
        : 'Generated media was uploaded to R2, which is not publicly served: the values above are object refs (r2://bucket/key), NOT fetchable URLs. ' +
          'Set MEDIA_PUBLIC_BASE_URL on the Worker to get URLs, or pass inline: true to receive the bytes directly. ' +
          'This hosted connector has no filesystem, so `output_dir` is ignored and no <image>.json sidecar is written — capture interaction_id from this result to chain further turns.',
  };
}
