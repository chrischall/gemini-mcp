/**
 * Short-lived signed PUT URLs — how reference bytes get INTO the connector
 * without either base64 through the model's context or an OAuth bearer token.
 *
 * The problem these solve is the mirror image of `/media`: a signed GET lets a
 * shell *download* generated media with no auth header, but uploading a
 * reference photo still required `images_base64` (~14k tokens per JPEG, silently
 * corrupting on a truncated read) or `POST /upload` (which 401s from any shell
 * that doesn't hold the MCP session's bearer token). A signed PUT URL closes
 * that gap: the authenticated MCP session mints it, and then a bare
 * `curl -X PUT --data-binary @photo.jpg "<url>"` stores the bytes.
 *
 * Same HMAC secret as the media GET URLs, but a DIFFERENT payload shape, so the
 * two kinds of signature can never be replayed across protocols:
 *
 *  - media GET signs   `<key>\n<exp>`             (media-url.ts — do not change;
 *    every outstanding link was signed with that exact shape)
 *  - upload PUT signs  `put\0<key>\0<ct>\0<exp>`  (NUL separators)
 *
 * A media payload always contains a `\n` and never a NUL (the sink sanitises
 * every key segment it mints); an upload payload always contains NULs and
 * never a `\n` — the endpoint refuses keys and content types outside a strict
 * charset (no whitespace, no control characters) BEFORE verifying, so no
 * crafted value can straddle a field boundary and no byte string is valid
 * under both interpretations in either direction.
 *
 * The signature also covers the content type, so the uploaded object's stored
 * MIME is exactly what the mint call declared — a URL minted for `image/jpeg`
 * cannot be used to store `text/html`.
 *
 * Like media-url.ts, this module is WebCrypto-only and free of any Cloudflare
 * import so it tests under Node.
 */

import { base64UrlEncode, base64UrlDecode } from './media-url.js';
import { signedLinks, type SignedLinks } from './signed-url.js';
import { safeKeySegment } from './storage/media.js';

/** How long a minted upload URL stays usable. Deliberately short — it exists to
 * be curled within the same conversation turn that minted it. */
export const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;

/** Upload size cap enforced by the PUT endpoint (while reading, not from the
 * declared length alone). Matches the `images_url` fetch cap — a reference
 * photo, not an archive. */
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

/** Key prefix for signed uploads: `up/<tenant>/<date>/<random>-<name>`. Swept
 * by the retention cron like generated media (`gen/`); the character library
 * (`lib/`) is where anything meant to be permanent gets copied. */
export const UPLOAD_KEY_PREFIX = 'up';

/**
 * The bytes an upload signature covers: method, object key, content type,
 * expiry. NUL separators, written as the \u0000 ESCAPE and never a literal NUL
 * byte — a literal one makes git classify this whole file as binary and stop
 * diffing it (the same trap as fingerprintRequest in jobs.ts, and exactly how
 * this security-critical module briefly shipped unreviewable). No crafted
 * value can straddle a field boundary: the endpoint enforces a control-free
 * charset on the key and content type before verifying (see
 * `wellFormedUploadKey` / `acceptableUploadType`).
 */
function payload(key: string, contentType: string, expiresAtMs: number): Uint8Array {
  return new TextEncoder().encode(`put\u0000${key}\u0000${contentType.toLowerCase()}\u0000${expiresAtMs}`);
}

/** Sign one upload: this key, this content type, until `expiresAtMs`. */
export async function signUploadKey(signingKey: CryptoKey, key: string, contentType: string, expiresAtMs: number): Promise<string> {
  return base64UrlEncode(await crypto.subtle.sign('HMAC', signingKey, payload(key, contentType, expiresAtMs) as BufferSource));
}

/**
 * Check a `?ct=&exp=&sig=` triple against an object key. Same contract as
 * `verifyMediaSignature`: constant-time comparison via `crypto.subtle.verify`,
 * and signature validity is checked before expiry so a forgery is never
 * confirmed as "merely expired".
 */
export async function verifyUploadSignature(
  signingKey: CryptoKey,
  key: string,
  contentType: string | null,
  exp: string | null,
  sig: string | null,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'expired' | 'invalid' }> {
  if (!contentType || !exp || !sig) return { ok: false, reason: 'missing' };
  const expiresAtMs = Number(exp);
  if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: 'invalid' };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', signingKey, base64UrlDecode(sig) as BufferSource, payload(key, contentType, expiresAtMs) as BufferSource);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!valid) return { ok: false, reason: 'invalid' };
  if (nowMs > expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * `<base>/<key>?ct=…&exp=…&sig=…` — the URL handed back by the mint tool.
 *
 * Delegates to {@link signedLinks}, the single shape-owner it shares with
 * `buildMediaUrl`. Prefer passing a {@link SignedLinks} into
 * {@link createUploadUrlMinter} (`links`) over a bare `baseUrl`: a store handed
 * to the sink and the minter as one object cannot be re-pointed for one and
 * not the other, which is precisely how the re-host broke this flow.
 */
export function buildUploadUrl(baseUrl: string, key: string, contentType: string, expiresAtMs: number, signature: string): string {
  return signedLinks(baseUrl).upload(key, contentType, expiresAtMs, signature);
}

/** What `gemini_get_upload_url` hands back, ready to echo to the caller. */
export interface MintedUploadUrl {
  url: string;
  key: string;
  contentType: string;
  expiresAtMs: number;
}

/**
 * Mints upload URLs for one authenticated session. Injected into the client by
 * the Worker (`buildClient`), absent on stdio — its presence is what gates the
 * `gemini_get_upload_url` tool, exactly as `mediaSink.resign` gates
 * `gemini_sign_media`.
 */
export interface UploadUrlMinter {
  mint(filename: string, contentType: string): Promise<MintedUploadUrl>;
}

export interface UploadUrlMinterOptions {
  /**
   * The store's link shapes, media GET and upload PUT together. Pass THIS in
   * preference to {@link baseUrl}: one object bound to one base is what stops a
   * re-host from moving the media links and leaving the upload links behind.
   */
  links?: SignedLinks;
  /**
   * Base URL of the signed PUT route, when the caller has only a string.
   * Ignored when {@link links} is given. Exactly one of the two is required —
   * neither, and the minter throws at CONSTRUCTION rather than handing back a
   * `undefined/up/…` URL at mint time.
   */
  baseUrl?: string;
  /** Mints the signature — hosted, this is the blob store's `signWrite`. */
  sign: (key: string, contentType: string, expiresAtMs: number) => Promise<string>;
  /** Per-account namespace, same value the media sink uses (`tenantIdFor`). */
  tenant: string | (() => Promise<string> | string);
  ttlMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  randomId?: () => string;
}

/**
 * RASTER image types only — an explicit allowlist, not `image/*`.
 *
 * The wildcard admitted `image/svg+xml`, and an SVG is a *document*: scripts
 * inside it execute when a browser opens the `/media` link, which serves from
 * the SAME ORIGIN as the connector's OAuth pages — stored XSS. Everything on
 * this list is pure pixels, and it covers what Gemini accepts as reference
 * input. `/media` also sends a no-script CSP as defense in depth, but the
 * allowlist is the primary gate: don't widen it to a wildcard again.
 *
 * Shared by the mint tool's schema, the PUT endpoint, and the library's
 * image sources (`gemini_save_character` / `_style`), so the gate cannot
 * drift between the front door and the side doors.
 */
export const RASTER_IMAGE_TYPE_PATTERN = /^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp|tiff)$/i;

/** True for the MIME types a signed upload will store: raster images only. */
export function acceptableUploadType(contentType: string): boolean {
  return RASTER_IMAGE_TYPE_PATTERN.test(contentType);
}

/**
 * Build the minter. Keys are `up/<tenant>/<YYYY-MM-DD>/<random>-<safe-name>` —
 * tenant-scoped at MINT time, which is what "scoped to the account that minted
 * it" means mechanically: the signature only ever covers a key inside this
 * session's own namespace, so a signed PUT cannot write into anyone else's.
 */
export function createUploadUrlMinter(opts: UploadUrlMinterOptions): UploadUrlMinter {
  // Fail at construction, not at mint. A minter built without somewhere to
  // point is not a degraded minter, it is a broken one — and the symptom it
  // used to produce (a URL reading `undefined/up/…`, or one pointing at a host
  // that no longer exists) is unreadable from the client side. This is the
  // "mint-with-missing-env fails loudly and atomically" guarantee: it throws
  // before any key is derived and long before anything could be written, and
  // the tool simply does not register.
  const links = opts.links ?? (opts.baseUrl ? signedLinks(opts.baseUrl) : undefined);
  if (!links) {
    throw new Error(
      'createUploadUrlMinter requires `links` (preferred) or `baseUrl`: there is nowhere to point a signed upload URL. ' +
        'Hosted, both come from the blob store — check MCP_BLOB_BASE_URL is set on the deployment.',
    );
  }
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => crypto.randomUUID().slice(0, 8));
  const ttlMs = opts.ttlMs ?? UPLOAD_URL_TTL_MS;
  return {
    async mint(filename, contentType) {
      const ct = contentType.trim().toLowerCase();
      if (!acceptableUploadType(ct)) {
        throw new Error(
          `content_type must be a raster image type (image/jpeg, image/png, image/webp, image/gif, image/avif, image/heic, image/heif, image/bmp, image/tiff), got "${contentType}". ` +
            'SVG is deliberately not accepted: it can carry scripts, and /media serves from the connector origin.',
        );
      }
      const tenant = typeof opts.tenant === 'function' ? await opts.tenant() : opts.tenant;
      const day = now().toISOString().slice(0, 10);
      const key = `${UPLOAD_KEY_PREFIX}/${tenant}/${day}/${randomId()}-${safeKeySegment(filename)}`;
      const expiresAtMs = now().getTime() + ttlMs;
      const signature = await opts.sign(key, ct, expiresAtMs);
      return { url: links.upload(key, ct, expiresAtMs, signature), key, contentType: ct, expiresAtMs };
    },
  };
}
