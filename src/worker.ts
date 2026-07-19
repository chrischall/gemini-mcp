import { createConnector } from '@chrischall/mcp-connector';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { GeminiClient } from './client.js';
import { geminiAuth, type GeminiProps } from './gemini-auth.js';
import { createR2Sink } from './storage/media.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerMusicTools } from './tools/music.js';
import { registerJobTools } from './tools/jobs.js';

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
];

const { Agent, handler } = createConnector<GeminiProps, GeminiClient>({
  name: 'gemini-mcp',
  version: VERSION,
  auth: geminiAuth,
  // One client per authenticated session, keyed on that user's own API key —
  // never a module-level singleton, which would leak one user's key to every
  // other session sharing the isolate. The R2 sink replaces the filesystem the
  // stdio server writes to; `MEDIA_PUBLIC_BASE_URL` is what turns the stored
  // objects into fetchable URLs (unset → the sink returns honest `r2://` refs
  // and says they are not public, rather than inventing a link that 404s).
  buildClient: (props, env: Env) =>
    new GeminiClient({
      apiKey: props.apiKey,
      mediaSink: createR2Sink(env.MEDIA_BUCKET, {
        publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
        bucketName: 'gemini-connector-media',
      }),
    }),
  tools: CONNECTOR_TOOLS as Array<(server: unknown, client: GeminiClient) => void>,
});

/**
 * Named to match `migrations[0].new_sqlite_classes` in wrangler.jsonc. A
 * shipped migration tag must never be rewritten, so this export name is fixed.
 */
export { Agent as GeminiMcpAgent };

export default handler;
