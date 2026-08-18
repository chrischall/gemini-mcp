import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { signedObjectUrl, signedLinks } from '../src/signed-url.js';
import { buildMediaUrl } from '../src/media-url.js';
import { buildUploadUrl } from '../src/upload-url.js';

/**
 * Links into the object store have exactly ONE shape-owner.
 *
 * Media GETs and upload PUTs are the same store reached two ways, and they used
 * to be built by two hand-rolled template literals in two files, each holding
 * its own base URL. The re-host from the retired Cloudflare connector to
 * mcp-host moved the media base onto `https://host/b/<registrationId>` and the
 * upload builder was a separate edit — nothing structural required both.
 */

describe('signedObjectUrl', () => {
  it('encodes each key segment but never the separators', () => {
    // The gateway decodes per segment and verifies against the LOGICAL key:
    // encoding the whole string would invent segments, encoding nothing would
    // break on a space.
    expect(signedObjectUrl('https://h/b/reg_1', 'up/t/a b/c+d.jpg', { exp: 1 })).toBe(
      'https://h/b/reg_1/up/t/a%20b/c%2Bd.jpg?exp=1',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(signedObjectUrl('https://h/b/reg_1///', 'k', {})).toBe('https://h/b/reg_1/k?');
  });

  it('keeps parameters in insertion order, which is the shape users see', () => {
    expect(signedObjectUrl('https://h', 'k', { ct: 'image/jpeg', exp: 2, sig: 'S' })).toBe(
      'https://h/k?ct=image%2Fjpeg&exp=2&sig=S',
    );
  });
});

describe('the two link shapes', () => {
  const links = signedLinks('https://mcp.example/b/reg_9f2c1a7b');

  it('differ only by the signed content type', () => {
    expect(links.media('gen/t/x.png', 42, 'SIG')).toBe('https://mcp.example/b/reg_9f2c1a7b/gen/t/x.png?exp=42&sig=SIG');
    expect(links.upload('up/t/x.jpg', 'image/jpeg', 42, 'SIG')).toBe(
      'https://mcp.example/b/reg_9f2c1a7b/up/t/x.jpg?ct=image%2Fjpeg&exp=42&sig=SIG',
    );
  });

  it('lowercases the content type, matching what the signature covers', () => {
    expect(links.upload('up/x.jpg', 'IMAGE/JPEG', 1, 'S')).toContain('ct=image%2Fjpeg');
  });

  it('cannot be pointed at two different hosts — one base builds both', () => {
    const media = new URL(links.media('gen/x.png', 1, 'S'));
    const upload = new URL(links.upload('up/x.jpg', 'image/jpeg', 1, 'S'));
    expect(upload.origin).toBe(media.origin);
    expect(upload.pathname.startsWith('/b/reg_9f2c1a7b/')).toBe(true);
    expect(media.pathname.startsWith('/b/reg_9f2c1a7b/')).toBe(true);
  });

  it('stays byte-identical to the builders every outstanding link was minted by', () => {
    // Callers still holding a base URL go through these wrappers; a link
    // already in someone's history must keep resolving.
    expect(buildMediaUrl('https://mcp.example/b/reg_9f2c1a7b', 'gen/t/x.png', 42, 'SIG')).toBe(
      links.media('gen/t/x.png', 42, 'SIG'),
    );
    expect(buildUploadUrl('https://mcp.example/b/reg_9f2c1a7b', 'up/t/x.jpg', 'image/jpeg', 42, 'SIG')).toBe(
      links.upload('up/t/x.jpg', 'image/jpeg', 42, 'SIG'),
    );
  });
});

describe('nothing else builds a store link by hand', () => {
  it('confines `?exp=…&sig=` string-building to the shape-owner and the bucket adapter', () => {
    // A hand-rolled query is how the two halves drifted. `signed-url.ts` owns
    // the shape; `blob-store.ts` builds its own because it signs and fetches in
    // one step, and `tests/blob-store.test.ts` pins that copy to the gateway.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
      });
    const offenders = walk('src').filter(
      (path) =>
        !['src/signed-url.ts', 'src/blob-store.ts'].includes(path.replace(/\\/g, '/')) &&
        /[?&]exp=\$\{/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
