/**
 * Signed URLs for generated media on the hosted connector.
 *
 * The problem these exist to solve: a chat client shows the user whatever the
 * assistant *says*, and MCP inline image blocks are not that. On claude.ai and
 * the mobile app the bytes arrive in the model's context and are never rendered
 * — so a generation that billed successfully is invisible. A URL is the only
 * portable answer: a human can tap it and an agent can curl it.
 *
 * That means the media route cannot sit behind the connector's OAuth, because
 * a browser opening a link carries no bearer token. The signature IS the
 * authorization: a URL is valid for one key until it expires, and nothing else
 * in the bucket is reachable without one.
 *
 * Kept free of any Cloudflare import so the whole thing is testable under Node:
 * WebCrypto is the only primitive used, and it exists on both runtimes.
 */

import { signedLinks } from './signed-url.js';

/** How long a freshly minted media URL stays valid. Matches Files API retention. */
export const MEDIA_URL_TTL_MS = 48 * 60 * 60 * 1000;

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// The KV-backed signing-secret helpers (`resolveSigningKey` /
// `loadSigningKey` / `SecretStore`) went with the Cloudflare Worker: on
// mcp-host the signing key is `MCP_BLOB_SIGNING_KEY`, injected by the host and
// used by `blob-store.ts` (fleet-audit#1251).

/** The bytes covered by a signature: the object key and the expiry, nothing else. */
function payload(key: string, expiresAtMs: number): Uint8Array {
  return new TextEncoder().encode(`${key}\n${expiresAtMs}`);
}

/** Sign one object key for use until `expiresAtMs`. */
export async function signMediaKey(signingKey: CryptoKey, key: string, expiresAtMs: number): Promise<string> {
  return base64UrlEncode(await crypto.subtle.sign('HMAC', signingKey, payload(key, expiresAtMs) as BufferSource));
}

/**
 * Check a `?exp=&sig=` pair against an object key.
 *
 * Verification goes through `crypto.subtle.verify` rather than a string
 * comparison, so it is constant-time — a `===` on the signature would leak the
 * expected value one byte at a time to anyone willing to time it.
 */
export async function verifyMediaSignature(
  signingKey: CryptoKey,
  key: string,
  exp: string | null,
  sig: string | null,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'expired' | 'invalid' }> {
  if (!exp || !sig) return { ok: false, reason: 'missing' };
  const expiresAtMs = Number(exp);
  if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: 'invalid' };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', signingKey, base64UrlDecode(sig) as BufferSource, payload(key, expiresAtMs) as BufferSource);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  // Signature first, then expiry: an expired-but-authentic link deserves a
  // different message from a forged one, and saying "expired" about a forgery
  // would confirm the attacker got the signature right.
  if (!valid) return { ok: false, reason: 'invalid' };
  if (nowMs > expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * `<base>/<key>?exp=…&sig=…` — the URL handed back to the caller.
 *
 * Delegates to {@link signedLinks} so this and `buildUploadUrl` cannot drift
 * apart the way they did across the re-host. Prefer taking a {@link SignedLinks}
 * over a base-URL string in new code; this wrapper exists for callers that
 * already hold a base.
 */
export function buildMediaUrl(baseUrl: string, key: string, expiresAtMs: number, signature: string): string {
  return signedLinks(baseUrl).media(key, expiresAtMs, signature);
}
