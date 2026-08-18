/**
 * An in-process stand-in for mcp-host's blob gateway.
 *
 * The signed-upload flow spans two processes that never meet in a unit test:
 * this MCP mints a URL, and something else entirely — the gateway — decides
 * whether to honour it. Every previous test stopped at the mint, which is
 * exactly why a re-host could point the PUT at a base URL nothing would accept
 * and no test noticed.
 *
 * So this is deliberately a VERIFIER, not a recorder: it re-derives each
 * signature from the four payload shapes and refuses anything that does not
 * match, the way the real gateway does. It restates those shapes independently
 * of `src/blob-store.ts` (as `tests/blob-store.test.ts` does) so a drift has to
 * be made twice to pass, and it enforces the parts of the contract this MCP
 * depends on:
 *
 *  - the signature covers `<registrationId>/<key>`, not the relative key;
 *  - a PUT's content type comes from the request HEADER (the gateway never
 *    reads `?ct=`), so a mismatched header is a 403 — this is why
 *    `curl_hint` must carry `-H "Content-Type: …"`;
 *  - expiry is checked after the signature, so a forgery is never reported as
 *    merely expired;
 *  - non-GET/PUT/DELETE is 405, an unknown registration is 404.
 *
 * It is NOT the real gateway and cannot prove the production deployment
 * agrees; `tests/upload-flow.live.test.ts` is the opt-in check for that.
 */

/** Independent restatement of the gateway's payload shapes. */
const SHAPES = {
  read: (k: string, e: number) => `${k}\n${e}`,
  write: (k: string, c: string, e: number) => `put\0${k}\0${c}\0${e}`,
  writePermanent: (k: string, c: string, e: number) => `putp\0${k}\0${c}\0${e}`,
  del: (k: string, e: number) => `del\0${k}\0${e}`,
  list: (p: string, e: number) => `list\0${p}\0${e}`,
};

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url');
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  permanent: boolean;
}

export interface FakeGateway {
  /** Drop-in for `fetch`, to be injected wherever this MCP reaches the store. */
  fetch: typeof fetch;
  /** `https://gw.test/b/<registrationId>` — what MCP_BLOB_BASE_URL would be. */
  baseUrl: string;
  signingKey: string;
  /** Everything stored, by RELATIVE key (the key space this repo thinks in). */
  objects: Map<string, StoredObject>;
  /** Every request the gateway saw, for "did the mint touch storage at all". */
  requests: Array<{ method: string; url: string }>;
  /** Cap enforced on bytes actually read, as the retired /put endpoint did. */
  maxBytes: number;
}

export interface FakeGatewayOptions {
  registrationId?: string;
  signingKey?: string;
  now?: () => number;
  maxBytes?: number;
  /** Fail every request, to exercise the "storage is down" path. */
  offline?: boolean;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createFakeGateway(opts: FakeGatewayOptions = {}): FakeGateway {
  const registrationId = opts.registrationId ?? 'reg_9f2c1a7b';
  const signingKey = opts.signingKey ?? 'gateway-signing-key';
  const baseUrl = `https://gw.test/b/${registrationId}`;
  const now = opts.now ?? (() => Date.now());
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const objects = new Map<string, StoredObject>();
  const requests: Array<{ method: string; url: string }> = [];

  const gateway = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(String(input));
    requests.push({ method, url: url.toString() });
    if (opts.offline) return json({ error: 'gateway unavailable' }, 503);

    const path = url.pathname.replace(/^\/+/, '');
    if (!path.startsWith(`b/${registrationId}`)) return json({ error: 'not found' }, 404);
    const relative = path
      .slice(`b/${registrationId}`.length)
      .replace(/^\/+/, '')
      .split('/')
      .map((s) => { try { return decodeURIComponent(s); } catch { return s; } })
      .join('/');
    const fullKey = `${registrationId}/${relative}`;
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig');
    if (!sig || !Number.isFinite(exp)) return json({ error: 'missing signature' }, 403);

    /** Signature first, then expiry — a forgery must not be told it is "expired". */
    const authorize = async (payload: string): Promise<Response | undefined> => {
      if (sig !== (await hmac(signingKey, payload))) return json({ error: 'invalid signature' }, 403);
      if (now() > exp) return json({ error: 'signature expired' }, 403);
      return undefined;
    };

    if (method === 'PUT') {
      // The content type is read from the HEADER. `?ct=` is not consulted —
      // getting this wrong is the difference between an upload that stores and
      // one that 403s with a signature the caller can see is "right".
      const contentType = (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? '';
      const permanent = url.searchParams.get('retain') === 'permanent';
      const denied = await authorize(
        permanent ? SHAPES.writePermanent(fullKey, contentType, exp) : SHAPES.write(fullKey, contentType, exp),
      );
      if (denied) return denied;
      const bytes = await toBytes(init?.body);
      if (bytes.byteLength > maxBytes) return json({ error: 'payload too large' }, 413);
      objects.set(relative, { bytes, contentType, permanent });
      // A bare 201 with NO body: the r2_key the caller keeps is the minted one.
      return new Response(null, { status: 201 });
    }

    if (method === 'DELETE') {
      const denied = await authorize(SHAPES.del(fullKey, exp));
      if (denied) return denied;
      if (!objects.delete(relative)) return json({ error: 'not found' }, 404);
      return new Response(null, { status: 204 });
    }

    if (method === 'GET') {
      if (relative === '') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const denied = await authorize(SHAPES.list(prefix, exp));
        if (denied) return denied;
        return json(
          { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false },
          200,
        );
      }
      const denied = await authorize(SHAPES.read(fullKey, exp));
      if (denied) return denied;
      const hit = objects.get(relative);
      if (!hit) return json({ error: 'not found' }, 404);
      return new Response(hit.bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': hit.contentType },
      });
    }

    return json({ error: 'method not allowed' }, 405);
  };

  return { fetch: gateway as unknown as typeof fetch, baseUrl, signingKey, objects, requests, maxBytes };
}

async function toBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}
