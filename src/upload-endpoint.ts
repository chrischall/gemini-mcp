import type { GeminiClient } from './client.js';

/**
 * `POST /upload` — raw bytes in, a `files/<id>` reference out.
 *
 * This is the *intended* path for an agent that has a shell. MCP moves
 * arguments as JSON through the model's context window, so any tool parameter
 * carrying an image costs ~14k tokens per photo and dies if the read that
 * produced it was truncated. An HTTP body carries none of that: the bytes go
 * from disk to curl to the Files API without the model ever seeing them, and
 * the model gets back a 20-character reference to pass to any image tool.
 *
 *   curl -X POST https://<worker>/upload \
 *     -H "Authorization: Bearer <access-token>" \
 *     -H "Content-Type: image/jpeg" \
 *     --data-binary @photo.jpg
 *
 * Auth is the SAME OAuth access token as `/mcp`, because this is registered as
 * an `apiHandlers` route on the OAuth provider — the provider validates the
 * bearer token and decrypts the grant's props before we are called, so
 * `ctx.props.apiKey` here is the same per-user key the MCP session uses. An
 * unauthenticated request never reaches this function; it gets the provider's
 * own 401 with a `WWW-Authenticate` challenge.
 *
 * The body is streamed straight through to the Files API. Nothing is buffered,
 * which is what keeps a 200 MB video from having to fit in the isolate's
 * memory — and is why `Content-Length` is required (the resumable upload
 * protocol declares the length up front, before the first byte is sent).
 */

/** The slice of the Worker execution context this handler reads. */
export interface UploadCtx {
  props?: { apiKey?: string } & Record<string, unknown>;
}

/** Media the Files API is useful for. Anything else is a caller mistake. */
const ACCEPTED_PREFIXES = ['image/', 'video/', 'audio/'];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Every error names the fix, because the caller here is a shell, not a model. */
function fail(status: number, error: string, hint: string): Response {
  return json({ error, hint }, status);
}

/**
 * Build the `/upload` route handler. `buildClient` is injected rather than
 * imported so the Worker can construct a client from *this request's* OAuth
 * props (never a shared singleton — see the cross-tenant note in session.ts),
 * and so tests can drive the whole handler against a stub client.
 */
export function createUploadHandler(buildClient: (apiKey: string) => GeminiClient) {
  return async function handleUpload(request: Request, ctx: UploadCtx): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') {
      return fail(405, `Method ${request.method} not allowed on /upload.`, 'POST the raw file bytes as the request body.');
    }

    // The OAuth provider populates props from the validated bearer token. Its
    // absence means the route was reached some other way — refuse rather than
    // fall back to an ambient key, which on a multi-tenant Worker would bill an
    // unauthenticated upload to whoever configured the environment.
    const apiKey = ctx.props?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) {
      return fail(401, 'Unauthenticated.', 'Send the same Authorization: Bearer <access-token> you use for the /mcp endpoint.');
    }

    const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ACCEPTED_PREFIXES.some((p) => contentType.startsWith(p))) {
      return fail(
        415,
        `Unsupported Content-Type "${contentType || '(none)'}".`,
        'Set Content-Type to the file\'s media type, e.g. -H "Content-Type: image/jpeg".',
      );
    }

    const declared = request.headers.get('content-length');
    const contentLength = Number(declared);
    if (!declared || !Number.isFinite(contentLength) || contentLength <= 0) {
      return fail(
        411,
        'Content-Length is required (and must be > 0).',
        'The Files API resumable upload declares the size up front, so the body cannot be sent chunked. ' +
          'curl sets this automatically with --data-binary @file.',
      );
    }

    const body = request.body;
    if (!body) {
      return fail(400, 'Request had no body.', 'Send the file bytes as the request body, e.g. --data-binary @photo.jpg.');
    }

    try {
      const file = await buildClient(apiKey).uploadStream(
        body,
        contentType,
        displayNameFor(request, contentType),
        contentLength,
      );
      return json(
        {
          file_uri: file.name,
          uri: file.uri,
          name: file.name,
          mime_type: file.mimeType,
          ...(file.sizeBytes ? { size_bytes: Number(file.sizeBytes) } : {}),
          expires: file.expirationTime ?? '~48h from upload',
          hint: `Pass "${file.name}" as images_file_uris (or video_url) on any image tool. Gemini retains it ~48h.`,
        },
        201,
      );
    } catch (err) {
      // Upstream failures are the interesting case here (bad key, quota, a file
      // over the 2 GB cap), so the message is passed through rather than
      // flattened into "upload failed".
      const message = err instanceof Error ? err.message : String(err);
      return fail(502, `Upload to the Gemini Files API failed: ${message}`, 'Check the API key on this connection is still valid and funded.');
    }
  };
}

/**
 * A display name for the upload: an explicit `?name=` wins, else the
 * `X-Filename` header (what a wrapper script would send), else the media type.
 * Cosmetic — the Files API keys on the returned resource name, not this.
 */
function displayNameFor(request: Request, contentType: string): string {
  const fromQuery = new URL(request.url).searchParams.get('name');
  const raw = fromQuery ?? request.headers.get('x-filename') ?? `upload.${contentType.split('/')[1] || 'bin'}`;
  return raw.replace(/[^\w.\-]+/g, '-').slice(0, 120) || 'upload';
}
