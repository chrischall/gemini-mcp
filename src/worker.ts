import { DurableObject } from 'cloudflare:workers';

/**
 * Placeholder connector entrypoint.
 *
 * `wrangler.jsonc` names this file as `main` and declares the `GeminiMcpAgent`
 * Durable Object in migration `v1`, so BOTH `wrangler deploy` and the workerd
 * test pool fail to build without it — the scaffold is not loadable otherwise.
 *
 * The real connector (an `agents` McpAgent behind
 * @cloudflare/workers-oauth-provider, serving the gemini tools over HTTP with
 * media written to R2) replaces this. Until then this exports the DO class the
 * migration expects and answers a health probe, nothing more.
 */
/** Declared once in worker-env.d.ts, which merges into `Cloudflare.Env` so the
 *  workerd test pool's `env` is typed from the same source. */
export type Env = Cloudflare.Env;

/**
 * Named to match `migrations[0].new_sqlite_classes` — a shipped migration tag
 * must never be rewritten, so this class name is fixed even though the
 * implementation is still a stub.
 */
export class GeminiMcpAgent extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('gemini-connector: not implemented', { status: 501 });
  }
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Used by docs/DEPLOY-CONNECTOR.md step 6 to verify a deploy over the
    // *.workers.dev URL while the custom domain's TLS cert provisions.
    if (pathname === '/' || pathname === '/health') {
      return Response.json({ ok: true, service: 'gemini-connector' });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
