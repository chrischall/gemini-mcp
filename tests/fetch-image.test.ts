import { describe, it, expect, vi } from 'vitest';
import { fetchRemoteImage, IMAGE_URL_MAX_BYTES } from '../src/fetch-image.js';

/**
 * `images_url` makes the SERVER fetch a caller-supplied URL, which is an SSRF
 * primitive — and on the stdio build the server sits on the user's own machine,
 * next to their LAN. These tests pin both halves: that a normal public image
 * works, and that everything else is refused with an error naming the URL.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A fetch stub answering a fixed map of URL → Response. */
function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const make = routes[url];
    if (!make) throw new Error(`unexpected fetch: ${url}`);
    return make();
  }) as unknown as typeof fetch;
}

function imageResponse(bytes: Uint8Array = PNG_BYTES, contentType = 'image/png', extraHeaders: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': contentType, ...extraHeaders },
  });
}

describe('fetchRemoteImage — happy path', () => {
  it('returns the bytes and MIME for a public https image', async () => {
    const url = 'https://cdn.example.com/photo.png';
    const result = await fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => imageResponse() }) });

    expect(result.mimeType).toBe('image/png');
    expect(result.size).toBe(PNG_BYTES.byteLength);
    expect([...result.bytes]).toEqual([...PNG_BYTES]);
    expect(result.finalUrl).toBe(url);
  });

  it('strips content-type parameters (image/jpeg; charset=binary)', async () => {
    const url = 'https://cdn.example.com/photo.jpg';
    const result = await fetchRemoteImage(url, {
      fetchImpl: stubFetch({ [url]: () => imageResponse(PNG_BYTES, 'image/jpeg; charset=binary') }),
    });
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('follows a redirect and reports where the bytes actually came from', async () => {
    const from = 'https://example.com/a.png';
    const to = 'https://cdn.example.com/b.png';
    const result = await fetchRemoteImage(from, {
      fetchImpl: stubFetch({
        [from]: () => new Response(null, { status: 302, headers: { location: to } }),
        [to]: () => imageResponse(),
      }),
    });
    expect(result.finalUrl).toBe(to);
    expect(result.requestedUrl).toBe(from);
  });

  it('resolves a relative Location against the current hop', async () => {
    const from = 'https://example.com/dir/a.png';
    const to = 'https://example.com/dir/b.png';
    const result = await fetchRemoteImage(from, {
      fetchImpl: stubFetch({
        [from]: () => new Response(null, { status: 301, headers: { location: 'b.png' } }),
        [to]: () => imageResponse(),
      }),
    });
    expect(result.finalUrl).toBe(to);
  });
});

describe('fetchRemoteImage — content type', () => {
  it('rejects a non-image response and names the URL and what it got', async () => {
    const url = 'https://example.com/gallery';
    await expect(
      fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) }) }),
    ).rejects.toThrow(/gallery.*not an image.*text\/html/s);
  });

  it('rejects a response with no content-type at all', async () => {
    const url = 'https://example.com/mystery';
    await expect(
      fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => new Response(PNG_BYTES as unknown as BodyInit, { status: 200, headers: {} }) }) }),
    ).rejects.toThrow(/\(none\)/);
  });

  it('accepts a widened `accept` list — what gemini_upload_file uses for video', async () => {
    const url = 'https://cdn.example.com/clip.mp4';
    const result = await fetchRemoteImage(url, {
      accept: ['image/', 'video/'],
      fetchImpl: stubFetch({ [url]: () => imageResponse(PNG_BYTES, 'video/mp4') }),
    });
    expect(result.mimeType).toBe('video/mp4');
  });
});

describe('fetchRemoteImage — size cap', () => {
  it('rejects on a declared Content-Length over the cap, without reading the body', async () => {
    const url = 'https://cdn.example.com/huge.png';
    const body = vi.fn();
    const res = imageResponse(PNG_BYTES, 'image/png', { 'content-length': String(IMAGE_URL_MAX_BYTES + 1) });
    await expect(fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => res }) })).rejects.toThrow(/above the .* limit for images_url/);
    expect(body).not.toHaveBeenCalled();
  });

  it('rejects while streaming when Content-Length lied (or was absent)', async () => {
    const url = 'https://cdn.example.com/liar.png';
    // 40 bytes streamed in 4 chunks against a 20-byte cap: the cap must bite on
    // the bytes actually received, not on what the server claimed.
    const chunk = new Uint8Array(10);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    await expect(
      fetchRemoteImage(url, {
        maxBytes: 20,
        fetchImpl: stubFetch({
          [url]: () => new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }),
        }),
      }),
    ).rejects.toThrow(/above the .* limit for images_url/);
  });

  it('accepts a file exactly at the cap', async () => {
    const url = 'https://cdn.example.com/edge.png';
    const bytes = new Uint8Array(20).fill(7);
    const result = await fetchRemoteImage(url, {
      maxBytes: 20,
      fetchImpl: stubFetch({ [url]: () => imageResponse(bytes) }),
    });
    expect(result.size).toBe(20);
  });
});

describe('fetchRemoteImage — SSRF guards', () => {
  const never = (() => { throw new Error('fetch must not be attempted'); }) as unknown as typeof fetch;

  it.each([
    ['http://example.com/a.png', /only https:\/\/ URLs/],
    ['file:///etc/passwd', /only https:\/\/ URLs/],
    ['data:image/png;base64,AAAA', /only https:\/\/ URLs/],
  ])('refuses %s', async (url, matcher) => {
    await expect(fetchRemoteImage(url, { fetchImpl: never })).rejects.toThrow(matcher);
  });

  it.each([
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://10.0.0.5/a.png',
    'https://192.168.1.10/a.png',
    'https://172.16.4.4/a.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/a.png',
    'https://[fe80::1]/a.png',
    'https://[fc00::1]/a.png',
    'https://[fd12:3456::1]/a.png',
    'https://printer.local/a.png',
  ])('refuses the private/loopback/link-local host in %s', async (url) => {
    await expect(fetchRemoteImage(url, { fetchImpl: never })).rejects.toThrow(/private, loopback or link-local/);
  });

  // The WHATWG URL serializer emits IPv6 as hex groups with NO IPv4-mapped
  // special case, so `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]` —
  // and a caller can type that form directly anyway. A guard that only reads
  // the dotted spelling therefore never fires on anything real.
  it.each([
    ['https://[::ffff:7f00:1]/a.png', '127.0.0.1'],
    ['https://[::ffff:127.0.0.1]/a.png', '127.0.0.1, dotted spelling'],
    ['https://[::ffff:a9fe:a9fe]/latest/meta-data/', '169.254.169.254'],
    ['https://[::ffff:a00:5]/a.png', '10.0.0.5'],
    ['https://[::ffff:c0a8:1]/a.png', '192.168.0.1'],
    ['https://[0:0:0:0:0:ffff:7f00:1]/a.png', '127.0.0.1, uncompressed'],
    ['https://[::7f00:1]/a.png', '127.0.0.1, IPv4-compatible'],
  ])('refuses %s — an IPv4-mapped IPv6 literal for %s', async (url) => {
    await expect(fetchRemoteImage(url, { fetchImpl: never })).rejects.toThrow(/private, loopback or link-local/);
  });

  it('still allows a public IPv6 literal', async () => {
    const url = 'https://[2606:4700:4700::1111]/a.png';
    const result = await fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => imageResponse() }) });
    expect(result.size).toBe(PNG_BYTES.byteLength);
  });

  it('fails closed on an IPv6 literal it cannot parse', async () => {
    // Unreachable through `new URL` today, but a guard that silently allows
    // what it cannot understand is the wrong default for this control.
    await expect(fetchRemoteImage('https://[::ffff:zz]/a.png', { fetchImpl: never })).rejects.toThrow(
      /Not a valid URL|private, loopback or link-local/,
    );
  });

  it('revalidates every redirect hop — a public URL cannot bounce onto the metadata service', async () => {
    const from = 'https://example.com/innocent.png';
    await expect(
      fetchRemoteImage(from, {
        fetchImpl: stubFetch({
          [from]: () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }),
        }),
      }),
    ).rejects.toThrow(/private, loopback or link-local/);
  });

  it('mentions the original URL when the refusal happened after a redirect', async () => {
    const from = 'https://example.com/innocent.png';
    await expect(
      fetchRemoteImage(from, {
        fetchImpl: stubFetch({
          [from]: () => new Response(null, { status: 302, headers: { location: 'https://10.1.2.3/secret.png' } }),
        }),
      }),
    ).rejects.toThrow(/redirected from https:\/\/example\.com\/innocent\.png/);
  });

  it('gives up after too many redirects instead of looping', async () => {
    const url = 'https://example.com/loop.png';
    await expect(
      fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => new Response(null, { status: 302, headers: { location: url } }) }) }),
    ).rejects.toThrow(/exceeded 5 redirects/);
  });
});

describe('fetchRemoteImage — upstream failures', () => {
  it('surfaces an HTTP error status with the URL', async () => {
    const url = 'https://example.com/private.png';
    await expect(
      fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => new Response('nope', { status: 403 }) }) }),
    ).rejects.toThrow(/private\.png returned HTTP 403/);
  });

  it('surfaces a transport failure with the URL', async () => {
    const url = 'https://example.com/gone.png';
    const failing = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    await expect(fetchRemoteImage(url, { fetchImpl: failing })).rejects.toThrow(/Could not fetch https:\/\/example\.com\/gone\.png.*ENOTFOUND/s);
  });

  it('rejects an empty body rather than sending zero bytes upstream', async () => {
    const url = 'https://example.com/empty.png';
    await expect(
      fetchRemoteImage(url, {
        fetchImpl: stubFetch({ [url]: () => new Response(new Uint8Array(0) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } }) }),
      }),
    ).rejects.toThrow(/empty body/);
  });

  it('bounds a hung request instead of hanging the tool call forever', async () => {
    // A server that accepts the connection and then never responds. Without an
    // abort budget this never settles — and the progress heartbeat around
    // resolveImageInputs actively stops the host from timing it out for us.
    const url = 'https://example.com/slow.png';
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_res, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
        );
      })) as unknown as typeof fetch;

    await expect(fetchRemoteImage(url, { fetchImpl: hanging, timeoutMs: 20 })).rejects.toThrow(
      /slow\.png timed out after 20ms/,
    );
  });

  it('passes an AbortSignal to fetch so the BODY read is bounded too', async () => {
    const url = 'https://example.com/trickle.png';
    let seen: RequestInit | undefined;
    const capture = (async (_u: string, init: RequestInit) => {
      seen = init;
      return imageResponse();
    }) as unknown as typeof fetch;

    await fetchRemoteImage(url, { fetchImpl: capture, timeoutMs: 5_000 });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a mid-body transport failure as one, not as a size violation', async () => {
    const url = 'https://example.com/cut.png';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(Object.assign(new Error('socket hang up'), { name: 'TypeError' })); },
    });
    await expect(
      fetchRemoteImage(url, {
        fetchImpl: stubFetch({ [url]: () => new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }) }),
      }),
    ).rejects.toThrow(/Could not fetch .*cut\.png.*socket hang up/s);
  });

  it('rejects a redirect with no Location header', async () => {
    const url = 'https://example.com/half-redirect.png';
    await expect(
      fetchRemoteImage(url, { fetchImpl: stubFetch({ [url]: () => new Response(null, { status: 302 }) }) }),
    ).rejects.toThrow(/no Location header/);
  });
});
