import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { createPublicOnlyDispatcher, isPublicAddress, type Resolver } from '@chrischall/mcp-utils/netguard';
import { fetch as undiciFetch } from 'undici';
import { formatMb } from './bytes.js';

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
 *    metadata address, the classic escalation target. Literals and private
 *    names are refused up front (mcp-utils netguard `isPublicAddress`, the
 *    fleet's one address table), and on a local install every connection goes
 *    through netguard's public-only dispatcher, which resolves the name itself
 *    and pins the socket to the addresses it vetted — so a public name that
 *    resolves or REBINDS to a private address is refused at connect
 *    (fleet-audit#1252). Behind an egress proxy (`HTTPS_PROXY`, which mcp-host
 *    sets for its children) the global fetch is used instead: the child cannot
 *    resolve names there at all, and the proxy resolves and applies the same
 *    public-only table itself.
 *  - **Redirects are followed MANUALLY**, revalidating every hop. `redirect:
 *    'follow'` would let a public URL bounce to `http://169.254.169.254/` with
 *    no further check, which makes the origin check theatre.
 *  - **A hard byte cap enforced while streaming**, not from `Content-Length` —
 *    a hostile or merely wrong server can under-report or omit it.
 *
 * Module scope stays side-effect-free (the same rule as client.ts): the tool
 * registrars import this file, and importing must never do work.
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
export const MAX_REDIRECTS = 5;
/**
 * Per-hop abort budget. Matches the client's default upstream timeout so a URL
 * fetch is bounded like every other network call this server makes; callers
 * override it with the same `timeout_ms` resolution (see `resolveTimeoutMs`).
 */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

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

/**
 * Reject a URL that isn't a plain public https endpoint: a private name
 * (`localhost`, `*.local`, `*.internal`) or a non-public IP literal, judged by
 * mcp-utils netguard `isPublicAddress` (which fails closed on a literal it
 * cannot parse). A public NAME that resolves inward is caught later, at
 * connect, by the pinned dispatcher (see the module header).
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
  // `new URL` always brackets an IPv6 hostname, which is the reliable signal
  // that this is a literal and not a name.
  const rawHost = url.hostname.toLowerCase();
  const isIpv6Literal = rawHost.startsWith('[') && rawHost.endsWith(']');
  // A name may carry a trailing dot (the fully-qualified spelling): WHATWG URL
  // keeps it, and `localhost.` still resolves to loopback, so the suffix
  // checks below must see the name without it (chrischall/fleet-audit#472).
  const host = isIpv6Literal ? rawHost.slice(1, -1) : rawHost.replace(/\.+$/, '');
  const ipv4Literal = /^[0-9.]+$/.test(host);
  const blocked = isIpv6Literal || ipv4Literal
    // isPublicAddress fails CLOSED on a literal it cannot parse: a guard that
    // allows what it does not understand is the wrong default for this control.
    ? !isPublicAddress(host)
    : host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      // Private-network names: Fly's 6PN (`<app>.internal`, where the hosted
      // build runs) and GCP's metadata server (`metadata.google.internal`).
      host === 'internal' ||
      host.endsWith('.internal');
  if (blocked) {
    throw new McpToolError(
      `Refusing to fetch ${describeUrl(raw, requested)}: "${url.hostname}" is a private, loopback or link-local address, not a public host.`,
      { hint: 'images_url is fetched by the server, so it must point at a publicly reachable https:// image.' },
    );
  }
  return url;
}

/**
 * Last path segment of a URL, for the Files API display name. Cosmetic — the
 * API keys on the resource name it returns, not on this — so an unparseable
 * URL degrades to `fallback` rather than failing the upload.
 *
 * `fallback` is REQUIRED, deliberately. This function was created by merging
 * two byte-identical copies that differed only in their default (`'image'` in
 * `inputs.ts`, `'upload'` in `tools/files.ts`), and taking one of those
 * defaults silently changed the other caller's behaviour — `gemini_upload_file`
 * started naming a fallback upload "image" even for an mp4, and disagreed with
 * the other two branches of its own handler. With no default, merging callers
 * that disagree stops being something you can do by accident.
 */
export function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name).slice(0, 120) : fallback;
  } catch {
    return fallback;
  }
}

/** "<url>" — or "<url> (redirected from <requested>)" when they differ. */
function describeUrl(current: string, requested: string): string {
  return current === requested ? current : `${current} (redirected from ${requested})`;
}

/** Read a response body, aborting as soon as it exceeds `maxBytes`. */
export async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
  requested: string,
  subject?: CapSubject,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooBig(url, requested, declared, maxBytes, false, subject);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (some mocked/edge responses) — fall back to buffering,
    // then apply the same cap. Correct, just less eager.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooBig(url, requested, buf.byteLength, maxBytes, false, subject);
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
        throw tooBig(url, requested, total, maxBytes, true, subject);
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

/** A transport-level failure, told apart from a plain unreachable host. */
function fetchFailure(err: unknown, current: string, requested: string, timeoutMs: number): McpToolError {
  if (refusedAtConnect(err)) {
    let host = current;
    try {
      host = new URL(current).hostname;
    } catch {
      /* keep the raw URL */
    }
    return new McpToolError(
      `Refusing to fetch ${describeUrl(current, requested)}: "${host}" resolves to a private, loopback or link-local address, not a public host.`,
      { hint: 'images_url is fetched by the server, so it must point at a publicly reachable https:// image.' },
    );
  }
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new McpToolError(`Fetching ${describeUrl(current, requested)} timed out after ${timeoutMs}ms.`, {
      hint: 'The server accepted the connection but did not finish sending the image. Try a different URL, or raise timeout_ms.',
    });
  }
  return new McpToolError(
    `Could not fetch ${describeUrl(current, requested)}: ${err instanceof Error ? err.message : String(err)}`,
    { hint: 'Check the URL is reachable from the server and serves the image without authentication.' },
  );
}

/** True when netguard's pinned dispatcher refused the connection (anywhere in the cause chain). */
function refusedAtConnect(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i += 1) {
    if ((e as { name?: unknown }).name === 'UrlNotAllowedError') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Is this process behind an egress proxy? mcp-host hands its children
 * `HTTPS_PROXY` (+ `NODE_USE_ENV_PROXY=1`); the child cannot resolve names
 * there, and the proxy applies the public-only table itself.
 */
function egressProxied(): boolean {
  return Boolean(readEnvVar('HTTPS_PROXY') ?? readEnvVar('https_proxy'));
}

/**
 * `subject` names what was too big and how to act on it. It defaults to the
 * `images_url` wording because that is where the cap started, but the reader is
 * shared now — a generated-video download reusing it must not tell the caller
 * to resize an image.
 */
function tooBig(url: string, requested: string, size: number, max: number, partial = false, subject?: CapSubject): McpToolError {
  const what = subject ?? IMAGE_CAP_SUBJECT;
  return new McpToolError(
    `${what.noun} at ${describeUrl(url, requested)} is ${partial ? 'over ' : ''}${formatMb(size)}, above the ${formatMb(max)} limit${what.limitFor ? ` for ${what.limitFor}` : ''}.`,
    { hint: what.hint },
  );
}

/** How {@link readCapped} should describe a body that blew its cap. */
export interface CapSubject {
  /** Sentence-leading noun, e.g. "Image" or "Generated video". */
  noun: string;
  /** What the limit belongs to, e.g. "images_url"; omitted when it has no name. */
  limitFor?: string;
  hint: string;
}

const IMAGE_CAP_SUBJECT: CapSubject = {
  noun: 'Image',
  limitFor: 'images_url',
  hint: 'Resize or re-encode the image, or upload it yourself with gemini_upload_file and pass the returned file_uri.',
};

export interface FetchImageOpts {
  /**
   * Injected in tests: used as-is, with no connect-time pin. Omitted, the
   * fetch is pinned to public addresses (see the module header).
   */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /**
   * Abort budget for one hop, covering the response BODY as well as the
   * headers. Every other upstream call this server makes is bounded by
   * `resolveTimeoutMs()`; without one here a server that accepts the
   * connection and then trickles bytes hangs the tool call indefinitely — and
   * the progress heartbeat around `resolveImageInputs` actively stops the host
   * from timing it out for us. `0` disables (tests that never resolve).
   */
  timeoutMs?: number;
  /**
   * Content-type prefixes to accept. Defaults to images only — that is what
   * `images_url` means, and accepting `text/html` there would silently feed a
   * web page to the model as a picture. `gemini_upload_file` widens it, since
   * the Files API stores video too.
   */
  accept?: string[];
  /**
   * How the pinned dispatcher resolves names (tests). Defaults to the OS
   * resolver. Ignored when `fetchImpl` is injected or behind an egress proxy.
   */
  resolve?: Resolver;
}

/**
 * Fetch one image URL server-side, validating protocol, destination, response
 * status, content type and size. Every failure names the offending URL in the
 * MESSAGE — MCP error serialization drops `hint`, and "one of your URLs failed"
 * is useless when a call carried four of them.
 */
export async function fetchRemoteImage(requestedUrl: string, opts: FetchImageOpts = {}): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? IMAGE_URL_MAX_BYTES;
  const accept = opts.accept ?? ['image/'];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  // An injected fetch (tests) is used as-is. Otherwise: pinned to public
  // addresses on a local install; the global fetch behind an egress proxy.
  const dispatcher =
    opts.fetchImpl === undefined && !egressProxied()
      ? createPublicOnlyDispatcher(opts.resolve ? { resolve: opts.resolve } : {})
      : undefined;
  const doFetch: typeof fetch =
    opts.fetchImpl ??
    (dispatcher
      ? (((input: string, init?: RequestInit) =>
          undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch)
      : (...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    return await fetchHops(requestedUrl, doFetch, { maxBytes, accept, timeoutMs });
  } finally {
    await dispatcher?.destroy().catch(() => {});
  }
}

/** The redirect loop of {@link fetchRemoteImage}, over the chosen fetch. */
async function fetchHops(
  requestedUrl: string,
  doFetch: typeof fetch,
  { maxBytes, accept, timeoutMs }: { maxBytes: number; accept: string[]; timeoutMs: number },
): Promise<FetchedImage> {
  let current = requestedUrl;
  for (let hop = 0; ; hop++) {
    const url = assertPublicHttpsUrl(current, requestedUrl);
    // One budget per hop, applied to the body read as well: aborting the signal
    // errors the response stream, so a trickling server cannot outlast it.
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let res: Response;
    try {
      // Manual redirects: every hop goes back through assertPublicHttpsUrl, so
      // a public URL cannot bounce the fetch onto the metadata service.
      res = await doFetch(url.toString(), {
        redirect: 'manual',
        headers: { accept: accept.map((p) => `${p.replace(/\/$/, '')}/*`).join(', ') },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw fetchFailure(err, current, requestedUrl, timeoutMs);
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

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, maxBytes, current, requestedUrl);
    } catch (err) {
      // The cap is its own actionable error; anything else here is a transport
      // failure mid-body, most usefully reported as one (including the timeout).
      if (err instanceof McpToolError) throw err;
      throw fetchFailure(err, current, requestedUrl, timeoutMs);
    }
    if (bytes.byteLength === 0) {
      throw new McpToolError(`${describeUrl(current, requestedUrl)} returned an empty body.`);
    }
    return { bytes, mimeType: contentType, size: bytes.byteLength, finalUrl: current, requestedUrl };
  }
}
