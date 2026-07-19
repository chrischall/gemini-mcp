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
    for (const register of CONNECTOR_TOOLS) register(server as never, {} as never);
    return names.sort();
  }

  it('registers exactly the six serverless-safe registrars', () => {
    // Six registrars, seven tools — registerGenerateTools contributes two.
    expect(registeredToolNames()).toEqual([
      'gemini_get_result',
      'gemini_image_edit',
      'gemini_image_generate',
      'gemini_image_set',
      'gemini_interact',
      'gemini_list_models',
      'gemini_music_generate',
    ]);
  });

  it('does NOT register gemini_video_generate', () => {
    // Video output is disk-only: MCP has no inline video content block, so
    // emitMedia always writes it to a filesystem the Worker does not have.
    expect(registeredToolNames()).not.toContain('gemini_video_generate');
    expect(CONNECTOR_TOOLS).toHaveLength(6);
  });

  it('registers gemini_music_generate (audio HAS an inline MCP block)', () => {
    expect(registeredToolNames()).toContain('gemini_music_generate');
  });
});
