import { McpToolError } from '@chrischall/mcp-utils';

/**
 * Server-side fetching of `images_url` references.
 *
 * The point of this module is that image BYTES never travel through the model's
 * context window. A caller hands over an `https://` URL — a few dozen tokens —
 * and the *server* pulls the bytes down and turns them into an `inline_data`
 * part or a Files API upload. The alternative, `images_base64`, costs roughly
 * 14k tokens for a modest JPEG and is silently corrupted whenever a host
 * truncates the read that produced it.
 *
 * Fetching a caller-supplied URL from inside the server is an SSRF primitive,
 * and on the stdio build the server runs on the user's own machine, next to
 * their LAN. So this is deliberately narrow:
 *
 *  - **https only.** `http:`, `file:`, `data:`, `gopher:` and friends are out.
 *  - **No private/loopback/link-local destinations** — including the cloud
 *    metadata address, the classic escalation target.
 *  - **Redirects are followed MANUALLY**, revalidating every hop. `redirect:
 *    'follow'` would let a public URL bounce to `http://169.254.169.254/` with
 *    no further check, which makes the origin check theatre.
 *  - **A hard byte cap enforced while streaming**, not from `Content-Length` —
 *    a hostile or merely wrong server can under-report or omit it.
 *
 * Module scope stays side-effect-free: `src/worker.ts` reaches this file
 * through the tool registrars, so anything executed here would run during
 * Cloudflare isolate startup.
 */

/** Hard ceiling on a fetched image. Above this the URL is rejected outright. */
export const IMAGE_URL_MAX_BYTES = 15 * 1024 * 1024;
/**
 * Above this an image is uploaded to the Files API and referenced by uri
 * instead of inlined. `generateContent` caps a whole request at ~20 MB, so a
 * couple of large inline references would fail the request itself — and a
 * by-reference part costs nothing to repeat across calls.
 */
export const IMAGE_INLINE_MAX_BYTES = 6 * 1024 * 1024;
/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

/** A successfully fetched remote image. */
export interface FetchedImage {
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  /** The URL the bytes actually came from (after redirects), for the result meta. */
  finalUrl: string;
  /** The URL the caller asked for. */
  requestedUrl: string;
}

/** Parse an IPv4 literal into its four octets, or `undefined` if it isn't one. */
function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : undefined;
}

/** True for addresses that are not on the public internet. */
function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local — includes 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Reject a URL that isn't a plain public https endpoint. Hostname-based, so it
 * cannot catch a public name that RESOLVES to a private address (DNS rebinding)
 * — closing that needs resolve-then-pin, which neither Node's nor workerd's
 * fetch exposes. It does close the direct-literal and redirect-to-metadata
 * cases, which is what a prompt-injected URL actually reaches for.
 */
function assertPublicHttpsUrl(raw: string, requested: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpToolError(`Not a valid URL: ${raw}`, {
      hint: 'images_url entries must be absolute https:// URLs.',
    });
  }
  if (url.protocol !== 'https:') {
    throw new McpToolError(`Refusing to fetch ${describeUrl(raw, requested)}: only https:// URLs are fetched (got "${url.protocol}").`, {
      hint: 'Use an https:// URL, or send the bytes with images_base64 / gemini_upload_file.',
    });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Octets(host);
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    (host.startsWith('::ffff:') && (() => {
      const mapped = ipv4Octets(host.slice('::ffff:'.length));
      return mapped ? isPrivateIpv4(mapped) : false;
    })()) ||
    (v4 ? isPrivateIpv4(v4) : false);
  if (blocked) {
    throw new McpToolError(
      `Refusing to fetch ${describeUrl(raw, requested)}: "${url.hostname}" is a private, loopback or link-local address, not a public host.`,
      { hint: 'images_url is fetched by the server, so it must point at a publicly reachable https:// image.' },
    );
  }
  return url;
}

/** "<url>" — or "<url> (redirected from <requested>)" when they differ. */
function describeUrl(current: string, requested: string): string {
  return current === requested ? current : `${current} (redirected from ${requested})`;
}

/** Read a response body, aborting as soon as it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, url: string, requested: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooBig(url, requested, declared, maxBytes);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (some mocked/edge responses) — fall back to buffering,
    // then apply the same cap. Correct, just less eager.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooBig(url, requested, buf.byteLength, maxBytes);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooBig(url, requested, total, maxBytes, true);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function tooBig(url: string, requested: string, size: number, max: number, partial = false): McpToolError {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return new McpToolError(
    `Image at ${describeUrl(url, requested)} is ${partial ? 'over' : ''} ${mb(size)}, above the ${mb(max)} limit for images_url.`,
    { hint: 'Resize or re-encode the image, or upload it yourself with gemini_upload_file and pass the returned file_uri.' },
  );
}

export interface FetchImageOpts {
  /** Injected in tests and by the Worker; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /**
   * Content-type prefixes to accept. Defaults to images only — that is what
   * `images_url` means, and accepting `text/html` there would silently feed a
   * web page to the model as a picture. `gemini_upload_file` widens it, since
   * the Files API stores video too.
   */
  accept?: string[];
}

/**
 * Fetch one image URL server-side, validating protocol, destination, response
 * status, content type and size. Every failure names the offending URL in the
 * MESSAGE — MCP error serialization drops `hint`, and "one of your URLs failed"
 * is useless when a call carried four of them.
 */
export async function fetchRemoteImage(requestedUrl: string, opts: FetchImageOpts = {}): Promise<FetchedImage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? IMAGE_URL_MAX_BYTES;
  const accept = opts.accept ?? ['image/'];

  let current = requestedUrl;
  for (let hop = 0; ; hop++) {
    const url = assertPublicHttpsUrl(current, requestedUrl);
    let res: Response;
    try {
      // Manual redirects: every hop goes back through assertPublicHttpsUrl, so
      // a public URL cannot bounce the fetch onto the metadata service.
      res = await doFetch(url.toString(), {
        redirect: 'manual',
        headers: { accept: accept.map((p) => `${p.replace(/\/$/, '')}/*`).join(', ') },
      });
    } catch (err) {
      throw new McpToolError(
        `Could not fetch ${describeUrl(current, requestedUrl)}: ${err instanceof Error ? err.message : String(err)}`,
        { hint: 'Check the URL is reachable from the server and serves the image without authentication.' },
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new McpToolError(`Fetching ${describeUrl(current, requestedUrl)} returned HTTP ${res.status} with no Location header.`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new McpToolError(`Fetching ${requestedUrl} exceeded ${MAX_REDIRECTS} redirects (last hop: ${location}).`);
      }
      current = new URL(location, url).toString();
      continue;
    }

    if (!res.ok) {
      throw new McpToolError(`Fetching ${describeUrl(current, requestedUrl)} returned HTTP ${res.status} ${res.statusText || ''}`.trim(), {
        hint: 'The URL must be publicly readable — a login page or signed-URL expiry shows up here as 401/403/404.',
      });
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!accept.some((prefix) => contentType.startsWith(prefix))) {
      const expected = accept.map((p) => `${p.replace(/\/$/, '')}/*`).join(' or ');
      throw new McpToolError(
        `${describeUrl(current, requestedUrl)} is not ${accept.length === 1 && accept[0] === 'image/' ? 'an image' : 'usable media'}: ` +
          `the server returned Content-Type "${contentType || '(none)'}", expected ${expected}.`,
        { hint: 'Link directly to the media file, not to the page that displays it.' },
      );
    }

    const bytes = await readCapped(res, maxBytes, current, requestedUrl);
    if (bytes.byteLength === 0) {
      throw new McpToolError(`${describeUrl(current, requestedUrl)} returned an empty body.`);
    }
    return { bytes, mimeType: contentType, size: bytes.byteLength, finalUrl: current, requestedUrl };
  }
}
