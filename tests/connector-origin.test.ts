import { describe, it, expect, vi } from 'vitest';
import { withConnectorOrigin, CONNECTOR_ORIGIN_PROP, type FetchLike } from '../src/connector-origin.js';

/**
 * This wrapper is the single load-bearing link in the zero-config media-URL
 * path: the origin it captures becomes `https://<host>/media/…` for every
 * generated image. If it silently stops working, generations go back to
 * returning something the user cannot open — the exact failure the media work
 * exists to end — and nothing else in the system would notice.
 *
 * It also encodes an assumption about @cloudflare/workers-oauth-provider: that
 * `ctx.props` is a plain writable property on the same context object the
 * handler receives. That assumption is asserted here rather than trusted.
 */

function recorder(): FetchLike & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    fetch: vi.fn((_req: Request, _env: unknown, ctx: unknown) => {
      seen.push((ctx as { props?: unknown }).props);
      return new Response('ok');
    }),
  };
}

describe('withConnectorOrigin', () => {
  it('injects the origin the request actually arrived on', async () => {
    const inner = recorder();
    const ctx = { props: { apiKey: 'k' } };
    await withConnectorOrigin(inner).fetch(new Request('https://connector.example.com/mcp'), {}, ctx);

    expect((ctx.props as Record<string, unknown>)[CONNECTOR_ORIGIN_PROP]).toBe('https://connector.example.com');
    expect(inner.seen[0]).toMatchObject({ [CONNECTOR_ORIGIN_PROP]: 'https://connector.example.com' });
  });

  it('PRESERVES existing props — they carry the user\'s API key', async () => {
    const inner = recorder();
    const ctx = { props: { apiKey: 'user-key', other: 1 } };
    await withConnectorOrigin(inner).fetch(new Request('https://c.example.com/mcp'), {}, ctx);

    // Dropping these would break authentication, not merely lose a URL.
    expect(ctx.props).toMatchObject({ apiKey: 'user-key', other: 1 });
  });

  it('mutates the SAME ctx object the handler receives', async () => {
    // The assumption about the OAuth provider: assignment sticks, and the inner
    // handler sees it. If a future provider froze or copied ctx, this fails
    // here instead of silently degrading every media URL in production.
    const inner = recorder();
    const ctx: { props?: unknown } = {};
    await withConnectorOrigin(inner).fetch(new Request('https://c.example.com/mcp'), {}, ctx);

    expect(ctx.props).toBeDefined();
    expect(inner.seen[0]).toBe(ctx.props);
  });

  it('works when the provider supplied no props at all', async () => {
    const inner = recorder();
    const ctx: { props?: unknown } = {};
    await withConnectorOrigin(inner).fetch(new Request('https://c.example.com/sse'), {}, ctx);

    expect(ctx.props).toEqual({ [CONNECTOR_ORIGIN_PROP]: 'https://c.example.com' });
  });

  it('tolerates a non-object props value rather than throwing mid-request', async () => {
    const inner = recorder();
    const ctx: { props?: unknown } = { props: 'unexpected' };
    await withConnectorOrigin(inner).fetch(new Request('https://c.example.com/mcp'), {}, ctx);

    expect(ctx.props).toEqual({ [CONNECTOR_ORIGIN_PROP]: 'https://c.example.com' });
  });

  it('carries the port through, so a workers.dev preview or local dev still signs correctly', async () => {
    const inner = recorder();
    const ctx: { props?: unknown } = {};
    await withConnectorOrigin(inner).fetch(new Request('http://127.0.0.1:8787/mcp'), {}, ctx);

    expect((ctx.props as Record<string, unknown>)[CONNECTOR_ORIGIN_PROP]).toBe('http://127.0.0.1:8787');
  });

  it('passes the request and env straight through, and returns the inner response', async () => {
    const inner = recorder();
    const request = new Request('https://c.example.com/mcp');
    const env = { MEDIA_BUCKET: 'x' };
    const res = await withConnectorOrigin(inner).fetch(request, env, {});

    expect(inner.fetch).toHaveBeenCalledWith(request, env, expect.anything());
    expect(await res.text()).toBe('ok');
  });
});
