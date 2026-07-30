import { loadSigningKey, verifyMediaSignature, type SecretStore } from './media-url.js';

/**
 * `GET /media/<key>?exp=…&sig=…` — streams one generated object out of R2.
 *
 * This route sits **outside** the connector's OAuth, unlike `/mcp` and
 * `/upload`, and that is deliberate rather than an oversight: the entire point
 * is a link a human can tap in a chat client and an agent can `curl`. Neither
 * carries a bearer token. The HMAC signature is the authorization — it names
 * exactly one object and expires — so an unsigned request reaches nothing, and
 * a signed one reaches only the object it was minted for.
 *
 * `HEAD` is supported because that is what a link-preview fetcher sends first.
 */

/** The slice of R2 this module reads. Structural so tests can fake it. */
export interface MediaObject {
  /** Absent on a metadata-only (HEAD) read — R2Object has no body. */
  body?: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  size?: number;
  uploaded?: Date;
  /** R2's strong validator; used verbatim as the ETag. */
  httpEtag?: string;
  etag?: string;
  /** Buffered read, used only to satisfy a Range request. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface MediaReadBucket {
  get(key: string): Promise<MediaObject | null>;
  head?(key: string): Promise<Omit<MediaObject, 'body'> | null>;
}

/**
 * Human-friendly download name from an object key.
 *
 * Keys look like `gen/2026-07-29/ab12cd34-a-cat.png`; the random component is
 * there to make the key unique, not to be read. Stripping it turns a saved file
 * into `a-cat.png`, which matters because the reliable way to show a user an
 * image in a chat client is for the agent to download it and attach it — and an
 * attachment called `ab12cd34-a-cat.png` looks like a machine artefact.
 */
export function downloadFilename(key: string): string {
  const last = key.split('/').pop() || 'media';
  const stripped = last.replace(/^[0-9a-f]{6,12}-/i, '');
  return stripped || last;
}

/** Parse a single-range `Range: bytes=a-b` header. Multi-range is not supported. */
function parseRange(header: string | null, size: number | undefined): { offset: number; length: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return undefined;
  if (startText === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endText);
    if (!suffix || size === undefined) return undefined;
    const offset = Math.max(0, size - suffix);
    return { offset, length: size - offset };
  }
  const offset = Number(startText);
  if (size !== undefined && offset >= size) return 'unsatisfiable';
  const end = endText === '' ? (size !== undefined ? size - 1 : undefined) : Number(endText);
  if (end === undefined) return { offset, length: Number.MAX_SAFE_INTEGER };
  if (end < offset) return 'unsatisfiable';
  return { offset, length: end - offset + 1 };
}

export interface MediaEndpointEnv {
  bucket: MediaReadBucket;
  store: SecretStore;
  secret?: string;
  now?: () => number;
}

const MISSING = 'That media object no longer exists — it may have been cleaned up. Re-run the generation to get a fresh one.';

/**
 * Response headers shared by GET, HEAD and 206. `Content-Disposition` carries a
 * readable filename because the reliable way to show a user an image in a chat
 * client is for the agent to download it and attach it.
 */
function baseHeaders(key: string, object: { httpMetadata?: { contentType?: string }; httpEtag?: string; etag?: string }, size: number | undefined): Headers {
  const headers = new Headers({
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    // The URL is signed and expiring, so it is safe to cache for its lifetime;
    // `private` keeps shared caches from serving it to anyone else.
    'cache-control': 'private, max-age=3600',
    'content-disposition': `inline; filename="${downloadFilename(key)}"`,
    // The bytes are model output being handed to a browser — never let a
    // sniffed content type turn an image response into something executable.
    'x-content-type-options': 'nosniff',
    // Range support is cheap on R2 and is what makes a resumable `curl -C -`
    // work against a large video.
    'accept-ranges': 'bytes',
  });
  const etag = object.httpEtag ?? object.etag;
  if (etag) headers.set('etag', etag);
  if (size !== undefined) headers.set('content-length', String(size));
  return headers;
}

function problem(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Build the `/media` handler. `basePath` is stripped from the pathname to get
 * the R2 key, so the key keeps its own prefix and the two never drift.
 */
export function createMediaHandler(env: MediaEndpointEnv, basePath = '/media/') {
  return async function handleMedia(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problem(405, `Method ${request.method} not allowed; media links are GET-only.`);
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath)) return problem(404, 'Not found');

    // decodeURIComponent per segment, mirroring how the URL was built. A key
    // cannot contain `..` (the sink sanitises every segment), and R2 has no
    // path traversal to exploit anyway — a key is an opaque string, not a path.
    const key = url.pathname
      .slice(basePath.length)
      .split('/')
      .map((segment) => {
        try { return decodeURIComponent(segment); } catch { return segment; }
      })
      .join('/');
    if (!key) return problem(404, 'Not found');

    const now = env.now?.() ?? Date.now();
    // Read-only: verification must never CREATE a signing secret. A stale KV
    // read here would otherwise clobber the secret every outstanding link was
    // signed with (see loadSigningKey). No secret ⇒ nothing was legitimately
    // signed ⇒ refuse, without touching storage or the bucket.
    const signingKey = await loadSigningKey(env.secret, env.store);
    const check = signingKey
      ? await verifyMediaSignature(signingKey, key, url.searchParams.get('exp'), url.searchParams.get('sig'), now)
      : ({ ok: false, reason: 'invalid' } as const);
    if (!check.ok) {
      if (check.reason === 'expired') {
        return problem(410, 'This media link has expired. Generated media is retained for a limited time — re-run the generation to get a fresh link.');
      }
      return problem(403, 'Invalid or missing media signature. Media links must be used exactly as returned by the tool, including the exp and sig parameters.');
    }

    const rangeHeader = request.headers.get('range');

    // HEAD is what a link-preview fetcher and `curl -I` send first; serve it
    // from a metadata read where the bucket offers one, rather than opening a
    // body we are about to throw away.
    if (request.method === 'HEAD' && env.bucket.head) {
      const meta = await env.bucket.head(key);
      if (!meta) return problem(404, MISSING);
      return new Response(null, { status: 200, headers: baseHeaders(key, meta, meta.size) });
    }

    // Fetch whole and slice on the way out rather than pushing the range into
    // R2: the objects here are single images and short clips, and a typed
    // range option is not expressible against both the real binding and a test
    // fake without casting away the very types that make this safe.
    const object = await env.bucket.get(key);
    if (!object) return problem(404, MISSING);

    const totalSize = object.size;
    const range = parseRange(rangeHeader, totalSize);
    if (range === 'unsatisfiable') {
      return new Response('Requested range not satisfiable\n', {
        status: 416,
        headers: { 'content-range': `bytes */${totalSize ?? 0}`, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const headers = baseHeaders(key, object, totalSize);
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

    if (range && totalSize !== undefined && object.arrayBuffer) {
      const length = Math.min(range.length, totalSize - range.offset);
      const slice = (await object.arrayBuffer()).slice(range.offset, range.offset + length);
      headers.set('content-length', String(slice.byteLength));
      headers.set('content-range', `bytes ${range.offset}-${range.offset + slice.byteLength - 1}/${totalSize}`);
      return new Response(slice, { status: 206, headers });
    }
    return new Response(object.body ?? null, { status: 200, headers });
  };
}
