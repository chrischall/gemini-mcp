import { describe, it, expect } from 'vitest';
import { isSafeExtension } from '@chrischall/mcp-utils';
import { mediaExt } from '../src/images.js';

// fleet-audit#1301: mediaExt is mcp-utils `extensionForMime` plus the one
// Gemini-specific alias it lacks. Every result is a safe extension, whatever
// MIME the upstream reported, so writeUniqueFile never refuses it.
describe('mediaExt', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['IMAGE/JPEG; charset=binary', 'jpg'],
    ['image/webp', 'webp'],
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/webm', 'webm'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/ogg', 'ogg'],
    // Gemini music's opus-in-ogg type: not in the shared table, and its
    // subtype is not a plain word, so it would otherwise become "bin".
    ['audio/ogg_opus', 'ogg'],
    ['audio/L16;codec=pcm;rate=24000', 'l16'],
    ['audio/alaw', 'alaw'],
    // Unknown or odd types fall back safely instead of writing ".octet-stream".
    ['application/octet-stream', 'bin'],
    ['video/mpeg', 'mpeg'],
    ['', 'bin'],
  ])('%s -> %s', (mime, ext) => {
    expect(mediaExt(mime)).toBe(ext);
    expect(isSafeExtension(mediaExt(mime))).toBe(true);
  });
});
