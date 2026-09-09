/**
 * Where generated media goes.
 *
 * The stdio server writes images/video/audio to the local filesystem. The
 * hosted connector runs on a remote machine with **no access to the caller's
 * filesystem** — no
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
   * Recently generated objects belonging to THIS session, newest first.
   *
   * Object-storage sinks only — the disk sink has an output directory, which is
   * already a better version of this.
   *
   * Exists for the case where a result was lost rather than never produced: a
   * background job killed with its machine (see `src/job-store.ts`) still wrote
   * its images, but every reference to them died with the response. Without a
   * listing those bytes are unreachable and the only recourse is to pay for the
   * generation again.
   */
  listRecent?(opts: { limit?: number; sinceDay?: string }): Promise<RecentMedia[]>;
  /**
   * As {@link listRecent}, but reporting whether the walk actually reached the
   * end of the key space.
   *
   * The walk is bounded, so on a large bucket the answer is a SUBSET — and a
   * subset presented as "your recent media, newest first" is exactly how
   * someone concludes an image is gone and pays to generate it again. The tool
   * surfaces this flag rather than letting a cap pass for completeness.
   */
  listRecentPage?(opts: { limit?: number; sinceDay?: string }): Promise<{ media: RecentMedia[]; truncated: boolean; scannedPages: number }>;
  /**
   * Record what produced a stored object, beside the object itself.
   *
   * The hosted answer to the `<image>.json` sidecar. On disk that file is what
   * makes a lost response survivable — the interaction id outlives the
   * response, so a chain can be continued and a chained 404 can be re-anchored
   * on the image the dead interaction actually made. Without it the hosted
   * deployment loses the id the moment a response is dropped, which is the
   * failure the disk build was hardened against.
   *
   * Best-effort and never throws: a record that fails to write must not fail
   * the generation it describes. Absent on the disk sink, which writes real
   * sidecars through `onWritten` instead.
   */
  writeSidecar?(key: string, record: MediaSidecar): Promise<void>;
  /**
   * The stored object a given interaction produced, by id.
   *
   * Matched on the id ONLY, never "the newest object": re-anchoring an edit on
   * the wrong picture corrupts it silently, so an unknown id comes back
   * undefined and the caller rethrows rather than guessing.
   */
  findByInteraction?(interactionId: string): Promise<RecentMedia | undefined>;
  /**
   * The most recent interaction id this store has a record for — the hosted
   * twin of `latestInteractionId` over the output dir. Backs `continue_last`
   * across a restart, where the in-memory id is gone but the interaction
   * itself is still alive upstream.
   */
  latestInteractionId?(): Promise<string | undefined>;
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
  /** Present on the blob store; backs {@link MediaSink.listRecent}. */
  list?(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size?: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/** One stored object, as {@link MediaSink.listRecent} reports it. */
export interface RecentMedia {
  key: string;
  /** The `YYYY-MM-DD` the object key was written under. */
  day: string;
  /** The human-meaningful part of the filename, without the random id or extension. */
  name: string;
  sizeBytes?: number;
  /** A freshly-signed, openable link. */
  url?: string;
  expiresAt?: string;
  /** From the object's sidecar record, when it has one (see MediaSink.writeSidecar). */
  interactionId?: string;
  prompt?: string;
  model?: string;
  createdAt?: string;
}

/**
 * What a hosted sidecar records. The disk build writes the same shape as
 * `<image>.json`; this is its object-store twin.
 */
export interface MediaSidecar {
  interaction_id?: string;
  prompt?: string;
  model?: string;
  /** ISO timestamp, filled in by the sink. */
  created?: string;
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

/**
 * How many listing pages one `listRecent` call will walk. A listing walk is
 * unbounded work and this runs on a tool call, so it is capped — and the cap
 * is REPORTED (see `listRecentPage`) rather than silently truncating.
 */
const MAX_LIST_PAGES = 10;

/**
 * Split a stored key back into the day it was written and the name it was asked
 * for — the inverse of the key format `persist` builds.
 *
 * `undefined` for anything that is not a dated object key, so a stray object
 * under the prefix is skipped rather than turned into a listing failure.
 */
function parseMediaKey(key: string, prefix: string): { day: string; name: string } | undefined {
  const rest = key.slice(prefix.length);
  const match = /^(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(rest);
  if (!match) return undefined;
  // Drop the random id `persist` prepends and the extension, leaving the
  // caller's own slug — which is what makes a listing recognisable to a human
  // looking for "the summer camp ones".
  const name = match[2].replace(/^[0-9a-f]{4,}-/i, '').replace(/\.[A-Za-z0-9]+$/, '');
  return { day: match[1], name: name || match[2] };
}

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
 * Suffix that turns a media key into its sidecar's key. Beside the object, not
 * under a prefix of its own, so one retention sweep covers both.
 */
const SIDECAR_SUFFIX = '.json';

/**
 * How far back `findByInteraction` looks. A chain being re-anchored is by
 * definition recent, and an unbounded scan on a tool call is its own failure.
 */
const MAX_INTERACTION_SCAN = 200;

/** Longest prompt a sidecar keeps. Enough to recognise, not to reproduce. */
const SIDECAR_PROMPT_MAX = 500;

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
    async listRecent(opts = {}) {
      return (await this.listRecentPage!(opts)).media;
    },
    async listRecentPage({ limit = 20, sinceDay } = {}) {
      if (!bucket.list) return { media: [], truncated: false, scannedPages: 0 };
      // Scoped at the STORE, not filtered afterwards: asking only for our own
      // prefix means another account's keys are never in hand to leak by a
      // filtering mistake.
      const prefix = await ownPrefix();
      const found: RecentMedia[] = [];
      const sidecarKeys = new Set<string>();
      let cursor: string | undefined;
      let truncated = false;
      let scannedPages = 0;
      // Bounded: a listing walk is unbounded work, and this runs on a tool call.
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        scannedPages = page + 1;
        const listed = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const obj of listed.objects) {
          // A sidecar shares its media's key plus a suffix, so it lands in this
          // same listing. It is metadata, not a generation: offering one as
          // "recent media" would hand back a JSON blob to look at.
          if (obj.key.endsWith(SIDECAR_SUFFIX)) { sidecarKeys.add(obj.key); continue; }
          const parsed = parseMediaKey(obj.key, prefix);
          if (!parsed) continue; // not a dated object key — skip, never throw
          if (sinceDay && parsed.day < sinceDay) continue;
          found.push({ ...parsed, key: obj.key, ...(obj.size !== undefined ? { sizeBytes: obj.size } : {}) });
        }
        if (!listed.truncated || !listed.cursor) break;
        cursor = listed.cursor;
        // Ran out of budget with more to read: the answer is a subset, and
        // must say so rather than passing for the whole picture.
        if (page === MAX_LIST_PAGES - 1) truncated = true;
      }
      // Keys sort lexicographically by day, and the id after it is random, so
      // ordering is by day — which is the honest grain: the store records no
      // per-object timestamp we could do better with.
      found.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.key < b.key ? 1 : -1));
      const page = found.slice(0, limit);
      const expiresAtMs = now().getTime() + ttlMs;
      const media = await Promise.all(
        page.map(async (entry) => {
          const link = await describe(entry.key, expiresAtMs);
          // Only for objects the walk actually saw a record for — a media entry
          // with no sidecar (everything generated before they existed, and
          // anything whose write failed) keeps its place in the listing and
          // simply carries no metadata.
          const record = sidecarKeys.has(`${entry.key}${SIDECAR_SUFFIX}`) ? await readSidecar(entry.key) : undefined;
          return {
            ...entry,
            ...(link.unavailable ? {} : { url: link.ref, expiresAt: link.expiresAt }),
            ...(record?.interaction_id ? { interactionId: record.interaction_id } : {}),
            ...(record?.prompt ? { prompt: record.prompt } : {}),
            ...(record?.model ? { model: record.model } : {}),
            ...(record?.created ? { createdAt: record.created } : {}),
          };
        }),
      );
      return { media, truncated: truncated || found.length > limit, scannedPages };
    },
    /**
     * `<mediaKey>.json`, deliberately beside the object rather than under a
     * prefix of its own: the retention sweep that removes the image removes its
     * record with it, so a sidecar can never outlive the thing it describes.
     * `parseMediaKey` skips it, so a listing never offers one as media.
     */
    async writeSidecar(key, record) {
      try {
        if (!(await owned(key))) return;
        const body = new TextEncoder().encode(JSON.stringify({
          ...record,
          // Capped: a record exists to identify a generation later, not to
          // store the brief. An 8k prompt would put more bytes in metadata than
          // some images have, on every single object.
          ...(record.prompt ? { prompt: record.prompt.slice(0, SIDECAR_PROMPT_MAX) } : {}),
          created: now().toISOString(),
        }));
        await bucket.put(`${key}${SIDECAR_SUFFIX}`, body, { httpMetadata: { contentType: 'application/json' } });
      } catch {
        // Best-effort by design: the generation is the job, and a record that
        // fails to write must not fail the image it describes.
      }
    },
    async latestInteractionId() {
      const { media } = await this.listRecentPage!({ limit: MAX_INTERACTION_SCAN });
      // `media` is newest-first, so the first record with an id is the answer.
      return media.find((m) => m.interactionId)?.interactionId;
    },
    async findByInteraction(interactionId) {
      const wanted = interactionId.trim();
      if (!wanted) return undefined;
      // The listing already carries every record, so this is a scan over what
      // listRecentPage read rather than a second walk of the store.
      const { media } = await this.listRecentPage!({ limit: MAX_INTERACTION_SCAN });
      return media.find((m) => m.interactionId === wanted);
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

  /** A stored object's sidecar record, or undefined — never a throw. */
  async function readSidecar(key: string): Promise<MediaSidecar | undefined> {
    try {
      const obj = await bucket.get?.(`${key}${SIDECAR_SUFFIX}`);
      if (!obj) return undefined;
      return JSON.parse(new TextDecoder().decode(new Uint8Array(await obj.arrayBuffer()))) as MediaSidecar;
    } catch {
      // A malformed or unreadable record is the same as none: this decorates a
      // listing, and a listing that throws is worse than one without prompts.
      return undefined;
    }
  }

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

