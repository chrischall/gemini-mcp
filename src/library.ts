/**
 * The per-account reference library: named characters (a reference image + a
 * description) and named styles (a reusable prompt fragment, optionally with a
 * reference image of its own).
 *
 * Why it exists: keeping a recurring subject consistent across generations
 * means re-supplying the same reference image and the same description every
 * session — re-uploading the photo, re-typing the description, re-explaining
 * the style. The library makes each of those a NAME: save once, then pass
 * `characters: ["finn"]` / `style: "bold-cartoon-sports"` on any generation.
 *
 * Storage is the connector's R2 bucket under `lib/<tenant>/…`:
 *
 *  - `lib/<tenant>/characters/<name>.json` — the record
 *  - `lib/<tenant>/characters/<name>.img`  — the reference image bytes
 *  - `lib/<tenant>/styles/<name>.json` (+ `.img` when a reference was given)
 *
 * Two properties are load-bearing:
 *
 *  - **No expiry.** The retention cron sweeps `gen/`, `media/` and `up/` but
 *    deliberately never `lib/` (media-cleanup.ts) — a saved character outlives
 *    every signed URL and every upload. That is why saving COPIES the image
 *    bytes into `lib/` rather than storing an `r2_key` pointer: a pointer into
 *    `gen/` or `up/` would dangle after the next sweep.
 *  - **Tenant scoping by construction.** Every key this module touches is
 *    derived from the session's own tenant id; caller-supplied names are
 *    validated against a strict slug charset, so no name can address another
 *    account's namespace (or escape `lib/` at all).
 *
 * Worker-safe: no node imports, no module-scope state, structural bucket type.
 */

/** Key prefix for the library — the one prefix the retention sweep must skip. */
export const LIBRARY_KEY_PREFIX = 'lib';

/**
 * Library names are slugs: 1–40 chars, lowercase alphanumerics plus `-`/`_`,
 * starting alphanumeric. Doubles as key-safety (no `/`, `.`, whitespace).
 */
export const LIBRARY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function isValidLibraryName(name: string): boolean {
  return LIBRARY_NAME_PATTERN.test(name);
}

/** One saved character. Snake_case because records are echoed into results. */
export interface CharacterRecord {
  name: string;
  /** Prose the generation prompt can lean on ("6-year-old boy, curly red hair…"). */
  description: string;
  /** Where the reference image lives (`lib/<tenant>/characters/<name>.img`). */
  image_key: string;
  mime_type: string;
  created_at: string;
  updated_at: string;
}

/** One saved style: a prompt fragment, optionally with its own reference image. */
export interface StyleRecord {
  name: string;
  prompt_fragment: string;
  image_key?: string;
  mime_type?: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryImage {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * The per-session library handle. Hangs off `GeminiClient` on the hosted
 * connector (`client.library`); absent on stdio, where there is no shared
 * bucket — its presence is what gates the library tools, exactly as
 * `mediaSink.resign` gates `gemini_sign_media`.
 */
export interface CharacterLibrary {
  saveCharacter(input: { name: string; description: string; image: LibraryImage }): Promise<CharacterRecord>;
  getCharacter(name: string): Promise<CharacterRecord | undefined>;
  readCharacterImage(name: string): Promise<LibraryImage | undefined>;
  listCharacters(): Promise<CharacterRecord[]>;
  /** True if the character existed. */
  deleteCharacter(name: string): Promise<boolean>;

  saveStyle(input: { name: string; promptFragment: string; image?: LibraryImage }): Promise<StyleRecord>;
  getStyle(name: string): Promise<StyleRecord | undefined>;
  readStyleImage(name: string): Promise<LibraryImage | undefined>;
  listStyles(): Promise<StyleRecord[]>;
  deleteStyle(name: string): Promise<boolean>;
}

/** The slice of R2 the library needs — structural so tests can fake it. */
export interface LibraryBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface LibraryOptions {
  /** Per-account namespace — same value as the media sink's (`tenantIdFor`). */
  tenant: string | (() => Promise<string> | string);
  now?: () => Date;
}

/** Build the R2-backed library for one session. */
export function createR2Library(bucket: LibraryBucket, opts: LibraryOptions): CharacterLibrary {
  const now = opts.now ?? (() => new Date());
  let tenantCache: Promise<string> | undefined;
  const tenantId = () => (tenantCache ??= Promise.resolve(typeof opts.tenant === 'function' ? opts.tenant() : opts.tenant));

  const assertName = (name: string): string => {
    if (!isValidLibraryName(name)) {
      throw new Error(`Invalid library name "${name}" — use 1-40 lowercase letters, digits, "-" or "_" (e.g. "finn", "bold-cartoon-sports").`);
    }
    return name;
  };

  const keyFor = async (kind: 'characters' | 'styles', name: string, ext: 'json' | 'img') =>
    `${LIBRARY_KEY_PREFIX}/${await tenantId()}/${kind}/${assertName(name)}.${ext}`;

  async function readJson<T>(key: string): Promise<T | undefined> {
    const object = await bucket.get(key);
    if (!object) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as T;
    } catch {
      // A malformed record is unreadable, not fatal — callers treat it as absent.
      return undefined;
    }
  }

  async function readImage(kind: 'characters' | 'styles', name: string): Promise<LibraryImage | undefined> {
    const object = await bucket.get(await keyFor(kind, name, 'img'));
    if (!object) return undefined;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      mimeType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async function listRecords<T extends { name: string }>(kind: 'characters' | 'styles'): Promise<T[]> {
    const prefix = `${LIBRARY_KEY_PREFIX}/${await tenantId()}/${kind}/`;
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      keys.push(...page.objects.map((o) => o.key).filter((k) => k.endsWith('.json')));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    const records = await Promise.all(keys.map((k) => readJson<T>(k)));
    return records
      .filter((r): r is Awaited<T> => r !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function deleteEntry(kind: 'characters' | 'styles', name: string): Promise<boolean> {
    const jsonKey = await keyFor(kind, name, 'json');
    const existed = (await bucket.get(jsonKey)) !== null;
    await bucket.delete([jsonKey, await keyFor(kind, name, 'img')]);
    return existed;
  }

  return {
    async saveCharacter({ name, description, image }) {
      const jsonKey = await keyFor('characters', name, 'json');
      const imageKey = await keyFor('characters', name, 'img');
      const at = now().toISOString();
      const existing = await readJson<CharacterRecord>(jsonKey);
      const record: CharacterRecord = {
        name,
        description,
        image_key: imageKey,
        mime_type: image.mimeType,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      };
      await bucket.put(imageKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
      await bucket.put(jsonKey, JSON.stringify(record, null, 2), { httpMetadata: { contentType: 'application/json' } });
      return record;
    },
    async getCharacter(name) {
      return readJson<CharacterRecord>(await keyFor('characters', name, 'json'));
    },
    readCharacterImage: (name) => readImage('characters', name),
    listCharacters: () => listRecords<CharacterRecord>('characters'),
    deleteCharacter: (name) => deleteEntry('characters', name),

    async saveStyle({ name, promptFragment, image }) {
      const jsonKey = await keyFor('styles', name, 'json');
      const imageKey = await keyFor('styles', name, 'img');
      const at = now().toISOString();
      const existing = await readJson<StyleRecord>(jsonKey);
      const record: StyleRecord = {
        name,
        prompt_fragment: promptFragment,
        ...(image ? { image_key: imageKey, mime_type: image.mimeType } : {}),
        created_at: existing?.created_at ?? at,
        updated_at: at,
      };
      if (image) {
        await bucket.put(imageKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
      } else if (existing?.image_key) {
        // Re-saving without an image REPLACES the style — a stale reference
        // image left behind would silently keep steering generations.
        await bucket.delete(imageKey);
      }
      await bucket.put(jsonKey, JSON.stringify(record, null, 2), { httpMetadata: { contentType: 'application/json' } });
      return record;
    },
    async getStyle(name) {
      return readJson<StyleRecord>(await keyFor('styles', name, 'json'));
    },
    readStyleImage: (name) => readImage('styles', name),
    listStyles: () => listRecords<StyleRecord>('styles'),
    deleteStyle: (name) => deleteEntry('styles', name),
  };
}
