import { describe, expect, it } from 'vitest';
import { createR2Library, isValidLibraryName, type LibraryBucket } from '../src/library.js';

/**
 * The library's promise is permanence and isolation: a saved character is a
 * name that keeps working next session (the bytes are COPIED into lib/, which
 * the retention sweep skips), and one account's names can never read or write
 * another's (every key is derived from the session's own tenant).
 */

const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' };
const JPG = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg' };

function fakeBucket(): LibraryBucket & { objects: Map<string, { bytes: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType });
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) as ArrayBuffer,
        httpMetadata: { contentType: hit.contentType },
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix }) {
      const matching = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { objects: matching.map((key) => ({ key })), truncated: false };
    },
  };
}

const NOW = new Date('2026-07-31T12:00:00Z');
const LATER = new Date('2026-08-02T09:00:00Z');

function library(bucket = fakeBucket(), tenant: string | (() => string) = 'aaaaaaaaaaaa', now: () => Date = () => NOW) {
  return { lib: createR2Library(bucket, { tenant, now }), bucket };
}

describe('character CRUD', () => {
  it('saves a character under lib/<tenant>/ and reads it back, image included', async () => {
    const { lib, bucket } = library();
    const record = await lib.saveCharacter({ name: 'finn', description: '6-year-old boy, curly red hair', image: PNG });

    expect(record).toMatchObject({
      name: 'finn',
      description: '6-year-old boy, curly red hair',
      image_key: 'lib/aaaaaaaaaaaa/characters/finn.img',
      mime_type: 'image/png',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    expect(bucket.objects.has('lib/aaaaaaaaaaaa/characters/finn.json')).toBe(true);
    expect(bucket.objects.get('lib/aaaaaaaaaaaa/characters/finn.img')?.bytes).toEqual(PNG.bytes);

    expect(await lib.getCharacter('finn')).toEqual(record);
    const image = await lib.readCharacterImage('finn');
    expect(image?.bytes).toEqual(PNG.bytes);
    expect(image?.mimeType).toBe('image/png');
  });

  it('upserting preserves created_at and refreshes updated_at + the image', async () => {
    const bucket = fakeBucket();
    const first = library(bucket).lib;
    await first.saveCharacter({ name: 'finn', description: 'v1', image: PNG });
    const second = library(bucket, 'aaaaaaaaaaaa', () => LATER).lib;
    const updated = await second.saveCharacter({ name: 'finn', description: 'v2', image: JPG });

    expect(updated.created_at).toBe(NOW.toISOString());
    expect(updated.updated_at).toBe(LATER.toISOString());
    expect(updated.description).toBe('v2');
    expect((await second.readCharacterImage('finn'))?.mimeType).toBe('image/jpeg');
  });

  it('lists characters sorted by name', async () => {
    const { lib } = library();
    await lib.saveCharacter({ name: 'mel', description: 'm', image: PNG });
    await lib.saveCharacter({ name: 'bongo', description: 'b', image: PNG });
    await lib.saveCharacter({ name: 'chops', description: 'c', image: PNG });
    expect((await lib.listCharacters()).map((c) => c.name)).toEqual(['bongo', 'chops', 'mel']);
  });

  it('deletes a character (record + image) and reports whether it existed', async () => {
    const { lib, bucket } = library();
    await lib.saveCharacter({ name: 'finn', description: 'd', image: PNG });
    expect(await lib.deleteCharacter('finn')).toBe(true);
    expect(bucket.objects.size).toBe(0);
    expect(await lib.getCharacter('finn')).toBeUndefined();
    expect(await lib.deleteCharacter('finn')).toBe(false);
  });

  it('two tenants with the same character name never collide', async () => {
    const bucket = fakeBucket();
    const a = createR2Library(bucket, { tenant: 'aaaaaaaaaaaa', now: () => NOW });
    const b = createR2Library(bucket, { tenant: () => 'bbbbbbbbbbbb', now: () => NOW });
    await a.saveCharacter({ name: 'finn', description: 'tenant A finn', image: PNG });
    await b.saveCharacter({ name: 'finn', description: 'tenant B finn', image: JPG });

    expect((await a.getCharacter('finn'))?.description).toBe('tenant A finn');
    expect((await b.getCharacter('finn'))?.description).toBe('tenant B finn');
    expect((await a.listCharacters())).toHaveLength(1);
    await a.deleteCharacter('finn');
    expect((await b.getCharacter('finn'))?.description).toBe('tenant B finn');
  });

  it('refuses names that could escape the namespace', async () => {
    const { lib } = library();
    for (const bad of ['../x', 'a/b', 'Finn', 'finn.json', '', 'a'.repeat(41), 'has space', '-leading']) {
      await expect(lib.saveCharacter({ name: bad, description: 'd', image: PNG })).rejects.toThrow(/Invalid library name/);
      expect(isValidLibraryName(bad)).toBe(false);
    }
    expect(isValidLibraryName('finn')).toBe(true);
    expect(isValidLibraryName('bold-cartoon-sports')).toBe(true);
  });
});

describe('style CRUD', () => {
  it('saves a style with just a prompt fragment', async () => {
    const { lib, bucket } = library();
    const record = await lib.saveStyle({ name: 'bold-cartoon-sports', promptFragment: 'bold cartoon style, thick outlines' });
    expect(record).toMatchObject({ name: 'bold-cartoon-sports', prompt_fragment: 'bold cartoon style, thick outlines' });
    expect(record.image_key).toBeUndefined();
    expect(bucket.objects.has('lib/aaaaaaaaaaaa/styles/bold-cartoon-sports.json')).toBe(true);
    expect(await lib.getStyle('bold-cartoon-sports')).toEqual(record);
  });

  it('saves and reads back an optional reference image', async () => {
    const { lib } = library();
    await lib.saveStyle({ name: 'painterly', promptFragment: 'oil on canvas', image: PNG });
    expect((await lib.getStyle('painterly'))?.image_key).toBe('lib/aaaaaaaaaaaa/styles/painterly.img');
    expect((await lib.readStyleImage('painterly'))?.bytes).toEqual(PNG.bytes);
  });

  it('re-saving without an image removes the stale reference image', async () => {
    const { lib, bucket } = library();
    await lib.saveStyle({ name: 'painterly', promptFragment: 'v1', image: PNG });
    const updated = await lib.saveStyle({ name: 'painterly', promptFragment: 'v2' });
    expect(updated.image_key).toBeUndefined();
    expect(bucket.objects.has('lib/aaaaaaaaaaaa/styles/painterly.img')).toBe(false);
  });

  it('lists and deletes styles', async () => {
    const { lib } = library();
    await lib.saveStyle({ name: 'b', promptFragment: '2' });
    await lib.saveStyle({ name: 'a', promptFragment: '1' });
    expect((await lib.listStyles()).map((s) => s.name)).toEqual(['a', 'b']);
    expect(await lib.deleteStyle('a')).toBe(true);
    expect((await lib.listStyles()).map((s) => s.name)).toEqual(['b']);
  });

  it('characters and styles are separate namespaces', async () => {
    const { lib } = library();
    await lib.saveCharacter({ name: 'same-name', description: 'char', image: PNG });
    await lib.saveStyle({ name: 'same-name', promptFragment: 'style' });
    expect(await lib.listCharacters()).toHaveLength(1);
    expect(await lib.listStyles()).toHaveLength(1);
    await lib.deleteCharacter('same-name');
    expect(await lib.getStyle('same-name')).toBeDefined();
  });
});
