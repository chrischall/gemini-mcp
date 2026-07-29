/**
 * base64 ↔ bytes, and byte-size formatting.
 *
 * These conversions had grown four near-identical copies — an inline
 * `Uint8Array.from(atob(x), c => c.charCodeAt(0))` in `inputs.ts` and twice in
 * `tools/files.ts`, plus a private `decodeBase64` in `storage/media.ts` — and
 * a fifth (`encodeBase64`) that was subtly different because it is the only one
 * that has to chunk. One place, so the chunking rule can't be forgotten in copy
 * number six.
 *
 * `atob`/`btoa` rather than `Buffer`: this module is on the Worker's import
 * graph, and they are the primitive both runtimes share. Module scope stays
 * side-effect-free for the same reason (see the note in client.ts).
 */

/** Decode base64 into raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode raw bytes as base64.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads one argument per
 * byte and blows the engine's argument limit somewhere around 100–125k — i.e.
 * it works fine on every small test fixture and throws on the first real
 * photo, which is the worst possible place to learn about it.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Whole megabytes, for limits stated in tool descriptions (`25MB`). */
export function wholeMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** One-decimal megabytes, for error messages about an actual size (`15.4 MB`). */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
