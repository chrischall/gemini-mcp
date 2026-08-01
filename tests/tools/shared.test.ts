import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSeed, emit, IMAGE_SIZES, sharedImageSchema, withProgressHeartbeat, timeoutRiskHint, persistBundle, BUNDLE_MAX_TOTAL_BYTES } from '../../src/tools/shared.js';
import type { MediaSink } from '../../src/storage/media.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-shared-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('IMAGE_SIZES', () => {
  it('includes 512 as the first entry (Flash-only 0.5K size)', () => {
    expect(IMAGE_SIZES).toContain('512');
    expect(IMAGE_SIZES[0]).toBe('512');
  });

  it('includes the full set 512, 1K, 2K, 4K', () => {
    expect(IMAGE_SIZES).toEqual(['512', '1K', '2K', '4K']);
  });

  it('sharedImageSchema image_size enum accepts 512', () => {
    const result = sharedImageSchema.image_size.parse('512');
    expect(result).toBe('512');
  });
});

describe('sharedImageSchema model', () => {
  it('describes when to pick each model (Nano Banana 2 workhorse vs Pro premium vs Lite cheapest)', () => {
    const desc = sharedImageSchema.model.description ?? '';
    expect(desc).toContain('gemini-3.1-flash-image');
    expect(desc).toContain('gemini-3-pro-image');
    expect(desc).toContain('gemini-3.1-flash-lite-image');
    expect(desc).toMatch(/workhorse/i);
    expect(desc).toMatch(/premium/i);
  });

  it('accepts real model ids', () => {
    expect(sharedImageSchema.model.safeParse('gemini-3-pro-image').success).toBe(true);
    expect(sharedImageSchema.model.safeParse('gemini-2.5-flash-image').success).toBe(true);
    expect(sharedImageSchema.model.safeParse('nano-banana-pro-preview').success).toBe(true);
    expect(sharedImageSchema.model.safeParse(undefined).success).toBe(true); // optional
  });

  it('rejects model values that could escape the URL path segment', () => {
    expect(sharedImageSchema.model.safeParse('../../v1beta/other').success).toBe(false);
    expect(sharedImageSchema.model.safeParse('models/x:predict?key=').success).toBe(false);
    expect(sharedImageSchema.model.safeParse('a b').success).toBe(false);
  });
});

describe('pickSeed', () => {
  it('returns the provided seed when given', () => {
    expect(pickSeed(42)).toBe(42);
    expect(pickSeed(0)).toBe(0);
    expect(pickSeed(2_147_483_646)).toBe(2_147_483_646);
  });

  it('returns a random non-negative integer when not provided', () => {
    const s = pickSeed(undefined);
    expect(typeof s).toBe('number');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2_147_483_647);
  });
});

describe('emit onWritten', () => {
  it('reports the written absolute paths via onWritten in disk mode', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'cb' }];
    const written: string[] = [];
    // Braces, not a concise body: onWritten returns void|Promise<void>, and
    // `push`'s number return doesn't satisfy it.
    const res = await emit(named, { output_dir: dir }, undefined, (paths) => { written.push(...paths); });
    const parsed = JSON.parse((res.content[0] as { type: string; text: string }).text);
    expect(written).toEqual(parsed.images);
    expect(written).toHaveLength(1);
  });

  it('awaits an async onWritten before returning (sidecar writes finish first)', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'cb' }];
    let settled = false;
    await emit(named, { output_dir: dir }, undefined, async () => {
      await new Promise((r) => setTimeout(r, 10));
      settled = true;
    });
    expect(settled).toBe(true);
  });

  it('does not call onWritten in inline mode (nothing written)', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'cb' }];
    const onWritten = vi.fn();
    await emit(named, { inline: true }, undefined, onWritten);
    expect(onWritten).not.toHaveBeenCalled();
  });
});

describe('sharedImageSchema timeout_ms', () => {
  it('exists, is optional, and documents the defaults (60s / 120s for 4K / GEMINI_TIMEOUT_MS)', () => {
    const schema = sharedImageSchema.timeout_ms;
    expect(schema).toBeDefined();
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(120_000).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    const desc = schema.description ?? '';
    expect(desc).toContain('GEMINI_TIMEOUT_MS');
    expect(desc).toMatch(/4K/);
  });
});

describe('timeoutRiskHint', () => {
  it('flags Pro models and points at the -32001/disk-recovery escape hatch', () => {
    const h = timeoutRiskHint({ model: 'gemini-3-pro-image' });
    expect(h).toBeDefined();
    expect(h).toContain('-32001');
    expect(h).toContain('Flash');
    expect(h).toContain('Pro model');
  });

  it('flags 4K output', () => {
    expect(timeoutRiskHint({ model: 'gemini-3.1-flash-image', imageSize: '4K' })).toContain('4K');
  });

  it('flags multi-image count', () => {
    const h = timeoutRiskHint({ model: 'gemini-3.1-flash-image', count: 4 });
    expect(h).toBeDefined();
    expect(h).toContain('count=4');
  });

  it('is undefined for a fast config (Flash, ≤2K, single image)', () => {
    expect(timeoutRiskHint({ model: 'gemini-3.1-flash-image', imageSize: '2K', count: 1 })).toBeUndefined();
    expect(timeoutRiskHint({ model: 'gemini-2.5-flash-image' })).toBeUndefined();
  });

  it('matches "pro" only as a delimiter-bounded segment (no substring false-positives)', () => {
    // Real Pro ids (delimiter-bounded) still flag.
    expect(timeoutRiskHint({ model: 'gemini-3-pro-image' })).toBeDefined();
    expect(timeoutRiskHint({ model: 'nano-banana-pro' })).toBeDefined();
    // Substrings that merely contain "pro" must NOT flag.
    expect(timeoutRiskHint({ model: 'gemini-3.1-prototype-image' })).toBeUndefined();
    expect(timeoutRiskHint({ model: 'gemini-3.1-flash-proxy' })).toBeUndefined();
  });
});

describe('withProgressHeartbeat', () => {
  const ORIG = process.env.GEMINI_HEARTBEAT_MS;
  const ORIG_DEBUG = process.env.GEMINI_DEBUG;
  beforeEach(() => { vi.useFakeTimers(); delete process.env.GEMINI_DEBUG; });
  afterEach(() => {
    vi.useRealTimers();
    if (ORIG === undefined) delete process.env.GEMINI_HEARTBEAT_MS;
    else process.env.GEMINI_HEARTBEAT_MS = ORIG;
    if (ORIG_DEBUG === undefined) delete process.env.GEMINI_DEBUG;
    else process.env.GEMINI_DEBUG = ORIG_DEBUG;
  });

  function extraWithToken() {
    return {
      _meta: { progressToken: 'tok-1' },
      sendNotification: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('sends notifications/progress with the caller token while fn is pending', async () => {
    const extra = extraWithToken();
    let resolveFn!: (v: string) => void;
    const p = withProgressHeartbeat(extra, 'Generating image', () => new Promise<string>((r) => { resolveFn = r; }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(extra.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({ progressToken: 'tok-1', progress: 1, message: expect.stringContaining('Generating image') }),
    }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(extra.sendNotification).toHaveBeenCalledTimes(2);
    resolveFn('done');
    await expect(p).resolves.toBe('done');
  });

  it('stops the heartbeat once fn settles', async () => {
    const extra = extraWithToken();
    await withProgressHeartbeat(extra, 'x', () => Promise.resolve('ok'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extra.sendNotification).not.toHaveBeenCalled();
  });

  it('propagates fn rejection and stops the heartbeat', async () => {
    const extra = extraWithToken();
    await expect(withProgressHeartbeat(extra, 'x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extra.sendNotification).not.toHaveBeenCalled();
  });

  it('is a pass-through when the caller sent no progressToken', async () => {
    const extra = { _meta: {}, sendNotification: vi.fn() };
    const result = await withProgressHeartbeat(extra, 'x', () => Promise.resolve(42));
    expect(result).toBe(42);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extra.sendNotification).not.toHaveBeenCalled();
  });

  // Diagnostics (GEMINI_DEBUG): stderr lines surface in the host's MCP log
  // (Claude Desktop: ~/Library/Logs/Claude/mcp-server-*.log) so we can see
  // whether the host actually requested progress — the root-cause signal for a
  // host-imposed tools/call timeout.
  it('logs an active-heartbeat diagnostic to stderr when GEMINI_DEBUG is set', async () => {
    process.env.GEMINI_DEBUG = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extra = extraWithToken();
    let resolveFn!: (v: string) => void;
    const p = withProgressHeartbeat(extra, 'Generating image', () => new Promise<string>((r) => { resolveFn = r; }));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('progressToken present'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('still working (10s)'));
    resolveFn('done');
    await expect(p).resolves.toBe('done');
  });

  it('logs a "no progressToken" diagnostic when the host omits the token', async () => {
    process.env.GEMINI_DEBUG = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extra = { _meta: {}, sendNotification: vi.fn() };
    await withProgressHeartbeat(extra, 'Generating image', () => Promise.resolve('ok'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('no progressToken'));
  });

  it('stays silent by default (no GEMINI_DEBUG)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extra = extraWithToken();
    let resolveFn!: (v: string) => void;
    const p = withProgressHeartbeat(extra, 'x', () => new Promise<string>((r) => { resolveFn = r; }));
    await vi.advanceTimersByTimeAsync(20_000);
    resolveFn('done');
    await p;
    expect(err).not.toHaveBeenCalled();
  });

  it('survives sendNotification rejections (client may have gone away)', async () => {
    const extra = {
      _meta: { progressToken: 7 },
      sendNotification: vi.fn().mockRejectedValue(new Error('connection closed')),
    };
    let resolveFn!: (v: string) => void;
    const p = withProgressHeartbeat(extra, 'x', () => new Promise<string>((r) => { resolveFn = r; }));
    await vi.advanceTimersByTimeAsync(20_000);
    resolveFn('ok');
    await expect(p).resolves.toBe('ok');
  });

  it('GEMINI_HEARTBEAT_MS tunes the interval; 0 disables', async () => {
    process.env.GEMINI_HEARTBEAT_MS = '50';
    const extra = extraWithToken();
    let resolveFn!: (v: string) => void;
    const p = withProgressHeartbeat(extra, 'x', () => new Promise<string>((r) => { resolveFn = r; }));
    await vi.advanceTimersByTimeAsync(150);
    expect(extra.sendNotification).toHaveBeenCalledTimes(3);
    resolveFn('ok');
    await p;

    process.env.GEMINI_HEARTBEAT_MS = '0';
    const off = extraWithToken();
    let resolveOff!: (v: string) => void;
    const pOff = withProgressHeartbeat(off, 'x', () => new Promise<string>((r) => { resolveOff = r; }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(off.sendNotification).not.toHaveBeenCalled();
    resolveOff('ok');
    await pOff;
  });
});

describe('emit with meta', () => {
  it('merges meta into the disk-path result', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { output_dir: dir }, { model: 'gemini-3-pro-image', seed: 42 });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.model).toBe('gemini-3-pro-image');
    expect(parsed.seed).toBe(42);
    expect(parsed.images).toHaveLength(1);
  });

  it('prepends a text block for inline mode when meta present', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { inline: true }, { model: 'gemini-3-pro-image', seed: 99 });
    expect(res.content[0].type).toBe('text');
    const meta = JSON.parse((res.content[0] as { type: string; text: string }).text);
    expect(meta.seed).toBe(99);
    expect(res.content[1].type).toBe('image');
  });

  it('does not prepend text block for inline mode when no meta', async () => {
    const named = [{ image: { base64: PNG, mimeType: 'image/png' }, base: 'test' }];
    const res = await emit(named, { inline: true });
    expect(res.content[0].type).toBe('image');
  });
});

describe('persistBundle size guard', () => {
  const objectSink = (persist: MediaSink['persist']): MediaSink =>
    ({ kind: 'r2', persistsFiles: false, persist }) as MediaSink;

  it('skips an over-cap set BEFORE decoding and says so instead of returning {} silently', async () => {
    // Two images that together estimate just over the cap. The guard works on
    // base64 LENGTH, so no decode (and no 4x memory peak) ever happens.
    const half = 'A'.repeat(Math.ceil((BUNDLE_MAX_TOTAL_BYTES / 2) * (4 / 3)) + 8);
    const persist = vi.fn();
    const named = [1, 2].map((i) => ({ base: `img-${i}`, image: { base64: half, mimeType: 'image/png' } }));
    const out = await persistBundle(named, objectSink(persist), 'set');
    expect(out.bundle_url).toBeUndefined();
    expect(String(out.bundle_skipped)).toContain('bundling cap');
    expect(persist).not.toHaveBeenCalled();
  });

  it('surfaces bundle_skipped when storing the zip throws, instead of a silent {}', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('boom'));
    const named = [1, 2].map((i) => ({ base: `img-${i}`, image: { base64: PNG, mimeType: 'image/png' } }));
    const out = await persistBundle(named, objectSink(persist), 'set');
    expect(out.bundle_url).toBeUndefined();
    expect(String(out.bundle_skipped)).toContain('download them individually');
  });

  it('still returns {} where a bundle was never promised (disk sink / single image)', async () => {
    const persist = vi.fn();
    const single = [{ base: 'img', image: { base64: PNG, mimeType: 'image/png' } }];
    expect(await persistBundle(single, objectSink(persist), 'set')).toEqual({});
    expect(await persistBundle(single, undefined, 'set')).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });
});
