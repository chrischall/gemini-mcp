import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_TOOLS } from '../src/worker.js';
import { geminiAuth } from '../src/gemini-auth.js';

/**
 * Runs inside workerd (see vitest.workers.config.ts) against wrangler.jsonc's
 * real bindings. `npm test` (the Node pool) excludes this file — it imports
 * `cloudflare:test` and, transitively, `agents` / `cloudflare:workers`, none of
 * which resolve outside the Workers runtime.
 */
describe('worker bindings', () => {
  it('exposes the bindings wrangler.jsonc declares', () => {
    expect(env.OAUTH_KV).toBeTruthy();
    expect(env.MEDIA_BUCKET).toBeTruthy();
    expect(env.MCP_OBJECT).toBeTruthy();
  });
});

describe('OAuth surface', () => {
  it('serves the authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);

    const doc = (await res.json()) as Record<string, string>;
    expect(doc.authorization_endpoint).toMatch(/\/authorize$/);
    expect(doc.token_endpoint).toMatch(/\/token$/);
    expect(doc.registration_endpoint).toMatch(/\/register$/);
  });

  it('rejects an unauthenticated /mcp call with 401', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('renders the Gemini login page at /authorize', async () => {
    // /authorize validates client_id against a registered client, so go through
    // dynamic client registration first — exactly as claude.ai does.
    const reg = await SELF.fetch('https://example.com/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['https://example.com/cb'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://example.com/cb',
      response_type: 'code',
    });
    const res = await SELF.fetch(`https://example.com/authorize?${query}`);
    const html = await res.text();

    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('Gemini');
    // The single credential field, and the honest storage disclosure.
    expect(html).toContain('apiKey');
    expect(html).toMatch(/encrypted at rest/i);
    expect(html).toMatch(/Cloudflare KV/i);
  });

  it('404s an unknown path', async () => {
    const res = await SELF.fetch('https://example.com/nope');
    expect(res.status).toBe(404);
  });
});

/**
 * `/upload` is the bytes-never-touch-model-context path: raw body in, a
 * `files/<id>` reference out. It is registered as an OAuth `apiHandlers` route
 * precisely so it is guarded by the SAME access token as `/mcp` — these assert
 * that guard is really the provider's, not something we hand-rolled.
 */
describe('POST /upload', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('rejects an unauthenticated upload with 401 and an OAuth challenge', async () => {
    const res = await SELF.fetch('https://example.com/upload', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(res.status).toBe(401);
    // The provider's own challenge — proof the route sits behind OAuth rather
    // than doing its own token check.
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  });

  it('rejects a bogus bearer token', async () => {
    const res = await SELF.fetch('https://example.com/upload', {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: 'Bearer not-a-real-token' },
      body: png,
    });
    expect(res.status).toBe(401);
  });

  it('is reachable at all (not swallowed by the 404 default handler)', async () => {
    // A GET is unauthenticated too, so this still 401s — the point is that the
    // path is routed to the API side of the provider, not to `Not found`.
    const res = await SELF.fetch('https://example.com/upload');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toBe('Not found');
  });
});

/**
 * `/media` is the one route deliberately OUTSIDE OAuth: it exists so a person
 * can open a generated image from a chat client, and neither a browser nor a
 * link preview carries a bearer token. These run against the real provider to
 * prove the route is reachable unauthenticated AND that the signature, not the
 * absence of auth, is what guards it.
 */
describe('GET /media (public, signature-guarded)', () => {
  it('is NOT behind OAuth — an unauthenticated request is not 401', async () => {
    const res = await SELF.fetch('https://example.com/media/gen/2026-07-29/abc-x.png');
    expect(res.status).not.toBe(401);
    // No signature ⇒ refused, but on its own terms.
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/signature/i);
  });

  it('refuses a forged signature', async () => {
    const res = await SELF.fetch(`https://example.com/media/gen/2026-07-29/abc-x.png?exp=${Date.now() + 60_000}&sig=AAAA`);
    expect(res.status).toBe(403);
  });

  it('rejects a non-GET method rather than falling through to 404', async () => {
    const res = await SELF.fetch('https://example.com/media/gen/x.png', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('still 404s a path outside /media/', async () => {
    expect((await SELF.fetch('https://example.com/mediaX')).status).toBe(404);
  });
});

describe('connector auth', () => {
  it('asks for exactly one masked credential', () => {
    expect(geminiAuth.service).toBe('Gemini');
    expect(geminiAuth.fields).toHaveLength(1);
    expect(geminiAuth.fields[0]).toMatchObject({ name: 'apiKey', type: 'password' });
  });

  it('discloses that the key IS stored, and where — not that it is not', () => {
    const note = geminiAuth.privacyNote ?? '';
    expect(note).toMatch(/encrypted at rest/i);
    expect(note).toMatch(/Cloudflare KV/i);
    expect(note).toMatch(/Generative Language API/i);
    // The lie this note exists to avoid.
    expect(note).not.toMatch(/not stored|never stored/i);
  });

  it('rejects a blank key without calling upstream', async () => {
    await expect(geminiAuth.login({ apiKey: '   ' }, {})).rejects.toThrow(/Enter your Gemini API key/i);
  });

  it('rejects a key it cannot verify, pointing at where to get one', async () => {
    // login() verifies with a live GET /v1beta/models; in the test pool that
    // call cannot succeed, which is exactly the failure path being asserted.
    await expect(geminiAuth.login({ apiKey: 'not-a-real-key' }, {})).rejects.toThrow(
      /aistudio\.google\.com\/apikey/,
    );
  });
});

describe('tool roster', () => {
  /** Register every connector tool against a recording stub server. */
  function registeredToolNames(): string[] {
    const names: string[] = [];
    const server = { registerTool: (name: string) => { names.push(name); } };
    // Connector-shaped client: an object-storage sink, the runtime the real
    // buildClient supplies. gemini_sign_media only registers against one.
    const client = { mediaSink: { persistsFiles: false } } as never;
    for (const register of CONNECTOR_TOOLS) register(server as never, client);
    return names.sort();
  }

  it('registers exactly the seven serverless-safe registrars', () => {
    // Seven registrars, eleven tools — registerGenerateTools contributes two
    // and registerFileTools four.
    expect(registeredToolNames()).toEqual([
      'gemini_delete_file',
      'gemini_get_result',
      'gemini_image_edit',
      'gemini_image_generate',
      'gemini_image_set',
      'gemini_interact',
      'gemini_list_files',
      'gemini_list_models',
      'gemini_music_generate',
      'gemini_sign_media',
      'gemini_upload_file',
    ]);
  });

  it('does NOT register gemini_video_generate', () => {
    // Video output is disk-only: MCP has no inline video content block, so
    // emitMedia always writes it to a filesystem the Worker does not have.
    expect(registeredToolNames()).not.toContain('gemini_video_generate');
    expect(CONNECTOR_TOOLS).toHaveLength(7);
  });

  it('serves the Files API tools — the way to send an image without base64', () => {
    // Input-side, these are the whole point of the hosted connector: no
    // filesystem means `images` paths are unavailable, and `images_base64`
    // costs ~14k tokens per photo.
    const names = registeredToolNames();
    expect(names).toContain('gemini_upload_file');
    expect(names).toContain('gemini_list_files');
    expect(names).toContain('gemini_delete_file');
  });

  it('registers gemini_music_generate (audio HAS an inline MCP block)', () => {
    expect(registeredToolNames()).toContain('gemini_music_generate');
  });
});
