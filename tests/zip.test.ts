import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../src/zip.js';

/**
 * The zip writer's whole contract is "a stock unzip can open it". With no
 * unzipper in the test deps, that is asserted two ways: CRC-32 against the
 * published test vectors, and a structural parse of the emitted headers
 * (signatures, sizes, offsets, EOCD bookkeeping) — the fields an extractor
 * actually navigates by.
 */

const enc = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the published test vectors', () => {
    expect(crc32(enc(''))).toBe(0x00000000);
    expect(crc32(enc('abc'))).toBe(0x352441c2);
    expect(crc32(enc('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
}
function u16(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(at, true);
}

describe('buildZip', () => {
  const A = { name: 'a.png', bytes: enc('alpha-bytes') };
  const B = { name: 'story/b.jpg', bytes: enc('beta') };

  it('emits a well-formed STORE archive: local headers, central directory, EOCD', () => {
    const zip = buildZip([A, B]);

    // Entry 1 local header at offset 0.
    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u16(zip, 8)).toBe(0); // STORE
    expect(u32(zip, 14)).toBe(crc32(A.bytes));
    expect(u32(zip, 18)).toBe(A.bytes.byteLength);
    expect(u32(zip, 22)).toBe(A.bytes.byteLength);
    expect(u16(zip, 26)).toBe(A.name.length);
    expect(new TextDecoder().decode(zip.slice(30, 30 + A.name.length))).toBe('a.png');
    // Raw bytes follow immediately (STORE = no transformation).
    const dataStart = 30 + A.name.length;
    expect(new TextDecoder().decode(zip.slice(dataStart, dataStart + A.bytes.byteLength))).toBe('alpha-bytes');

    // EOCD at the tail.
    const eocdAt = zip.byteLength - 22;
    expect(u32(zip, eocdAt)).toBe(0x06054b50);
    expect(u16(zip, eocdAt + 8)).toBe(2);
    expect(u16(zip, eocdAt + 10)).toBe(2);

    // The central directory offset recorded in EOCD points at a central header.
    const centralAt = u32(zip, eocdAt + 16);
    expect(u32(zip, centralAt)).toBe(0x02014b50);
    // First central entry names entry 1 and points back at offset 0.
    expect(u16(zip, centralAt + 28)).toBe(A.name.length);
    expect(u32(zip, centralAt + 42)).toBe(0);
    expect(new TextDecoder().decode(zip.slice(centralAt + 46, centralAt + 46 + A.name.length))).toBe('a.png');

    // Second central entry's local-header offset lands on a local signature.
    const second = centralAt + 46 + A.name.length;
    expect(u32(zip, second)).toBe(0x02014b50);
    const offset2 = u32(zip, second + 42);
    expect(u32(zip, offset2)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip.slice(offset2 + 30, offset2 + 30 + B.name.length))).toBe('story/b.jpg');

    // Central directory size bookkeeping is consistent.
    expect(u32(zip, eocdAt + 12)).toBe(eocdAt - centralAt);
  });

  it('is deterministic for the same inputs', () => {
    expect(buildZip([A, B])).toEqual(buildZip([A, B]));
  });

  it('handles an empty archive (EOCD only)', () => {
    const zip = buildZip([]);
    expect(zip.byteLength).toBe(22);
    expect(u32(zip, 0)).toBe(0x06054b50);
    expect(u16(zip, 8)).toBe(0);
  });
});
