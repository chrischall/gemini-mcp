import { createConnector, handleAuthorize } from '@chrischall/mcp-connector';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { GeminiClient } from './client.js';
import { geminiAuth, type GeminiProps } from './gemini-auth.js';
import { createR2Sink, tenantIdFor } from './storage/media.js';
import { createUploadHandler } from './upload-endpoint.js';
import { createMediaHandler } from './media-endpoint.js';
import { createSignedPutHandler } from './put-endpoint.js';
import { createUploadUrlMinter, signUploadKey } from './upload-url.js';
import { createR2Library } from './library.js';
import { cleanupExpiredMedia, retentionMsFromDays, type CleanupBucket } from './media-cleanup.js';
import { withConnectorOrigin } from './connector-origin.js';
import { resolveSigningKey, signMediaKey, MEDIA_URL_TTL_MS } from './media-url.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerMusicTools } from './tools/music.js';
import { registerJobTools } from './tools/jobs.js';
import { registerFileTools } from './tools/files.js';
import { registerLibraryTools } from './tools/library.js';
import { registerUploadUrlTools } from './tools/uploads.js';

/**
 * The hosted connector: gemini-mcp over streamable HTTP for claude.ai, behind
 * @cloudflare/workers-oauth-provider. The stdio entry point is `src/index.ts`;
 * this file is compiled only by wrangler (see tsconfig.json's exclude) and
 * typechecked only by tsconfig.worker.json.
 *
 * Operator runbook: docs/DEPLOY-CONNECTOR.md.
 */

/** Declared once in worker-env.d.ts, which merges into `Cloudflare.Env`. */
export type Env = Cloudflare.Env;

/**
 * The registrars the hosted connector serves.
 *
 * **`registerVideoTools` is deliberately absent.** MCP defines no inline video
 * content block, so `emitMedia` (tools/shared.ts) always writes video output to
 * a filesystem — and a Worker has none. Registering `gemini_video_generate`
 * here would advertise a tool that cannot return its result. Video stays a
 * stdio-only capability.
 *
 * Exported so tests can assert the roster without booting an MCP session.
 */
export const CONNECTOR_TOOLS: Array<(server: McpServer, client: GeminiClient) => void> = [
  registerModelTools,
  registerGenerateTools,
  registerSetTools,
  registerInteractTools,
  registerMusicTools,
  registerJobTools,
  registerFileTools,
  // Both are hosted-only capabilities and self-gate on the client (library /
  // uploadUrls) — on stdio the registrars are simply not in the list.
  registerLibraryTools,
  registerUploadUrlTools,
];

/**
 * How long generated objects are kept before the cleanup cron removes them.
 * A signed URL must never outlive its object, so the URL TTL is clamped to it.
 */
function retentionMs(env: Env): number {
  return retentionMsFromDays(env.MEDIA_TTL_DAYS);
}

/**
 * One client per authenticated session, keyed on that user's own API key —
 * never a module-level singleton, which would leak one user's key to every
 * other session sharing the isolate.
 *
 * The R2 sink replaces the filesystem the stdio server writes to, and its whole
 * job is to hand back something a HUMAN can open. Two ways, in order:
 *
 *  1. `MEDIA_PUBLIC_BASE_URL` — the bucket is served directly (r2.dev or a
 *     custom domain), so refs are plain unsigned URLs.
 *  2. Otherwise this connector serves the bytes itself at `/media/<key>`, with
 *     an expiring signature in the link. **This is the zero-config default**,
 *     and it is what makes generated media visible at all: the previous
 *     behaviour returned `r2://bucket/key`, which is honest and completely
 *     unusable — every hosted generation billed and then vanished.
 *
 * `connectorOrigin` is injected per request (see the apiHandlers wrapper) so
 * the URL points at whatever hostname the caller actually reached, with no
 * hardcoded domain and nothing for a fork to configure.
 */
function buildClient(props: GeminiProps & { connectorOrigin?: string }, env: Env): GeminiClient {
  const urlTtlMs = Math.min(MEDIA_URL_TTL_MS, retentionMs(env));
  // The bucket is shared by every connector account; the tenant component
  // namespaces keys per API key and gates read/resign, so a disclosed
  // r2_key cannot cross accounts.
  const tenant = () => tenantIdFor(props.apiKey);
  return new GeminiClient({
    apiKey: props.apiKey,
    mediaSink: createR2Sink(env.MEDIA_BUCKET, {
      publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
      signedBaseUrl: props.connectorOrigin ? `${props.connectorOrigin}/media` : undefined,
      sign: async (key, expiresAtMs) =>
        signMediaKey(await resolveSigningKey(env.MEDIA_URL_SECRET, env.OAUTH_KV), key, expiresAtMs),
      urlTtlMs,
      // Signed uploads (`up/`) and the character library (`lib/`) are readable
      // by the session that owns them; writes still go only under `gen/`.
      readPrefixes: ['up', 'lib'],
      // No per-persist override may mint a link outliving the retention sweep.
      maxUrlTtlMs: retentionMs(env),
      tenant,
    }),
    // Saved characters/styles — permanent (the cleanup cron skips `lib/`).
    library: createR2Library(env.MEDIA_BUCKET, { tenant }),
    // Signed PUT upload URLs, pointing at this request's own origin — same
    // zero-config origin story as the /media links.
    uploadUrls: props.connectorOrigin
      ? createUploadUrlMinter({
          baseUrl: `${props.connectorOrigin}/put`,
          sign: async (key, contentType, expiresAtMs) =>
            signUploadKey(await resolveSigningKey(env.MEDIA_URL_SECRET, env.OAUTH_KV), key, contentType, expiresAtMs),
          tenant,
        })
      : undefined,
  });
}

const { Agent } = createConnector<GeminiProps, GeminiClient>({
  name: 'gemini-mcp',
  version: VERSION,
  auth: geminiAuth,
  buildClient,
  tools: CONNECTOR_TOOLS as Array<(server: unknown, client: GeminiClient) => void>,
});

/**
 * `POST /upload` needs to sit behind the SAME OAuth token as `/mcp`, and the
 * only way to get that is to be an `apiHandlers` route on the OAuth provider —
 * that is what makes the provider validate the bearer token and hand us the
 * decrypted grant props. `createConnector` builds its provider internally and
 * exposes no hook for an extra route, so the provider is assembled here
 * instead, reusing the harness's own `Agent` and `handleAuthorize`.
 *
 * The duplication is deliberate and load-bearing: authenticating the upload
 * endpoint ourselves would mean reimplementing token lookup against the OAuth
 * provider's KV layout, which is internal and would break silently. If
 * `@chrischall/mcp-connector` ever grows an extra-routes option, collapse this
 * back onto `createConnector`'s handler — the endpoint paths below must stay in
 * step with the harness's until then.
 */
const AgentClass = Agent as unknown as {
  serve(path: string): { fetch: ExportedHandlerFetchHandler };
  serveSSE(path: string): { fetch: ExportedHandlerFetchHandler };
};

// A Worker has no filesystem, so an upload arriving here can only be raw bytes
// off the wire — exactly the point of the endpoint.
const uploadHandler = createUploadHandler((apiKey) => new GeminiClient({ apiKey }));


const handler = new OAuthProvider({
  apiHandlers: {
    // See src/connector-origin.ts — this is what makes media URLs point at
    // whatever hostname the caller actually reached, with nothing configured.
    '/mcp': withConnectorOrigin(AgentClass.serve('/mcp')) as never,
    '/sse': withConnectorOrigin(AgentClass.serveSSE('/sse')) as never,
    // `ctx.props` is where the OAuth provider puts the decrypted grant props
    // after it has validated the bearer token; the runtime types it as
    // `unknown`, so the narrowing happens at this one boundary.
    '/upload': {
      fetch: (request: Request, _env: unknown, ctx: ExecutionContext) =>
        uploadHandler(request, ctx as unknown as { props?: { apiKey?: string } }),
    },
  },
  // `/media` lives on the DEFAULT handler, i.e. outside OAuth — deliberately.
  // A chat client rendering a link, a browser opening it and a `curl` in a
  // sandbox all carry no bearer token, and requiring one would recreate exactly
  // the problem this route exists to solve. The URL's expiring HMAC signature
  // is the authorization instead: it names one object and nothing else.
  defaultHandler: {
    fetch: (request: Request, env: Env) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/authorize') return handleAuthorize(request, env, geminiAuth);
      if (pathname.startsWith('/media/')) {
        return createMediaHandler({
          bucket: env.MEDIA_BUCKET,
          store: env.OAUTH_KV,
          secret: env.MEDIA_URL_SECRET,
        })(request);
      }
      // `/put` is `/media`'s mirror image: a signature-authorized WRITE, so a
      // shell can upload a reference image with no bearer token. The URL is
      // minted by the authenticated session (gemini_get_upload_url) and names
      // one tenant-scoped key, one content type, and a ~10-minute deadline.
      if (pathname.startsWith('/put/')) {
        return createSignedPutHandler({
          bucket: env.MEDIA_BUCKET,
          store: env.OAUTH_KV,
          secret: env.MEDIA_URL_SECRET,
        })(request);
      }
      return new Response('Not found', { status: 404 });
    },
  } as never,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});

/**
 * Named to match `migrations[0].new_sqlite_classes` in wrangler.jsonc. A
 * shipped migration tag must never be rewritten, so this export name is fixed.
 */
export { Agent as GeminiMcpAgent };

/**
 * The Worker entry: the OAuth provider's `fetch`, plus a `scheduled` hook the
 * provider has no concept of.
 *
 * `OAuthProvider` is an object with a `fetch` method, not a plain handler, so
 * its method is bound rather than spread — a bare `...handler` would lose the
 * prototype and the provider would answer nothing.
 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    (handler as unknown as { fetch: ExportedHandlerFetchHandler }).fetch(request as never, env as never, ctx as never),
  /**
   * Retention sweep. Generated media is only useful for as long as its signed
   * link lives, so old objects are removed rather than accumulating forever.
   */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cleanupExpiredMedia(env.MEDIA_BUCKET as unknown as CleanupBucket, retentionMs(env)).then(
        (result) => console.log(`[gemini-mcp] media cleanup: scanned=${result.scanned} deleted=${result.deleted} truncated=${result.truncated}`),
        (err: unknown) => console.error('[gemini-mcp] media cleanup failed:', err),
      ),
    );
  },
};
