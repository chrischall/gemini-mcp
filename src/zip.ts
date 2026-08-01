/**
 * Minimal ZIP writer (STORE only, no compression) for bundling a multi-image
 * result into one downloadable archive.
 *
 * Why hand-rolled: the Worker has no filesystem and no archiver dependency,
 * and the images being bundled are already-compressed PNG/JPEG — DEFLATE would
 * buy nothing. STORE entries are just headers + raw bytes + CRC32, which is
 * ~100 lines and runs identically under Node and workerd.
 *
 * Layout: [local header + name + data]* [central directory]* [EOCD]. No
 * ZIP64 (a bundle is a handful of images, far under the 4 GB / 65k-entry
 * limits), no encryption, no streaming.
 */

export interface ZipEntry {
  /** Path inside the archive, e.g. `story-01.png`. */
  name: string;
  bytes: Uint8Array;
}

/** Standard CRC-32 (IEEE 802.3), table-driven. The table is immutable. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (ZIP's native timestamp format). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
/** Version 2.0 — the minimum that understands STORE + directories. */
const VERSION = 20;
/** General-purpose bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;

/**
 * Build a STORE-only zip. `modifiedAt` stamps every entry (injectable so a
 * given input always produces identical bytes; defaults to the epoch of the
 * format, 1980).
 */
export function buildZip(entries: ZipEntry[], modifiedAt: Date = new Date(Date.UTC(1980, 0, 1))): Uint8Array {
  const { time, date } = dosDateTime(modifiedAt);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.byteLength;

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed == uncompressed under STORE
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.byteLength);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, CENTRAL_HEADER, true);
    dv.setUint16(4, VERSION, true); // version made by
    dv.setUint16(6, VERSION, true); // version needed
    dv.setUint16(8, FLAG_UTF8, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, name.byteLength, true);
    // extra len, comment len, disk start, internal attrs, external attrs = 0
    dv.setUint32(42, offset, true);
    dir.set(name, 46);

    parts.push(local, entry.bytes);
    central.push(dir);
    offset += local.byteLength + size;
  }

  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  // comment length = 0

  const total = offset + centralSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
