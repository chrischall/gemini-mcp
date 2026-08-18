/**
 * Media, uploads and the character library, backed by mcp-host's shared blob
 * store instead of a bucket binding of our own.
 *
 * This is what replaced the retired Cloudflare Worker connector. That Worker
 * owned an R2 bucket and served `/media`, `/put` and `/upload` itself; hosted
 * on mcp-host there is no Worker and no binding, but the platform offers the
 * same shape over signed HTTP:
 *
 *   PUT    <base>/<key>?exp=&sig=
 *   GET    <base>/<key>?exp=&sig=
 *   DELETE <base>/<key>?exp=&sig=
 *   GET    <base>/?prefix=&cursor=&limit=&exp=&sig=
 *
 * where `<base>` is `MCP_BLOB_BASE_URL` (`https://host/b/<registrationId>`) and
 * every signature is HMAC-SHA256 under `MCP_BLOB_SIGNING_KEY` — this
 * registration's own derived key, which can only ever produce signatures valid
 * under its own prefix.
 *
 * The existing seams do the rest: `createR2Sink` and `createR2Library` both
 * take a STRUCTURAL bucket, so the adapter below is all that was needed —
 * neither of them learns that storage moved.
 *
 * ## The signature covers the FULL key, not ours
 *
 * The gateway signs `<registrationId>/<key>`; we only ever think in `<key>`.
 * The prefix is recovered from the base URL's own path (everything after
 * `/b/`), so there is exactly one place that knows the difference and the rest
 * of this repo keeps using relative keys.
 *
 * ## The four payload shapes must match the gateway byte for byte
 *
 * They also happen to be the shapes this MCP's own connector used, which is why
 * media links minted before the migration still resolve. Do not "tidy" them.
 */

import { signedLinks, type SignedLinks } from './signed-url.js';

const READ = (key: string, exp: number) => `${key}\n${exp}`;
const WRITE = (key: string, ct: string, exp: number) => `put\0${key}\0${ct}\0${exp}`;
/**
 * A write the host's retention prune must never reclaim. `lib/` only: a saved
 * character or style outlives every signed URL and every upload, which is why
 * saving COPIES the image bytes rather than pointing at `gen/`. The retired
 * connector's own cleanup skipped this prefix for the same reason.
 */
const WRITE_PERMANENT = (key: string, ct: string, exp: number) => `putp\0${key}\0${ct}\0${exp}`;
const DELETE = (key: string, exp: number) => `del\0${key}\0${exp}`;
const LIST = (prefix: string, exp: number) => `list\0${prefix}\0${exp}`;

/** The library's key prefix — the one thing written to outlive retention. */
const PERMANENT_PREFIX = 'lib';

/** Default life of a signed link. The gateway refuses anything over 24h. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url');
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

/**
 * The key-space prefix out of `https://host/b/<registrationId>` — what the
 * gateway folds into every signature. Whatever follows `/b/`, so this does not
 * care how many segments the host uses.
 */
export function prefixFromBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // This runs at module scope (client.ts builds its singleton eagerly), so a
    // stale or half-substituted value does not fail a request — it stops the
    // server booting. `TypeError: Invalid URL`, thrown from a stack with no
    // mention of storage, is a miserable thing to debug from a host's logs;
    // name the variable and the value instead. Still a throw: a store nobody
    // can address is not something to degrade quietly around, because media,
    // the library and signed uploads would all silently vanish.
    throw new Error(
      `MCP_BLOB_BASE_URL is not a valid URL (got ${JSON.stringify(baseUrl)}). ` +
        'It should look like https://<host>/b/<registrationId> — check the deployment\'s environment.',
    );
  }
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const marker = path.startsWith('b/') ? path.slice(2) : path;
  return marker;
}

export interface BlobStoreOptions {
  baseUrl: string;
  signingKey: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

/**
 * One object store over the signed HTTP API, satisfying BOTH `MediaBucket`
 * (put/get) and `LibraryBucket` (put/get/delete/list). They are structurally
 * compatible, so one adapter serves both rather than two that can drift.
 */
export function createBlobBucket(opts: BlobStoreOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const prefix = prefixFromBaseUrl(base);
  const doFetch = opts.fetchImpl ?? fetch;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  const full = (key: string) => `${prefix}/${key}`;
  const encode = (key: string) => key.split('/').map(encodeURIComponent).join('/');

  async function signedUrl(key: string, payload: string, exp: number): Promise<string> {
    const sig = await hmac(opts.signingKey, payload);
    return `${base}/${encode(key)}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
  }

  return {
    /** Exposed so the media sink can mint read links with the same key. */
    async signRead(key: string, expiresAtMs: number): Promise<string> {
      return hmac(opts.signingKey, READ(full(key), expiresAtMs));
    },
    async signWrite(key: string, contentType: string, expiresAtMs: number): Promise<string> {
      return hmac(opts.signingKey, WRITE(full(key), contentType, expiresAtMs));
    },

    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown> {
      const contentType = options?.httpMetadata?.contentType ?? 'application/octet-stream';
      const exp = now() + ttl;
      // The library is permanent; generated media and uploads are not. The
      // prefix IS the distinction, and it is ours to know — the host has no
      // idea what `lib/` means, it only enforces what was signed.
      const permanent = key.startsWith(`${PERMANENT_PREFIX}/`);
      const payload = permanent
        ? WRITE_PERMANENT(full(key), contentType, exp)
        : WRITE(full(key), contentType, exp);
      const url = (await signedUrl(key, payload, exp)) + (permanent ? '&retain=permanent' : '');
      const body: BodyInit = typeof value === 'string' ? value : toArrayBuffer(value);
      const res = await doFetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
      if (!res.ok) throw new Error(`blob put failed (${res.status}) for ${key}`);
      return undefined;
    },

    async get(key: string) {
      const exp = now() + ttl;
      const url = await signedUrl(key, READ(full(key), exp), exp);
      const res = await doFetch(url);
      // A missing object is `null`, not a throw: both callers treat absence as
      // a normal outcome (a swept media object, an unknown character name).
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`blob get failed (${res.status}) for ${key}`);
      const buf = await res.arrayBuffer();
      return {
        arrayBuffer: async () => buf,
        httpMetadata: { contentType: res.headers.get('content-type') ?? undefined },
      };
    },

    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const exp = now() + ttl;
        const url = await signedUrl(key, DELETE(full(key), exp), exp);
        const res = await doFetch(url, { method: 'DELETE' });
        // The gateway's delete is idempotent, so only a real failure throws.
        if (!res.ok && res.status !== 404) {
          throw new Error(`blob delete failed (${res.status}) for ${key}`);
        }
      }
    },

    async list(options: { prefix?: string; cursor?: string; limit?: number }) {
      const rel = options.prefix ?? '';
      const exp = now() + ttl;
      const sig = await hmac(opts.signingKey, LIST(rel, exp));
      const params = new URLSearchParams({ exp: String(exp), sig });
      if (rel) params.set('prefix', rel);
      if (options.cursor) params.set('cursor', options.cursor);
      if (options.limit) params.set('limit', String(options.limit));
      const res = await doFetch(`${base}/?${params}`);
      if (!res.ok) throw new Error(`blob list failed (${res.status})`);
      // Keys come back relative to this registration's space, which is exactly
      // the key space the library already thinks in.
      return (await res.json()) as {
        objects: Array<{ key: string }>;
        truncated: boolean;
        cursor?: string;
      };
    },
  };
}

/** A standalone ArrayBuffer copy — `fetch` bodies will not take a view. */
function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return view.slice().buffer as ArrayBuffer;
}

export type BlobBucket = ReturnType<typeof createBlobBucket>;

/**
 * Reads the environment mcp-host injects and, when it is there, builds
 * everything that depends on having somewhere to put bytes.
 *
 * Returns `undefined` when the deployment has no blob store — which is the
 * normal case for a local stdio install, and MUST stay a clean degrade rather
 * than a half-configured client: the disk sink takes over, and the library and
 * upload-URL tools simply do not register.
 */
export interface BlobStore {
  bucket: BlobBucket;
  baseUrl: string;
  /**
   * Both link shapes for this store, bound to {@link baseUrl} once.
   *
   * Media GETs and upload PUTs are the same store reached two ways, and every
   * consumer takes THIS rather than the base URL, so there is no longer a
   * second place to update when the host moves. The re-host to mcp-host
   * updated the media builder's base and left the upload builder holding its
   * own — the split this exists to make impossible.
   */
  links: SignedLinks;
  signRead: (key: string, expiresAtMs: number) => Promise<string>;
  signWrite: (key: string, contentType: string, expiresAtMs: number) => Promise<string>;
}

/**
 * Synchronous on purpose: `client.ts` calls this while building its
 * module-level singleton, and a top-level `await` there would put one in every
 * consumer's module graph for something that is pure string work.
 */
export function blobStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<BlobStoreOptions> = {},
): BlobStore | undefined {
  const baseUrl = overrides.baseUrl ?? env.MCP_BLOB_BASE_URL;
  const signingKey = overrides.signingKey ?? env.MCP_BLOB_SIGNING_KEY;
  if (!baseUrl || !signingKey) return undefined;
  const bucket = createBlobBucket({ ...overrides, baseUrl, signingKey });
  return { bucket, baseUrl, links: signedLinks(baseUrl), signRead: bucket.signRead, signWrite: bucket.signWrite };
}
