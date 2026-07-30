import { describe, it, expect, vi } from 'vitest';
import { registerFileTools } from '../src/tools/files.js';
import { GeminiClient } from '../src/client.js';
import { createR2Sink } from '../src/storage/media.js';

/**
 * Every `gemini_upload_file` input form, exercised inside workerd.
 *
 * These cannot live in the Node pool. The class of bug they exist to catch —
 * a platform native invoked with the wrong receiver, e.g. a destructured
 * `crypto.subtle.digest` — is legal in V8 and throws `Illegal invocation` only
 * under workerd's WebIDL enforcement. A Node test would stay green while the
 * deployed connector failed on every call.
 */

/** Invoke a registered tool's handler directly — no MCP transport in workerd. */
async function callTool(client: GeminiClient, name: string, args: Record<string, unknown>) {
  const handlers = new Map<string, (a: unknown, e: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (toolName: string, _cfg: unknown, handler: (a: unknown, e: unknown) => Promise<unknown>) => {
      handlers.set(toolName, handler);
    },
  };
  registerFileTools(server as never, client);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`no such tool: ${name}`);
  return handler(args, {});
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A fetch stub covering the Files API resumable dance, with no network. */
function uploadFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).includes('/upload/v1beta/files') && !String(url).includes('upload_id')) {
      return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/s?upload_id=1' } });
    }
    return Response.json({
      file: { name: 'files/w1', uri: 'https://g/v1beta/files/w1', mimeType: 'image/png', state: 'ACTIVE', sizeBytes: '68' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function workerClient(fetchImpl: typeof fetch) {
  return new GeminiClient({
    apiKey: 'test-key',
    fetchImpl,
    // The R2 sink is what a real connector session carries; constructing it here
    // keeps the client shaped like production rather than like a unit test.
    mediaSink: createR2Sink({ put: async () => ({}) }, { signedBaseUrl: 'https://c.example.com/media', sign: async () => 'sig', urlTtlMs: 1000 }),
  });
}

describe('gemini_upload_file input forms (workerd)', () => {
  it('uploads a raw base64 payload end to end', async () => {
    const cap = uploadFetch();
    const res = await callTool(workerClient(cap.fn), 'gemini_upload_file', { data_base64: PNG_B64 });

    expect(JSON.stringify(res)).toContain('files/w1');
    expect(cap.calls).toHaveLength(2);
  });

  it('uploads a data: URI end to end', async () => {
    const cap = uploadFetch();
    const res = await callTool(workerClient(cap.fn), 'gemini_upload_file', {
      data_base64: `data:image/png;base64,${PNG_B64}`,
    });

    expect(JSON.stringify(res)).toContain('files/w1');
    // The declared length must match the DECODED bytes, not the base64 text.
    const start = cap.calls[0].init.headers as Record<string, string>;
    expect(Number(start["X-Goog-Upload-Header-Content-Length"])).toBe(70);
  });

  it('uploads from a url the server fetches', async () => {
    const cap = uploadFetch();
    const client = workerClient(cap.fn);
    vi.spyOn(client, 'fetchRemoteImage').mockResolvedValue({
      bytes: Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)),
      mimeType: 'image/png',
      size: 68,
      finalUrl: 'https://cdn.example.com/a.png',
      requestedUrl: 'https://cdn.example.com/a.png',
    });
    const res = await callTool(client, 'gemini_upload_file', { url: 'https://cdn.example.com/a.png' });

    expect(JSON.stringify(res)).toContain('files/w1');
  });

  it('streams a request body through, as POST /upload does', async () => {
    const cap = uploadFetch();
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.close(); },
    });
    const file = await workerClient(cap.fn).uploadStream(stream, 'image/png', 'x.png', 4);

    expect(file.name).toBe('files/w1');
  });

  it('refuses `path` — there is no filesystem here', async () => {
    const cap = uploadFetch();
    await expect(callTool(workerClient(cap.fn), 'gemini_upload_file', { path: '/etc/passwd', confirm: true }))
      .rejects.toThrow(/no filesystem/i);
  });
});
