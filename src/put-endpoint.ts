import { loadSigningKey, type SecretStore } from './media-url.js';
import { verifyUploadSignature, UPLOAD_MAX_BYTES, UPLOAD_KEY_PREFIX, acceptableUploadType } from './upload-url.js';
import { wholeMb } from './bytes.js';

/**
 * `PUT /put/<key>?ct=…&exp=…&sig=…` — stores one uploaded reference image in R2.
 *
 * Sits OUTSIDE OAuth on the default handler, exactly like `GET /media/…` and
 * for the same reason: the caller is a shell (`curl --data-binary @photo.jpg`)
 * that holds no bearer token. The expiring HMAC signature — minted by the
 * authenticated MCP session via `gemini_get_upload_url` — is the authorization.
 * It names one object key (already inside the minting account's own `up/`
 * namespace), one content type, and a deadline, and nothing else is writable.
 *
 * Hard limits, all enforced BEFORE the object is stored:
 *  - method PUT only (the signature covers the method string);
 *  - the key must be a well-formed `up/…` key (charset-checked before the
 *    signature is even verified — a control character in a crafted key is how
 *    a cross-protocol signature confusion would have to start);
 *  - Content-Type must match the signed one exactly, and must be a raster
 *    image type (never SVG, which can carry scripts — see
 *    RASTER_IMAGE_TYPE_PATTERN in upload-url.ts);
 *  - Content-Length is required and capped, and the cap is re-enforced while
 *    reading the stream — a client can under-declare, so the declared length
 *    is a fast rejection, not the enforcement.
 */

/** The slice of R2 this endpoint writes. Structural so tests can fake it. */
export interface PutBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface PutEndpointEnv {
  bucket: PutBucket;
  store: SecretStore;
  secret?: string;
  now?: () => number;
  maxBytes?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Every error names the fix — the caller here is a shell, not a model. */
function fail(status: number, error: string, hint: string): Response {
  return json({ error, hint }, status);
}

/** A key this endpoint is willing to even verify a signature for: the upload
 * prefix, safe segment charset, no dot-segments, no empty segments. */
export function wellFormedUploadKey(key: string): boolean {
  if (!key.startsWith(`${UPLOAD_KEY_PREFIX}/`)) return false;
  const segments = key.split('/');
  if (segments.length < 2) return false;
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s));
}

/**
 * Build the `/put` handler. `basePath` is stripped from the pathname to get the
 * R2 key, mirroring the `/media` handler so the two never drift.
 */
export function createSignedPutHandler(env: PutEndpointEnv, basePath = '/put/') {
  const maxBytes = env.maxBytes ?? UPLOAD_MAX_BYTES;
  return async function handleSignedPut(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'PUT, OPTIONS' } });
    }
    if (request.method !== 'PUT') {
      return fail(
        405,
        `Method ${request.method} not allowed; signed upload URLs are PUT-only.`,
        'Send the file bytes with: curl -sS -X PUT -H "Content-Type: <the signed type>" --data-binary @photo.jpg "<upload_url>"',
      );
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath)) return fail(404, 'Not found.', 'Use the exact upload_url returned by gemini_get_upload_url.');
    const key = url.pathname
      .slice(basePath.length)
      .split('/')
      .map((segment) => {
        try { return decodeURIComponent(segment); } catch { return segment; }
      })
      .join('/');
    // Charset-checked BEFORE signature verification: the cross-protocol safety
    // argument in upload-url.ts rests on keys never containing control chars.
    if (!wellFormedUploadKey(key)) {
      return fail(404, 'Not a valid upload key.', 'Use the exact upload_url returned by gemini_get_upload_url — the key path cannot be altered.');
    }

    const ct = url.searchParams.get('ct');
    if (ct && !acceptableUploadType(ct)) {
      return fail(
        415,
        `Unsupported content type "${ct}" — signed uploads accept raster image types only ` +
          '(jpeg/png/webp/gif/avif/heic/heif/bmp/tiff; not SVG, which can carry scripts).',
        'Mint the URL with a raster image content_type (e.g. image/jpeg).',
      );
    }

    const now = env.now?.() ?? Date.now();
    // Read-only key load: verification must never CREATE a signing secret (see
    // loadSigningKey — a stale KV read would clobber the secret every
    // outstanding media link was signed with).
    const signingKey = await loadSigningKey(env.secret, env.store);
    const check = signingKey
      ? await verifyUploadSignature(signingKey, key, ct, url.searchParams.get('exp'), url.searchParams.get('sig'), now)
      : ({ ok: false, reason: 'invalid' } as const);
    if (!check.ok) {
      if (check.reason === 'expired') {
        return fail(410, 'This upload URL has expired (they are valid for ~10 minutes).', 'Mint a fresh one with gemini_get_upload_url and retry.');
      }
      return fail(403, 'Invalid or missing upload signature.', 'Use the upload_url exactly as returned by gemini_get_upload_url, including the ct, exp and sig query parameters.');
    }

    const sentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (sentType !== ct) {
      return fail(
        415,
        `Content-Type "${sentType || '(none)'}" does not match the type this URL was minted for ("${ct}").`,
        `Send -H "Content-Type: ${ct}", or mint a new URL with the right content_type.`,
      );
    }

    const declared = Number(request.headers.get('content-length'));
    if (!request.headers.get('content-length') || !Number.isFinite(declared) || declared <= 0) {
      return fail(411, 'Content-Length is required (and must be > 0).', 'curl sets it automatically with --data-binary @file.');
    }
    if (declared > maxBytes) {
      return fail(413, `Upload is ${wholeMb(declared)}MB; the cap is ${wholeMb(maxBytes)}MB.`, 'Downscale the image before uploading — a reference photo does not need to be full-resolution.');
    }
    if (!request.body) {
      return fail(400, 'Request had no body.', 'Send the file bytes as the request body, e.g. --data-binary @photo.jpg.');
    }

    // Enforce the cap on bytes actually READ, not the declared length — a
    // hostile client can under-declare and stream more.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return fail(413, `Upload exceeded the ${wholeMb(maxBytes)}MB cap while being read.`, 'Downscale the image before uploading.');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }

    await env.bucket.put(key, body, { httpMetadata: { contentType: ct ?? 'application/octet-stream' } });
    return json(
      {
        r2_key: key,
        size_bytes: total,
        content_type: ct,
        hint:
          `Uploaded. Reference it by r2_key: pass it in images_r2_keys on a generation tool (master_images_r2_keys on gemini_image_set), ` +
          `save it permanently with gemini_save_character, or convert it to a ~48h Gemini Files API reference with gemini_upload_file({ r2_key }). ` +
          `Uploads follow the connector's media retention schedule (MEDIA_TTL_DAYS, default 7 days); saved characters are kept indefinitely.`,
      },
      201,
    );
  };
}
