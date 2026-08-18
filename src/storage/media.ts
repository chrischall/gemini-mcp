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
import { signedLinks, type SignedLinks } from '../signed-url.js';

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
  /**
   * Signed-URL lifetime override for THIS persist (object-storage sinks only;
   * the disk sink's paths never expire). Clamped to the sink's
   * {@link R2SinkOptions.maxUrlTtlMs} so a link can never outlive the object
   * behind it. Multi-image sets pass ~7 days here so a batch stays fetchable
   * for the whole retention window instead of the default ~48h.
   */
  urlTtlMs?: number;
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
  /**
   * Set when the object was stored but NO openable URL could be minted — a
   * misconfiguration, since the connector always supplies its own signed route.
   * The ref is then a bare object key, which is why this flag exists: a key
   * reads like a relative path in `images[]`, and silently handing one back is
   * the exact failure this whole change was written to end. Callers surface it
   * loudly instead of letting it pass for a filename.
   */
  unavailable?: boolean;
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
   * Read back something this sink stored. Object-storage sinks only.
   *
   * Lets a generated image become a reference image without a round trip
   * through HTTP: the server reads its own bucket rather than fetching its own
   * signed URL, which it cannot sign for itself from the outside.
   */
  read?(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
  /**
   * Mint a fresh reference for an object still in storage. Object-storage sinks
   * only. A signed URL expires long before the object does, so without this an
   * expired link is a dead end even though the bytes are still there.
   */
  resign?(key: string): Promise<PersistedMedia | undefined>;
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
  /** Present on a real R2 binding; optional so tests can supply a put-only fake. */
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
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
   *
   * Prefer {@link links}: passing the store's bound link shapes instead of a
   * bare base is what keeps this sink and the upload-URL minter pointed at the
   * same host.
   */
  signedBaseUrl?: string;
  /**
   * The store's link shapes (media GET and upload PUT bound to one base).
   * When present it — not {@link signedBaseUrl} — builds the URLs, and the
   * minter is handed the very same object, so the two cannot be re-pointed
   * independently by a re-host.
   */
  links?: SignedLinks;
  /** Mints the `?exp=&sig=` pair for {@link signedBaseUrl}. */
  sign?: (key: string, expiresAtMs: number) => Promise<string>;
  /** How long a signed URL stays valid; also reported as `expires_at`. */
  urlTtlMs?: number;
  /**
   * Hard ceiling on any signed URL's lifetime, including per-persist
   * {@link PersistOpts.urlTtlMs} overrides. The Worker passes the retention
   * window here (`MEDIA_TTL_DAYS`), so no override can mint a link that
   * outlives the object the retention cron will sweep.
   */
  maxUrlTtlMs?: number;
  /** Key prefix (default `gen`). */
  prefix?: string;
  /**
   * Key prefixes {@link MediaSink.read}/{@link MediaSink.resign} will serve IN
   * ADDITION to {@link prefix}, still tenant-gated (`<p>/<tenant>/…`). The
   * Worker lists `up` (signed uploads) and `lib` (the character library) so an
   * uploaded reference photo is readable by the session that uploaded it —
   * writes still go only under {@link prefix}.
   */
  readPrefixes?: string[];
  /**
   * Per-account namespace folded into every key
   * (`<prefix>/<tenant>/<date>/…`) and ENFORCED by {@link MediaSink.read} /
   * {@link MediaSink.resign}. The bucket is shared by every connector account
   * and an `r2_key` is not a secret (it rides in every result), so without
   * this a disclosed key would let any authenticated user read — and
   * indefinitely re-sign — another account's media, outliving both the link
   * expiry and a `MEDIA_URL_SECRET` rotation. Use {@link tenantIdFor} to
   * derive it from the session's API key. Unset (single-user tests) means no
   * namespace and no enforcement.
   */
  tenant?: string | (() => Promise<string> | string);
  /** Injectable for deterministic tests. */
  now?: () => Date;
  randomId?: () => string;
}

/** Stable, non-reversible short tenant id from a per-session secret. */
export async function tenantIdFor(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// `gen`, not `media`: the objects are served at `/media/<key>`, and a `media`
// prefix would make every URL read `/media/media/…`.
const KEY_PREFIX_DEFAULT = 'gen';

/** Object-key-safe name: no slashes, no dot-segments, never empty. */
export function safeKeySegment(base: string): string {
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
  const signedBase = opts.links?.base ?? opts.signedBaseUrl?.replace(/\/+$/, '');
  const ttlMs = opts.urlTtlMs ?? 0;

  const readPrefixes = [prefix, ...(opts.readPrefixes ?? [])];
  let tenantCache: Promise<string | undefined> | undefined;
  const tenantId = () =>
    (tenantCache ??= Promise.resolve(typeof opts.tenant === 'function' ? opts.tenant() : opts.tenant));
  /** `<prefix>/` or `<prefix>/<tenant>/` — where every WRITE goes. */
  const ownPrefix = async () => {
    const tenant = await tenantId();
    return tenant ? `${prefix}/${tenant}/` : `${prefix}/`;
  };
  /**
   * Ownership gate for caller-supplied keys: this session's own namespace
   * under any readable prefix (`gen/<tenant>/…`, plus e.g. `up/`/`lib/` on the
   * Worker). A foreign key is refused without touching storage, so the refusal
   * is indistinguishable from a swept object. With no tenant configured there
   * is nothing to enforce (single-user shapes).
   */
  const owned = async (key: string) => {
    if (!opts.tenant) return true;
    const tenant = await tenantId();
    return readPrefixes.some((p) => key.startsWith(`${p}/${tenant}/`));
  };

  return {
    kind: 'r2',
    persistsFiles: false,
    async read(key) {
      if (!bucket.get || !(await owned(key))) return undefined;
      const object = await bucket.get(key);
      if (!object) return undefined;
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        mimeType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
    async resign(key) {
      if (!(await owned(key))) return undefined;
      // Only for objects that still exist — re-signing a swept key would hand
      // back a link that 404s, which is no better than the expired one.
      if (bucket.get && !(await bucket.get(key))) return undefined;
      return describe(key, now().getTime() + ttlMs);
    },
    async persist(items, persistOpts) {
      // `mediaExt` is pure string work but lives in images.ts next to node:fs
      // imports; the dynamic import keeps that module off a Worker's eager
      // module graph.
      const { mediaExt } = await import('../images.js');
      const keyBase = await ownPrefix();
      const day = now().toISOString().slice(0, 10);
      // Per-persist TTL override, clamped so a link never outlives its object.
      const effectiveTtlMs = Math.min(persistOpts.urlTtlMs ?? ttlMs, opts.maxUrlTtlMs ?? Infinity);
      const expiresAtMs = now().getTime() + effectiveTtlMs;
      const refs: PersistedMedia[] = [];
      for (const it of items) {
        const key = `${keyBase}${day}/${randomId()}-${safeKeySegment(it.base)}.${mediaExt(it.mimeType)}`;
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
      const signature = await opts.sign(key, expiresAtMs);
      // `signedLinks` is the ONE shape-owner shared with the upload-URL minter
      // (src/signed-url.ts) — never hand-build the query here.
      const link = (opts.links ?? signedLinks(signedBase)).media(key, expiresAtMs, signature);
      return { ref: link, key, expiresAt: new Date(expiresAtMs).toISOString() };
    }
    // Neither configured. Unreachable in the Worker (which always passes its
    // own origin), so this is a misconfiguration rather than a mode — say so
    // explicitly rather than returning something that looks like a filename.
    return { ref: key, key, unavailable: true };
  }
}

