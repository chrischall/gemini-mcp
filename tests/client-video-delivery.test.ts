import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiClient } from '../src/client.js';

/**
 * `response_format.delivery` — verified live 2026-08-22 (docs/GEMINI-API.md).
 *
 * The enum is `inline | uri` for image/audio/video, but only VIDEO implements
 * it; image and audio 400 with "<Media> delivery mode is not supported." A
 * uri-delivered video comes back as a Files API download link with NO `data`
 * key, and that link needs the api key (403 without it) — so the bytes still
 * have to be fetched by us before the sink ever sees them.
 */

const ORIG_KEY = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
});

const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media';

/** An Interactions response whose video part carries a uri and no data. */
function uriVideoResponse(uri = FILE_URI): unknown {
  return {
    id: 'vid-uri-1',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri }] }],
  };
}

function inlineVideoResponse(): unknown {
  return {
    id: 'vid-inline-1',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'VIDEOBYTES' }] }],
  };
}

interface Call { url: string; init: RequestInit }

/**
 * A fetch that answers JSON for the interactions POST and raw bytes for a
 * Files API download, recording every call.
 */
function scriptedFetch(
  responder: (url: string, init: RequestInit, calls: Call[]) => unknown,
): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const out = responder(url, init, calls) as Record<string, unknown>;
    return out;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function jsonErr(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
    text: async () => JSON.stringify({ error: { message, code: 'invalid_request' } }),
  };
}

function bytesOk(bytes: Uint8Array, contentType = 'video/mp4') {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  };
}

describe('generateVideo — uri delivery', () => {
  it('requests uri delivery by default (the ~4MB inline ceiling is a real failure mode)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url) => (url.includes('/interactions') ? jsonOk(uriVideoResponse()) : bytesOk(new Uint8Array([1, 2, 3]))));
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateVideo({ input: 'a cat surfing' });
    const sent = JSON.parse(cap.calls[0].init.body as string);
    expect(sent.response_format.delivery).toBe('uri');
  });

  it('downloads a uri-delivered video with the api key and returns the bytes as base64', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url) =>
      url.includes('/interactions') ? jsonOk(uriVideoResponse()) : bytesOk(new Uint8Array([0x41, 0x42, 0x43])),
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.generateVideo({ input: 'a cat surfing' });

    const download = cap.calls[1];
    expect(download.url).toBe(FILE_URI);
    expect((download.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    // The link 403s without the key, so a uri result is NOT a shareable link:
    // the bytes must reach the caller exactly as inline delivery would.
    expect(r.videos).toEqual([{ base64: 'QUJD', mimeType: 'video/mp4' }]);
  });

  it('refuses to download a media uri pointing at another host', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url) =>
      url.includes('/interactions') ? jsonOk(uriVideoResponse('https://evil.example.com/v1beta/files/x:download')) : bytesOk(new Uint8Array([1])),
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/unexpected host|generativelanguage/i);
    expect(cap.calls).toHaveLength(1); // never fetched
  });

  it('falls back to no delivery field when the model rejects delivery (a 400 generates nothing)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url, _init, calls) => {
      if (!url.includes('/interactions')) return bytesOk(new Uint8Array([1]));
      return calls.length === 1
        ? jsonErr(400, 'Video delivery mode is not supported.')
        : jsonOk(inlineVideoResponse());
    });
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    const r = await c.generateVideo({ input: 'x', model: 'some-other-video-model' });

    expect(JSON.parse(cap.calls[0].init.body as string).response_format.delivery).toBe('uri');
    expect(JSON.parse(cap.calls[1].init.body as string).response_format).not.toHaveProperty('delivery');
    expect(r.videos[0].base64).toBe('VIDEOBYTES');
  });

  it('does not retry a 400 that is not about delivery', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch(() => jsonErr(400, "The value '1:1' is not supported for 'response_format.aspect_ratio'."));
    const c = new GeminiClient({ fetchImpl: cap.fn, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/aspect_ratio/);
    expect(cap.calls).toHaveLength(1);
  });

  it('honours an explicit inline delivery and does not download anything', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch(() => jsonOk(inlineVideoResponse()));
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.generateVideo({ input: 'x', delivery: 'inline' });
    expect(JSON.parse(cap.calls[0].init.body as string).response_format.delivery).toBe('inline');
    expect(cap.calls).toHaveLength(1);
    expect(r.videos[0].base64).toBe('VIDEOBYTES');
  });

  it('surfaces a failed download as an actionable error naming the file', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url) =>
      url.includes('/interactions') ? jsonOk(uriVideoResponse()) : { ok: false, status: 403, text: async () => 'denied' },
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/403|download/i);
  });
});

describe('the media download is credentialed, so the hop rules are strict', () => {
  it('never carries the api key onto another host, even via a redirect', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // The key rides this request. A redirect the API controls must not be able
    // to walk it onto a host we did not intend to authenticate to — the same
    // rule fetch-image.ts enforces per hop.
    const cap = scriptedFetch((url, _init, calls) => {
      if (url.includes('/interactions')) return jsonOk(uriVideoResponse());
      if (calls.length === 2) {
        return { ok: false, status: 302, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? 'https://evil.example.com/steal' : null) } };
      }
      return bytesOk(new Uint8Array([1]));
    });
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/unexpected host|generativelanguage/i);
    // POST + the one redirecting GET. The evil host is never contacted.
    expect(cap.calls).toHaveLength(2);
    expect(cap.calls.some((call) => call.url.includes('evil.example.com'))).toBe(false);
  });

  it('follows a same-host redirect, re-attaching the key on the new hop', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const next = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media&r=2';
    const cap = scriptedFetch((url, _init, calls) => {
      if (url.includes('/interactions')) return jsonOk(uriVideoResponse());
      if (calls.length === 2) {
        return { ok: false, status: 302, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? next : null) } };
      }
      return bytesOk(new Uint8Array([0x41, 0x42, 0x43]));
    });
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.generateVideo({ input: 'x' });
    expect(cap.calls[2].url).toBe(next);
    expect((cap.calls[2].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    expect(r.videos[0].base64).toBe('QUJD');
  });

  it('refuses a body larger than the download cap instead of buffering it', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch((url) => {
      if (url.includes('/interactions')) return jsonOk(uriVideoResponse());
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(1024 ** 4) : 'video/mp4') },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await expect(c.generateVideo({ input: 'x' })).rejects.toThrow(/Generated media .* above the 128\.0 MB limit/);
  });
});

describe('image and music keep sending no delivery field', () => {
  it('interact does not send response_format.delivery (image delivery is rejected upstream)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch(() =>
      jsonOk({ id: 'i-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: 'IMG' }] }] }),
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.interact({ input: 'x' });
    expect(JSON.parse(cap.calls[0].init.body as string).response_format).not.toHaveProperty('delivery');
  });

  it('still collects a text part that happens to carry a uri', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // A part is what its `type` says it is. Branching on "has a uri" instead
    // silently drops the text of any annotated text part.
    const cap = scriptedFetch(() =>
      jsonOk({
        id: 'i-1',
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [
            { type: 'text', text: 'a cited sentence', uri: 'https://example.com/source' },
            { type: 'image', mime_type: 'image/jpeg', data: 'IMG' },
          ],
        }],
      }),
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    const r = await c.interact({ input: 'x' });
    expect(r.text).toBe('a cited sentence');
    expect(r.images).toHaveLength(1);
    // And the text part must not have been mistaken for downloadable media.
    expect(cap.calls).toHaveLength(1);
  });

  it('generateMusic does not send response_format.delivery (audio delivery is rejected upstream)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = scriptedFetch(() =>
      jsonOk({ id: 'm-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: 'AUD' }] }] }),
    );
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateMusic({ input: 'x' });
    expect(JSON.parse(cap.calls[0].init.body as string).response_format).not.toHaveProperty('delivery');
  });
});
