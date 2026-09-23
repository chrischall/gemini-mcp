/**
 * The hosted namespace (`lib/<tenant>/`, `jobs/<tenant>/`, `gen/<tenant>/`,
 * `up/<tenant>/`), pinned once per registration.
 *
 * It used to be `tenantIdFor(GEMINI_API_KEY)`, recomputed every process. That
 * made the API key — the one credential the healthcheck tells the user to
 * rotate on `credential_rejected` — the address of everything persistent: a
 * rotation silently moved the whole namespace, and the character/style library
 * (advertised as having NO expiry), durable job records and chain sidecars all
 * came back empty (chrischall/fleet-audit#116).
 *
 * The real tenancy boundary is the blob store's per-registration key, so the
 * tenant only needs to be stable, not secret-derived. It is now read from a
 * small pin object in the registration's own store; the first process to find
 * none derives it the old way and writes it. Deriving from the CURRENT key on
 * first use is deliberate: that is exactly where every existing deployment's
 * data already lives, so the change needs no migration.
 */

/** Under `lib/` so the host's retention prune never reclaims it (blob-store.ts). */
export const TENANT_PIN_KEY = 'lib/tenant.json';

/** Same shape `tenantIdFor` produces; anything else in the pin is ignored. */
const TENANT_SHAPE = /^[0-9a-f]{12}$/;

/** The slice of the blob bucket the pin needs. */
export interface TenantPinBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

async function readPin(bucket: TenantPinBucket): Promise<string | undefined> {
  const object = await bucket.get(TENANT_PIN_KEY);
  if (!object) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as { tenant?: unknown };
    return typeof parsed.tenant === 'string' && TENANT_SHAPE.test(parsed.tenant) ? parsed.tenant : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A memoised tenant resolver for the hosted stores.
 *
 * Only a fully successful resolution is cached: a failed read rejects and is
 * retried on the next call, and a failed pin WRITE still returns the derived
 * tenant (so a transient blob hiccup does not fail the tool call) but leaves
 * the pin to be written next time.
 */
export function pinnedTenant(
  bucket: TenantPinBucket,
  derive: () => Promise<string> | string,
): () => Promise<string> {
  let cached: Promise<string> | undefined;

  async function resolve(): Promise<{ tenant: string; pinned: boolean }> {
    const pinned = await readPin(bucket);
    if (pinned) return { tenant: pinned, pinned: true };
    const tenant = await derive();
    try {
      await bucket.put(TENANT_PIN_KEY, JSON.stringify({ tenant }), {
        httpMetadata: { contentType: 'application/json' },
      });
      return { tenant, pinned: true };
    } catch {
      return { tenant, pinned: false };
    }
  }

  return () => {
    if (cached) return cached;
    const attempt = resolve().then(({ tenant, pinned }) => {
      if (!pinned && cached === attempt) cached = undefined;
      return tenant;
    });
    cached = attempt;
    attempt.catch(() => {
      if (cached === attempt) cached = undefined;
    });
    return attempt;
  };
}

/**
 * Memoise a tenant source (a static value, or a possibly-async resolver) for
 * one sink/library. Concurrent callers share one in-flight resolution and a
 * success is cached for the process, but a REJECTED resolution is dropped, not
 * cached: the hosted tenant is read from the store (`pinnedTenant`), and one
 * transient failure must not wedge its consumer for the rest of the process.
 */
export function tenantResolver<T>(source: T | (() => Promise<T> | T)): () => Promise<T> {
  let cache: Promise<T> | undefined;
  return () => {
    if (cache) return cache;
    const attempt = Promise.resolve(
      typeof source === 'function' ? (source as () => Promise<T> | T)() : source,
    );
    attempt.catch(() => { if (cache === attempt) cache = undefined; });
    return (cache = attempt);
  };
}
