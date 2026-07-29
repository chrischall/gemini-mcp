import { createConnector, handleAuthorize } from '@chrischall/mcp-connector';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { GeminiClient } from './client.js';
import { geminiAuth, type GeminiProps } from './gemini-auth.js';
import { createR2Sink } from './storage/media.js';
import { createUploadHandler } from './upload-endpoint.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerMusicTools } from './tools/music.js';
import { registerJobTools } from './tools/jobs.js';
import { registerFileTools } from './tools/files.js';

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
];

/**
 * One client per authenticated session, keyed on that user's own API key —
 * never a module-level singleton, which would leak one user's key to every
 * other session sharing the isolate. The R2 sink replaces the filesystem the
 * stdio server writes to; `MEDIA_PUBLIC_BASE_URL` is what turns the stored
 * objects into fetchable URLs (unset → the sink returns honest `r2://` refs and
 * says they are not public, rather than inventing a link that 404s).
 */
function buildClient(props: GeminiProps, env: Env): GeminiClient {
  return new GeminiClient({
    apiKey: props.apiKey,
    mediaSink: createR2Sink(env.MEDIA_BUCKET, {
      publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
      bucketName: 'gemini-connector-media',
    }),
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
    '/mcp': AgentClass.serve('/mcp'),
    '/sse': AgentClass.serveSSE('/sse'),
    // `ctx.props` is where the OAuth provider puts the decrypted grant props
    // after it has validated the bearer token; the runtime types it as
    // `unknown`, so the narrowing happens at this one boundary.
    '/upload': {
      fetch: (request: Request, _env: unknown, ctx: ExecutionContext) =>
        uploadHandler(request, ctx as unknown as { props?: { apiKey?: string } }),
    },
  },
  defaultHandler: {
    fetch: (request: Request, env: Env) =>
      new URL(request.url).pathname === '/authorize'
        ? handleAuthorize(request, env, geminiAuth)
        : new Response('Not found', { status: 404 }),
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

export default handler;
