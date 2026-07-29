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

/**
 * Where one persisted item ended up.
 *
 * `ref` is what the caller sees in `images`/`videos`/`audios`: an absolute path
 * on disk, or a **fetchable URL** on the hosted connector. It is never an
 * `r2://` object ref any more — those were honest about being unfetchable, but
 * honest-and-useless is still useless, and it left every hosted generation
 * invisible to the person who asked for it.
 *
 * `key`/`expiresAt` are populated only by object storage, and surface as
 * `media[].r2_key` / `media[].expires_at` so a caller can reason about
 * retention without parsing a URL.
 */
export interface PersistedMedia {
  ref: string;
  key?: string;
  expiresAt?: string;
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
  /** Persist each item, returning one record per item, in the same order. */
  persist(items: MediaItem[], opts: PersistOpts): Promise<PersistedMedia[]>;
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
      const refs: PersistedMedia[] = [];
      // Sequential on purpose: uniquePath checks the filesystem, so writing two
      // colliding names concurrently would race onto the same path.
      for (const it of items) refs.push({ ref: await writeMedia(dir, it.base, it.base64, it.mimeType) });
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
   * Public base URL for stored objects — an R2 public dev URL, or a custom
   * domain on the bucket. Objects there are served directly by R2, so the refs
   * are plain unsigned URLs.
   *
   * Leave it unset and the sink falls back to {@link signedBaseUrl}, the
   * connector's own `/media` route. That fallback is the zero-config path and
   * the normal case: `MEDIA_PUBLIC_BASE_URL` was never set in practice, and the
   * old behaviour — handing back `r2://bucket/key` — meant every hosted
   * generation was invisible to the person who asked for it.
   */
  publicBaseUrl?: string;
  /**
   * Base URL of the connector's own signed media route (`https://host/media`).
   * Used when `publicBaseUrl` is absent; requires {@link sign}.
   */
  signedBaseUrl?: string;
  /** Mints the `?exp=&sig=` pair for {@link signedBaseUrl}. */
  sign?: (key: string, expiresAtMs: number) => Promise<string>;
  /** How long a signed URL stays valid; also reported as `expires_at`. */
  urlTtlMs?: number;
  /** Bucket name, retained for diagnostics in the no-URL-available case. */
  bucketName?: string;
  /** Key prefix (default `gen`). */
  prefix?: string;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  randomId?: () => string;
}

// `gen`, not `media`: the objects are served at `/media/<key>`, and a `media`
// prefix would make every URL read `/media/media/…`.
const KEY_PREFIX_DEFAULT = 'gen';

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
  const publicBase = opts.publicBaseUrl?.replace(/\/+$/, '');
  const signedBase = opts.signedBaseUrl?.replace(/\/+$/, '');
  const ttlMs = opts.urlTtlMs ?? 0;

  return {
    kind: 'r2',
    persistsFiles: false,
    async persist(items, _opts) {
      // `mediaExt` is pure string work but lives in images.ts next to node:fs
      // imports; the dynamic import keeps that module off a Worker's eager
      // module graph.
      const { mediaExt } = await import('../images.js');
      const day = now().toISOString().slice(0, 10);
      const expiresAtMs = now().getTime() + ttlMs;
      const refs: PersistedMedia[] = [];
      for (const it of items) {
        const key = `${prefix}/${day}/${randomId()}-${safeKeySegment(it.base)}.${mediaExt(it.mimeType)}`;
        await bucket.put(key, base64ToBytes(it.base64), { httpMetadata: { contentType: it.mimeType } });
        refs.push(await describe(key, expiresAtMs));
      }
      return refs;
    },
    note: () =>
      publicBase
        ? 'Generated media was uploaded to R2 and the values above are public URLs (not local file paths) — open or download them directly. ' +
          'This hosted connector has no filesystem, so `output_dir` is ignored and no <image>.json sidecar is written — capture interaction_id from this result to chain further turns.'
        : signedBase
          ? 'Generated media is served by this connector at the signed URLs above — open them in a browser or fetch them with curl; no auth header is needed, the signature is in the link. ' +
            'They expire (see media[].expires_at), and the objects behind them are cleaned up on a retention schedule. ' +
            'This hosted connector has no filesystem, so `output_dir` is ignored and no <image>.json sidecar is written — capture interaction_id from this result to chain further turns.'
          : 'Generated media was stored, but this connector has no public media URL configured and no signing route available, so the values above are bare object keys rather than fetchable links. ' +
            'Set MEDIA_PUBLIC_BASE_URL on the Worker, or pass inline: true to receive the bytes directly.',
  };

  /** One stored object → the ref the caller sees, plus its key and expiry. */
  async function describe(key: string, expiresAtMs: number): Promise<PersistedMedia> {
    // A bucket served directly (r2.dev or a custom domain) needs no signature.
    if (publicBase) return { ref: `${publicBase}/${key}`, key };
    if (signedBase && opts.sign) {
      const { buildMediaUrl } = await import('../media-url.js');
      const signature = await opts.sign(key, expiresAtMs);
      return { ref: buildMediaUrl(signedBase, key, expiresAtMs, signature), key, expiresAt: new Date(expiresAtMs).toISOString() };
    }
    // Neither configured: say what we have rather than invent a URL that 404s.
    return { ref: key, key };
  }
}

