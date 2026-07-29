import { describe, it, expect, vi } from 'vitest';
import { createUploadHandler } from '../src/upload-endpoint.js';
import type { GeminiClient } from '../src/client.js';

/**
 * `POST /upload` is the zero-base64 path: disk file → curl → `files/<id>` →
 * tool call, with the bytes never entering the model's context.
 *
 * The OAuth guard itself is asserted in `tests/worker.test.ts`, against the
 * real provider inside workerd (401 + `WWW-Authenticate`). What is tested here
 * is everything the handler owns once a request reaches it: that it refuses to
 * act without validated props, that it rejects malformed uploads with a fix,
 * and that a valid body is STREAMED through rather than buffered.
 */

function ctx(props?: Record<string, unknown>) {
  return { props } as { props?: { apiKey?: string } };
}

function uploadRequest(body: BodyInit | null, headers: Record<string, string>, method = 'POST', url = 'https://c.example.com/upload') {
  return new Request(url, { method, headers, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function stubClient(uploadStream: ReturnType<typeof vi.fn>): (apiKey: string) => GeminiClient {
  return () => ({ uploadStream } as unknown as GeminiClient);
}

const okUpload = () =>
  vi.fn().mockResolvedValue({
    name: 'files/xyz789',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz789',
    mimeType: 'image/jpeg',
    sizeBytes: '2048',
    expirationTime: '2026-07-30T12:00:00Z',
  });

describe('POST /upload — auth', () => {
  it('refuses to upload without validated OAuth props', async () => {
    const uploadStream = okUpload();
    const handler = createUploadHandler(stubClient(uploadStream));
    const res = await handler(uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ hint: expect.stringMatching(/Authorization: Bearer/) });
    // Never bill an upload that was not authenticated.
    expect(uploadStream).not.toHaveBeenCalled();
  });

  it('refuses when props exist but carry no api key', async () => {
    const uploadStream = okUpload();
    const handler = createUploadHandler(stubClient(uploadStream));
    const res = await handler(uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }), ctx({ somethingElse: true }));

    expect(res.status).toBe(401);
    expect(uploadStream).not.toHaveBeenCalled();
  });

  it('builds the client from THIS request\'s key, never an ambient one', async () => {
    const uploadStream = okUpload();
    const build = vi.fn(stubClient(uploadStream));
    const handler = createUploadHandler(build);
    await handler(uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }), ctx({ apiKey: 'user-b-key' }));

    expect(build).toHaveBeenCalledWith('user-b-key');
  });
});

describe('POST /upload — request validation', () => {
  const handler = () => createUploadHandler(stubClient(okUpload()));

  it('rejects a non-POST method', async () => {
    const res = await handler()(uploadRequest(null, {}, 'GET'), ctx({ apiKey: 'k' }));
    expect(res.status).toBe(405);
  });

  it('answers a preflight-style OPTIONS without uploading', async () => {
    const res = await handler()(uploadRequest(null, {}, 'OPTIONS'), ctx({ apiKey: 'k' }));
    expect(res.status).toBe(204);
  });

  it('rejects a non-media Content-Type, naming the fix', async () => {
    const res = await handler()(
      uploadRequest('{"a":1}', { 'content-type': 'application/json', 'content-length': '7' }),
      ctx({ apiKey: 'k' }),
    );
    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).toMatch(/Content-Type: image\/jpeg/);
  });

  it('rejects a missing Content-Length, explaining why it is required', async () => {
    const res = await handler()(uploadRequest(PNG, { 'content-type': 'image/png' }), ctx({ apiKey: 'k' }));
    expect(res.status).toBe(411);
    expect(JSON.stringify(await res.json())).toMatch(/resumable upload declares the size up front/);
  });
});

describe('POST /upload — success', () => {
  it('streams the body through and returns the reference in the documented shape', async () => {
    const uploadStream = okUpload();
    const handler = createUploadHandler(stubClient(uploadStream));
    const res = await handler(
      uploadRequest(PNG, { 'content-type': 'image/jpeg', 'content-length': '2048' }),
      ctx({ apiKey: 'k' }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.file_uri).toBe('files/xyz789');
    expect(body.uri).toBe('https://generativelanguage.googleapis.com/v1beta/files/xyz789');
    expect(body.mime_type).toBe('image/jpeg');
    expect(body.size_bytes).toBe(2048);
    expect(body.expires).toBe('2026-07-30T12:00:00Z');
    expect(String(body.hint)).toMatch(/images_file_uris/);

    // A ReadableStream, NOT a buffered ArrayBuffer — that is what keeps a large
    // upload out of the isolate's memory.
    const [stream, mime, , length] = uploadStream.mock.calls[0];
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(mime).toBe('image/jpeg');
    expect(length).toBe(2048);
  });

  it('names the upload from ?name=, then X-Filename, then the media type', async () => {
    const uploadStream = okUpload();
    const handler = createUploadHandler(stubClient(uploadStream));

    await handler(
      uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }, 'POST', 'https://c/upload?name=hero%20shot.png'),
      ctx({ apiKey: 'k' }),
    );
    expect(uploadStream.mock.calls[0][2]).toBe('hero-shot.png');

    await handler(
      uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8', 'x-filename': 'from-header.png' }),
      ctx({ apiKey: 'k' }),
    );
    expect(uploadStream.mock.calls[1][2]).toBe('from-header.png');

    await handler(uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }), ctx({ apiKey: 'k' }));
    expect(uploadStream.mock.calls[2][2]).toBe('upload.png');
  });

  it('accepts video and audio too — the Files API stores both', async () => {
    const uploadStream = okUpload();
    const handler = createUploadHandler(stubClient(uploadStream));
    for (const type of ['video/mp4', 'audio/mpeg']) {
      const res = await handler(uploadRequest(PNG, { 'content-type': type, 'content-length': '8' }), ctx({ apiKey: 'k' }));
      expect(res.status).toBe(201);
    }
  });
});

describe('POST /upload — upstream failure', () => {
  it('passes the upstream message through instead of flattening it', async () => {
    const uploadStream = vi.fn().mockRejectedValue(new Error('Gemini API error (401): API key not valid'));
    const handler = createUploadHandler(stubClient(uploadStream));
    const res = await handler(uploadRequest(PNG, { 'content-type': 'image/png', 'content-length': '8' }), ctx({ apiKey: 'k' }));

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toMatch(/API key not valid/);
  });
});
