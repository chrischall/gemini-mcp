/**
 * The one place that knows how a link into the object store is SHAPED.
 *
 * There are two kinds of signed link — a media GET (`?exp=&sig=`) and an
 * upload PUT (`?ct=&exp=&sig=`) — and before this module they were two
 * independent copies of the same string building, in two files, each holding
 * its own base URL. That is exactly how the re-host from the retired Cloudflare
 * connector to mcp-host split them: the media builder was moved onto the new
 * `https://host/b/<registrationId>` base and the upload builder was a separate
 * edit in a separate file, so nothing structural said the two had to agree.
 *
 * Both builders now delegate here, and {@link signedLinks} binds ONE base URL
 * to both of them at once, so the next re-host either moves both or neither.
 *
 * Byte-compatible with what shipped: the path is percent-encoded per segment
 * (separators survive, everything else is encoded — the gateway decodes per
 * segment and verifies against the LOGICAL key), and the query parameters keep
 * their historical order. Every link ever minted still parses.
 */

/**
 * `<base>/<encoded key>?<params>`.
 *
 * Parameter order is insertion order and is part of the observable shape —
 * nothing verifies against it, but the curl commands in `curl_hint` and every
 * link in a user's history read the same way across a redeploy.
 */
export function signedObjectUrl(
  baseUrl: string,
  key: string,
  params: Record<string, string | number>,
): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) query.set(name, String(value));
  return `${baseUrl.replace(/\/+$/, '')}/${path}?${query}`;
}

/**
 * Both link shapes for one store, bound to a single base URL.
 *
 * Take this rather than a base-URL string wherever both kinds of link are
 * needed: a caller cannot hold one of these and still point the GET and the
 * PUT at different hosts.
 */
export interface SignedLinks {
  /** The base every link is built on — `https://host/b/<registrationId>`. */
  readonly base: string;
  /** A media GET link: the shape `/media` has always used. */
  media(key: string, expiresAtMs: number, signature: string): string;
  /** An upload PUT link: media's shape plus the signed content type. */
  upload(key: string, contentType: string, expiresAtMs: number, signature: string): string;
}

/** Bind one base URL to both link shapes. */
export function signedLinks(baseUrl: string): SignedLinks {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    base,
    media: (key, expiresAtMs, signature) =>
      signedObjectUrl(base, key, { exp: expiresAtMs, sig: signature }),
    upload: (key, contentType, expiresAtMs, signature) =>
      signedObjectUrl(base, key, { ct: contentType.toLowerCase(), exp: expiresAtMs, sig: signature }),
  };
}
