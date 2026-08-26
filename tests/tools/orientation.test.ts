import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerInteractTools } from '../../src/tools/interact.js';
import { registerVideoTools } from '../../src/tools/video.js';
import { GeminiClient } from '../../src/client.js';
import { McpToolError } from '@chrischall/mcp-utils';
import { resolveAspectRatio, ORIENTATIONS, ASPECT_RATIOS, buildMeta } from '../../src/tools/shared.js';

/**
 * `orientation` is a shorthand, not a second source of truth.
 *
 * Every generation tool already accepted `aspect_ratio`, so landscape and
 * portrait output were always *possible* — but the parameter was described only
 * as "Output aspect ratio" against a 14-value enum, with nothing connecting the
 * words a person actually uses to `9:16`. The capability was there and
 * unreachable, which for a tool surface is the same as missing.
 *
 * The rules that matter: an explicit ratio always wins (it is the more specific
 * request), and an orientation a model cannot honour is refused out loud rather
 * than quietly rounded to a shape the caller did not ask for.
 */

const IMAGE = ASPECT_RATIOS;
const VIDEO = ['16:9', '9:16'] as const;

describe('resolveAspectRatio', () => {
  it('maps the three orientations to one ratio each, the same for images and video', () => {
    expect(resolveAspectRatio({ orientation: 'landscape' }, IMAGE)).toBe('16:9');
    expect(resolveAspectRatio({ orientation: 'portrait' }, IMAGE)).toBe('9:16');
    expect(resolveAspectRatio({ orientation: 'square' }, IMAGE)).toBe('1:1');
    // Same words, same meaning, different medium — the point of one mapping.
    expect(resolveAspectRatio({ orientation: 'landscape' }, VIDEO)).toBe('16:9');
    expect(resolveAspectRatio({ orientation: 'portrait' }, VIDEO)).toBe('9:16');
  });

  it('lets an explicit aspect_ratio win, since it is the more specific request', () => {
    expect(resolveAspectRatio({ aspect_ratio: '21:9', orientation: 'portrait' }, IMAGE)).toBe('21:9');
    // Even when the two agree, the explicit value is what is returned.
    expect(resolveAspectRatio({ aspect_ratio: '4:5', orientation: 'portrait' }, IMAGE)).toBe('4:5');
  });

  it('returns undefined when neither is given, so the model default still applies', () => {
    expect(resolveAspectRatio({}, IMAGE)).toBeUndefined();
  });

  it('refuses an orientation the model cannot produce instead of rounding it', () => {
    // omni has no square. Silently returning 16:9 would hand back a shape the
    // caller never asked for and could not tell had been substituted.
    expect(() => resolveAspectRatio({ orientation: 'square' }, VIDEO)).toThrow(McpToolError);
    try {
      resolveAspectRatio({ orientation: 'square' }, VIDEO);
    } catch (err) {
      // Remediation in the MESSAGE: the host drops `hint`.
      expect((err as Error).message).toMatch(/square/);
      expect((err as Error).message).toMatch(/16:9/);
      expect((err as Error).message).toMatch(/9:16/);
    }
  });

  it('covers every orientation it advertises', () => {
    for (const orientation of ORIENTATIONS) {
      expect(typeof resolveAspectRatio({ orientation }, IMAGE)).toBe('string');
    }
  });

  it('only ever returns a ratio the caller declared supported', () => {
    for (const orientation of ORIENTATIONS) {
      const ratio = resolveAspectRatio({ orientation }, IMAGE);
      expect(IMAGE as readonly string[]).toContain(ratio);
    }
  });
});

describe('buildMeta', () => {
  it('reports the RESOLVED ratio, so a caller can see what orientation became', () => {
    expect(buildMeta('m', 1, { aspect_ratio: '9:16', orientation: 'portrait' })).toEqual({
      model: 'm',
      seed: 1,
      aspect_ratio: '9:16',
      orientation: 'portrait',
    });
  });

  it('omits orientation when the caller gave a bare ratio', () => {
    expect(buildMeta('m', 1, { aspect_ratio: '21:9' })).toEqual({ model: 'm', seed: 1, aspect_ratio: '21:9' });
  });
});

/**
 * The end of the wire: what a plain "portrait" request actually sends.
 *
 * The resolver tests above prove the mapping; these prove it is reachable from
 * a tool call and survives all the way into the request body. That is the part
 * that was missing — not the ability to make a tall image, but a way to ask for
 * one in the words people use.
 */
describe('orientation reaches the API through the tools', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  function imageFetch() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG } }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
  }

  /** The `imageConfig.aspectRatio` actually sent upstream. */
  const sentRatio = (impl: typeof fetch) =>
    JSON.parse(String((vi.mocked(impl).mock.calls[0]![1] as RequestInit).body))?.generationConfig?.imageConfig?.aspectRatio;

  async function generate(args: Record<string, unknown>) {
    const fetchImpl = imageFetch();
    const client = new GeminiClient({ apiKey: 'k', fetchImpl });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir, ...args });
    await h.close();
    return { res, ratio: sentRatio(fetchImpl) };
  }

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-orient-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('sends 9:16 for a bare `orientation: portrait`', async () => {
    const { res, ratio } = await generate({ orientation: 'portrait' });
    expect(ratio).toBe('9:16');
    // …and reports BOTH, so the caller can see what their word became.
    const meta = parseToolResult<{ aspect_ratio?: string; orientation?: string }>(res);
    expect(meta.aspect_ratio).toBe('9:16');
    expect(meta.orientation).toBe('portrait');
  });

  it('sends 16:9 for landscape and 1:1 for square', async () => {
    expect((await generate({ orientation: 'landscape' })).ratio).toBe('16:9');
    expect((await generate({ orientation: 'square' })).ratio).toBe('1:1');
  });

  it('lets an explicit aspect_ratio beat the orientation', async () => {
    const { ratio } = await generate({ orientation: 'portrait', aspect_ratio: '4:5' });
    expect(ratio).toBe('4:5');
  });

  it('sends nothing when neither is given, leaving the model default alone', async () => {
    expect((await generate({})).ratio).toBeUndefined();
  });

  it('offers orientation on every tool that produces a picture or a video', async () => {
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: imageFetch() });
    const h = await createTestHarness((s) => {
      registerGenerateTools(s, client);
      registerSetTools(s, client);
      registerInteractTools(s, client);
      registerVideoTools(s, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();

    const withOrientation = tools
      .filter((t) => 'orientation' in ((t.inputSchema as { properties?: object }).properties ?? {}))
      .map((t) => t.name)
      .sort();
    expect(withOrientation).toEqual([
      'gemini_image_edit',
      'gemini_image_generate',
      'gemini_image_set',
      'gemini_interact',
      'gemini_video_generate',
    ]);
  });

  it('refuses a square video out loud, naming what omni can do', async () => {
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: imageFetch() });
    const h = await createTestHarness((s) => registerVideoTools(s, client));
    const res = await h.callTool('gemini_video_generate', { prompt: 'a wave', orientation: 'square', output_dir: dir });
    await h.close();

    expect(res.isError).toBe(true);
    const text = String((res.content as Array<{ text: string }>)[0]!.text);
    expect(text).toMatch(/square/);
    expect(text).toMatch(/16:9/);
  });

  it('treats "portrait" and "9:16" as ONE billable job, not two', async () => {
    // The fingerprint keys on the resolved ratio, so a caller who says
    // "portrait" and then retries with the explicit ratio is not billed twice.
    const fetchImpl = imageFetch();
    const client = new GeminiClient({ apiKey: 'k', fetchImpl });
    const h = await createTestHarness((s) => registerGenerateTools(s, client));
    const base = { prompt: 'a red leaf', output_dir: dir, seed: 7, idempotency_key: 'same' };
    await h.callTool('gemini_image_generate', { ...base, orientation: 'portrait' });
    const second = parseToolResult<{ reused?: boolean }>(
      await h.callTool('gemini_image_generate', { ...base, aspect_ratio: '9:16' }),
    );
    await h.close();

    expect(second.reused).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(1);
  });
});

/**
 * Every tool that produces a picture says what shape it produced.
 *
 * `orientation` resolves to a ratio the caller never typed, so a result that
 * omits both leaves that resolution invisible — you asked for "portrait" and
 * nothing in the response confirms it became `9:16`. The three `buildMeta`
 * tools always reported it; `gemini_interact` and `gemini_video_generate` build
 * their meta by hand around chain state and did not (#166). One shared helper
 * now writes those two fields everywhere, so the hand-rolled metas cannot drift
 * from `buildMeta` again.
 */
describe('the produced shape is echoed by every picture-producing tool', () => {
  const PNG_ONE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const MP4 = 'AAAAIGZ0eXBpc29tAAAAAA==';

  let d: string;
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), 'gemini-shape-')); });
  afterEach(() => { rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function interact(args: Record<string, unknown>) {
    const client = new GeminiClient({ apiKey: 'k' });
    vi.spyOn(client, 'interact').mockResolvedValue({ id: 'i1', images: [{ base64: PNG_ONE, mimeType: 'image/png' }] });
    const h = await createTestHarness((s) => registerInteractTools(s, client));
    const res = await h.callTool('gemini_interact', { input: 'a red leaf', output_dir: d, ...args });
    await h.close();
    return parseToolResult<{ aspect_ratio?: string; orientation?: string }>(res);
  }

  async function video(args: Record<string, unknown>) {
    const client = new GeminiClient({ apiKey: 'k' });
    vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((s) => registerVideoTools(s, client));
    const res = await h.callTool('gemini_video_generate', { prompt: 'a wave', output_dir: d, ...args });
    await h.close();
    return parseToolResult<{ aspect_ratio?: string; orientation?: string }>(res);
  }

  it('reports what "portrait" became on gemini_interact', async () => {
    const meta = await interact({ orientation: 'portrait' });
    expect(meta.aspect_ratio).toBe('9:16');
    expect(meta.orientation).toBe('portrait');
  });

  it('reports what "portrait" became on gemini_video_generate', async () => {
    const meta = await video({ orientation: 'portrait' });
    expect(meta.aspect_ratio).toBe('9:16');
    expect(meta.orientation).toBe('portrait');
  });

  it('reports a bare aspect_ratio without inventing an orientation for it', async () => {
    // `21:9` is nobody's idea of "landscape" — echoing one back would be a
    // claim the caller never made.
    const meta = await interact({ aspect_ratio: '21:9' });
    expect(meta.aspect_ratio).toBe('21:9');
    expect(meta.orientation).toBeUndefined();
  });

  it('echoes the ratio that WON when both were given, alongside the word asked for', async () => {
    const meta = await interact({ aspect_ratio: '4:5', orientation: 'portrait' });
    expect(meta.aspect_ratio).toBe('4:5');
    expect(meta.orientation).toBe('portrait');
  });

  it('says nothing about shape when neither was asked for, leaving the model default alone', async () => {
    const i = await interact({});
    expect(i.aspect_ratio).toBeUndefined();
    expect(i.orientation).toBeUndefined();
    const v = await video({});
    expect(v.aspect_ratio).toBeUndefined();
    expect(v.orientation).toBeUndefined();
  });
});
