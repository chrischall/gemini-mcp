import { resolveSigningKey, verifyMediaSignature, type SecretStore } from './media-url.js';

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
export interface MediaReadBucket {
  get(key: string): Promise<{
    body: ReadableStream | null;
    httpMetadata?: { contentType?: string };
    size?: number;
    uploaded?: Date;
  } | null>;
}

export interface MediaEndpointEnv {
  bucket: MediaReadBucket;
  store: SecretStore;
  secret?: string;
  now?: () => number;
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
    const signingKey = await resolveSigningKey(env.secret, env.store);
    const check = await verifyMediaSignature(signingKey, key, url.searchParams.get('exp'), url.searchParams.get('sig'), now);
    if (!check.ok) {
      if (check.reason === 'expired') {
        return problem(410, 'This media link has expired. Generated media is retained for a limited time — re-run the generation to get a fresh link.');
      }
      return problem(403, 'Invalid or missing media signature. Media links must be used exactly as returned by the tool, including the exp and sig parameters.');
    }

    const object = await env.bucket.get(key);
    if (!object) {
      return problem(404, 'That media object no longer exists — it may have been cleaned up. Re-run the generation to get a fresh one.');
    }

    const headers = new Headers({
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // The URL is signed and expiring, so it is safe to cache for its lifetime;
      // `private` keeps shared caches from serving it to anyone else.
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename="${key.split('/').pop() ?? 'media'}"`,
      // The bytes are model output being handed to a browser — never let a
      // sniffed content type turn an image response into something executable.
      'x-content-type-options': 'nosniff',
    });
    if (object.size !== undefined) headers.set('content-length', String(object.size));
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(object.body, { status: 200, headers });
  };
}
