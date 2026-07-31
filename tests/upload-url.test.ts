import { describe, expect, it } from 'vitest';
import {
  UPLOAD_URL_TTL_MS,
  acceptableUploadType,
  buildUploadUrl,
  createUploadUrlMinter,
  signUploadKey,
  verifyUploadSignature,
} from '../src/upload-url.js';
import { resolveSigningKey, signMediaKey, verifyMediaSignature, type SecretStore } from '../src/media-url.js';

/**
 * The upload signature is what authorizes an unauthenticated PUT to write into
 * the bucket, so everything here is adversarial: a tampered signature, an
 * expired one, and — the subtle one — a signature minted for one protocol being
 * replayed against the other.
 */

function fakeStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => { map.set(k, v); },
  };
}

const KEY = 'up/ab12cd34ef56/2026-07-31/deadbeef-photo.jpg';
const CT = 'image/jpeg';
const NOW = 1_800_000_000_000;
const EXP = NOW + UPLOAD_URL_TTL_MS;

async function signingKey() {
  return resolveSigningKey('test-secret', fakeStore());
}

describe('sign/verify upload signatures', () => {
  it('round-trips a valid signature', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyUploadSignature(k, KEY, CT, String(EXP), sig, NOW)).toEqual({ ok: true });
  });

  it('rejects a tampered signature', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    const tampered = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyUploadSignature(k, KEY, CT, String(EXP), tampered, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a signature applied to a different key', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyUploadSignature(k, 'up/ab12cd34ef56/2026-07-31/other.jpg', CT, String(EXP), sig, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a signature applied to a different content type', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyUploadSignature(k, KEY, 'image/png', String(EXP), sig, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired (but authentic) signature as expired, not invalid', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyUploadSignature(k, KEY, CT, String(EXP), sig, EXP + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects missing parameters', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyUploadSignature(k, KEY, null, String(EXP), sig, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyUploadSignature(k, KEY, CT, null, sig, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyUploadSignature(k, KEY, CT, String(EXP), null, NOW)).toEqual({ ok: false, reason: 'missing' });
  });

  it('is case-insensitive on the content type (signed lowercased)', async () => {
    const k = await signingKey();
    const sig = await signUploadKey(k, KEY, 'Image/JPEG', EXP);
    expect(await verifyUploadSignature(k, KEY, 'image/jpeg', String(EXP), sig, NOW)).toEqual({ ok: true });
  });

  it('cannot be replayed across protocols: a media GET signature is not an upload signature and vice versa', async () => {
    const k = await signingKey();
    const mediaSig = await signMediaKey(k, KEY, EXP);
    expect(await verifyUploadSignature(k, KEY, CT, String(EXP), mediaSig, NOW)).toEqual({ ok: false, reason: 'invalid' });
    const uploadSig = await signUploadKey(k, KEY, CT, EXP);
    expect(await verifyMediaSignature(k, KEY, String(EXP), uploadSig, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('buildUploadUrl', () => {
  it('URL-encodes per segment and carries ct, exp and sig', () => {
    const url = buildUploadUrl('https://connector.example/put', KEY, CT, EXP, 'SIG');
    expect(url).toBe(`https://connector.example/put/${KEY}?ct=image%2Fjpeg&exp=${EXP}&sig=SIG`);
  });

  it('strips trailing slashes from the base', () => {
    expect(buildUploadUrl('https://connector.example/put///', 'up/a/b', CT, EXP, 'SIG')).toContain('https://connector.example/put/up/a/b?');
  });
});

describe('acceptableUploadType', () => {
  it('accepts image types and refuses everything else', () => {
    expect(acceptableUploadType('image/jpeg')).toBe(true);
    expect(acceptableUploadType('image/png')).toBe(true);
    expect(acceptableUploadType('IMAGE/WebP')).toBe(true);
    expect(acceptableUploadType('video/mp4')).toBe(false);
    expect(acceptableUploadType('text/html')).toBe(false);
    expect(acceptableUploadType('application/octet-stream')).toBe(false);
    expect(acceptableUploadType('image/jpeg; charset=utf-8')).toBe(false);
    expect(acceptableUploadType('')).toBe(false);
  });
});

describe('createUploadUrlMinter', () => {
  const minter = (tenant: string | (() => string) = 'ab12cd34ef56') =>
    createUploadUrlMinter({
      baseUrl: 'https://connector.example/put',
      sign: async (key, ct, exp) => signUploadKey(await signingKey(), key, ct, exp),
      tenant,
      now: () => new Date(NOW),
      randomId: () => 'deadbeef',
    });

  it('mints a tenant-scoped up/ key with a sanitized filename and 10-minute expiry', async () => {
    const minted = await minter().mint('my photo (1).jpg', 'image/jpeg');
    expect(minted.key).toBe('up/ab12cd34ef56/2026-01-15/deadbeef-my-photo-1-.jpg'.replace('2026-01-15', new Date(NOW).toISOString().slice(0, 10)));
    expect(minted.expiresAtMs).toBe(NOW + UPLOAD_URL_TTL_MS);
    expect(minted.url).toContain(`/put/${minted.key.split('/').map(encodeURIComponent).join('/')}?ct=image%2Fjpeg&exp=${minted.expiresAtMs}&sig=`);
  });

  it('the minted URL verifies against the same secret', async () => {
    const minted = await minter().mint('photo.jpg', 'image/jpeg');
    const url = new URL(minted.url);
    const key = url.pathname.replace(/^\/put\//, '').split('/').map(decodeURIComponent).join('/');
    const check = await verifyUploadSignature(
      await signingKey(),
      key,
      url.searchParams.get('ct'),
      url.searchParams.get('exp'),
      url.searchParams.get('sig'),
      NOW,
    );
    expect(check).toEqual({ ok: true });
  });

  it('accepts a tenant thunk (the worker resolves it from the session api key)', async () => {
    const minted = await minter(() => 'feedface0000').mint('a.png', 'image/png');
    expect(minted.key.startsWith('up/feedface0000/')).toBe(true);
  });

  it('refuses a non-image content type at mint time', async () => {
    await expect(minter().mint('a.mp4', 'video/mp4')).rejects.toThrow(/image\/\*/);
  });
});
