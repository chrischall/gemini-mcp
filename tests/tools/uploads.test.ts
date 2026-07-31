import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerUploadUrlTools } from '../../src/tools/uploads.js';
import { createUploadUrlMinter, signUploadKey, UPLOAD_URL_TTL_MS } from '../../src/upload-url.js';
import { resolveSigningKey, type SecretStore } from '../../src/media-url.js';
import { SessionState } from '../../src/session.js';
import type { GeminiClient } from '../../src/client.js';

/**
 * `gemini_get_upload_url` hands a shell everything it needs in one result: the
 * URL, the exact curl command, and what to do with the r2_key afterwards.
 */

const NOW = 1_790_000_000_000;

function fakeStore(): SecretStore {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

function stub(withMinter = true): GeminiClient {
  const minter = createUploadUrlMinter({
    baseUrl: 'https://connector.example/put',
    sign: async (key, ct, exp) => signUploadKey(await resolveSigningKey('s3cret', fakeStore()), key, ct, exp),
    tenant: 'aaaaaaaaaaaa',
    now: () => new Date(NOW),
    randomId: () => 'deadbeef',
  });
  return { uploadUrls: withMinter ? minter : undefined, session: new SessionState() } as unknown as GeminiClient;
}

describe('gemini_get_upload_url', () => {
  it('is absent on clients with no minter (stdio)', async () => {
    const names: string[] = [];
    const server = { registerTool: (name: string) => { names.push(name); } };
    registerUploadUrlTools(server as never, stub(false));
    expect(names).toEqual([]);
  });

  it('mints a tenant-scoped PUT URL with expiry, r2_key and a ready-to-run curl command', async () => {
    const h = await createTestHarness((s) => registerUploadUrlTools(s, stub()));
    const body = parseToolResult<Record<string, unknown>>(
      await h.callTool('gemini_get_upload_url', { filename: 'finn.jpg', content_type: 'image/jpeg' }),
    );
    await h.close();

    expect(body.method).toBe('PUT');
    expect(String(body.r2_key)).toMatch(/^up\/aaaaaaaaaaaa\/\d{4}-\d{2}-\d{2}\/deadbeef-finn\.jpg$/);
    expect(String(body.upload_url)).toContain('https://connector.example/put/up/aaaaaaaaaaaa/');
    expect(String(body.upload_url)).toContain('ct=image%2Fjpeg');
    expect(String(body.upload_url)).toMatch(/exp=\d+/);
    expect(String(body.upload_url)).toMatch(/sig=/);
    expect(body.expires_at).toBe(new Date(NOW + UPLOAD_URL_TTL_MS).toISOString());
    expect(String(body.curl_hint)).toBe(
      `curl -sS -X PUT -H "Content-Type: image/jpeg" --data-binary @finn.jpg "${body.upload_url}"`,
    );
    // The follow-up path is named in the hint, not left to be guessed.
    expect(String(body.hint)).toMatch(/images_r2_keys/);
    expect(String(body.hint)).toMatch(/gemini_save_character/);
  });

  it('refuses non-image content types at the schema', async () => {
    const h = await createTestHarness((s) => registerUploadUrlTools(s, stub()));
    const res = await h.callTool('gemini_get_upload_url', { filename: 'a.mp4', content_type: 'video/mp4' });
    expect(res.isError).toBe(true);
    await h.close();
  });
});
