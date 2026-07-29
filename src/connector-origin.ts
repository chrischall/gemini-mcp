/**
 * Tell an MCP session which hostname it was reached on.
 *
 * This is the single load-bearing link in the zero-config media-URL path: the
 * origin captured here becomes `https://<host>/media/…` for every generated
 * image. If it goes missing, generations silently stop coming back with
 * openable links — the exact failure the media work exists to end — so it lives
 * in its own module, free of any Cloudflare import, purely so it can be tested.
 * (`src/worker.ts` pulls in `agents` and cannot load under Node at all.)
 *
 * Deriving the origin per request rather than configuring it is what makes a
 * fork, a `*.workers.dev` preview and the custom domain all mint correct links
 * with nothing to set. It rides on `ctx.props` — the object the OAuth provider
 * has already populated with the decrypted grant — rather than a module-level
 * variable, because one isolate serves many authenticated sessions (session.ts).
 */

/** The execution-context slice this touches. `props` is typed `unknown` upstream. */
export interface PropsCarrier {
  props?: unknown;
}

/** Anything with a `fetch`, which is what both an McpAgent handler and a stub are. */
export interface FetchLike {
  fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}

/** Property name the session reads back off its props. */
export const CONNECTOR_ORIGIN_PROP = 'connectorOrigin';

/**
 * Wrap a handler so `ctx.props.connectorOrigin` is set before it runs.
 *
 * Existing props are preserved — they carry the user's API key, and dropping
 * them would break authentication rather than merely lose a URL.
 */
export function withConnectorOrigin<T extends FetchLike>(inner: T): FetchLike {
  return {
    fetch(request: Request, env: unknown, ctx: unknown) {
      const carrier = (ctx ?? {}) as PropsCarrier;
      const existing = (typeof carrier.props === 'object' && carrier.props !== null ? carrier.props : {}) as Record<string, unknown>;
      carrier.props = { ...existing, [CONNECTOR_ORIGIN_PROP]: new URL(request.url).origin };
      return inner.fetch(request, env, ctx);
    },
  };
}
