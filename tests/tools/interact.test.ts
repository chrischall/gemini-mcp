import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerInteractTools } from '../../src/tools/interact.js';
import { client } from '../../src/client.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

// A minimal 1×1 PNG base64 for test images
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-interact-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_interact description', () => {
  it('states it is the preferred tool for iterative refinement and how to chain', async () => {
    const h = await createTestHarness(registerInteractTools);
    const { tools } = await h.client.listTools();
    const desc = tools.find((t) => t.name === 'gemini_interact')?.description ?? '';
    expect(desc).toMatch(/^Preferred tool for iterative/i);
    expect(desc).toContain('previous_interaction_id');
    expect(desc).toMatch(/do NOT start a new interaction/i);
    expect(desc).not.toMatch(/beta/i); // Interactions API went GA (verified 2026-07-06)
    await h.close();
  });

  it('model param describes when to pick each model', async () => {
    const h = await createTestHarness(registerInteractTools);
    const { tools } = await h.client.listTools();
    const schema = tools.find((t) => t.name === 'gemini_interact')?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const desc = schema.properties?.model?.description ?? '';
    expect(desc).toContain('gemini-3.1-flash-image');
    expect(desc).toContain('gemini-3-pro-image');
    await h.close();
  });
});

describe('gemini_interact', () => {
  it('writes a JPEG file and returns interaction_id in meta', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'test-interaction-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'a red circle', output_dir: dir });
    const data = parseToolResult<{ images: string[]; interaction_id: string; model: string }>(res);
    expect(data.images).toHaveLength(1);
    expect(existsSync(data.images[0])).toBe(true);
    expect(basename(data.images[0])).toMatch(/\.jpg$/);
    expect(data.interaction_id).toBe('test-interaction-id');
    expect(typeof data.model).toBe('string');
    await h.close();
  });

  it('surfaces grounding in meta when the client returns it', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'gs',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
      grounding: { queries: ['sf weather'] },
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'weather', google_search: true, output_dir: dir });
    const data = parseToolResult<{ grounding?: { queries?: string[] } }>(res);
    expect(data.grounding).toEqual({ queries: ['sf weather'] });
    await h.close();
  });

  it('passes previous_interaction_id through to client.interact', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'new-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', {
      input: 'now add a triangle',
      previous_interaction_id: 'prior-id-42',
      output_dir: dir,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ previousInteractionId: 'prior-id-42' }));
    await h.close();
  });

  it('passes images_base64 as image inputs to client.interact', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'img-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'edit this', images_base64: [PNG], output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]),
    }));
    await h.close();
  });

  it('passes image file paths as inputs to client.interact', async () => {
    const inPath = join(dir, 'src.png');
    writeFileSync(inPath, Buffer.from(PNG, 'base64'));
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'path-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'edit this', images: [inPath], output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]),
    }));
    await h.close();
  });

  it('passes thinking_level to client.interact as thinkingLevel', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'think-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'circle', thinking_level: 'high', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'high' }));
    await h.close();
  });

  it('passes aspect_ratio and image_size to client.interact', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'size-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'circle', aspect_ratio: '16:9', image_size: '2K', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: '16:9', imageSize: '2K' }));
    await h.close();
  });

  it('includes text in meta when client returns text', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'txt-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
      text: 'Here is the image.',
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    const data = parseToolResult<{ images: string[]; text?: string }>(res);
    expect(data.text).toBe('Here is the image.');
    await h.close();
  });

  it('omits text from meta when client returns no text', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'notxt-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    const data = parseToolResult<{ images: string[]; text?: string }>(res);
    expect(data.text).toBeUndefined();
    await h.close();
  });

  it('uses caller-supplied filename as the base name', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'fn-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', filename: 'my-output', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('my-output.jpg');
    await h.close();
  });

  it('falls back to slugified input when no filename given', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'slug-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'red circle', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('red-circle.jpg');
    await h.close();
  });

  it('inline returns meta text block then image content block', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'inline-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', inline: true });
    expect(res.content[0].type).toBe('text');
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    await h.close();
  });

  it('does NOT include seed in the interact call (Interactions API has no seed)', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'noseed-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({ seed: expect.anything() }));
    await h.close();
  });

  it('returns interaction_id (not seed) in meta — multi-turn key feature', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'chain-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    const data = parseToolResult<{ interaction_id?: string; seed?: number }>(res);
    expect(data.interaction_id).toBe('chain-id');
    expect(data.seed).toBeUndefined();
    await h.close();
  });

  it('includes a copy-paste-ready refinement hint carrying the new interaction id', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'hint-id-99',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    const data = parseToolResult<{ hint?: string }>(res);
    expect(data.hint).toContain('previous_interaction_id');
    expect(data.hint).toContain('hint-id-99');
    await h.close();
  });

  it('echoes previous_interaction_id in meta when chaining', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'next-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', {
      input: 'add a hat',
      previous_interaction_id: 'prior-id-7',
      output_dir: dir,
    });
    const data = parseToolResult<{ interaction_id: string; previous_interaction_id?: string }>(res);
    expect(data.previous_interaction_id).toBe('prior-id-7');
    expect(data.interaction_id).toBe('next-id');
    await h.close();
  });

  it('omits previous_interaction_id from meta on a first turn', async () => {
    vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'first-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'circle', output_dir: dir });
    const data = parseToolResult<{ previous_interaction_id?: string }>(res);
    expect(data.previous_interaction_id).toBeUndefined();
    await h.close();
  });

  it('passes google_search:true to client.interact as googleSearch', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'gs-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'circle', google_search: true, output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ googleSearch: true }));
    await h.close();
  });

  it('passes video_url to client.interact as videoUrl', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'vid-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'describe', video_url: 'https://www.youtube.com/watch?v=xyz', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'https://www.youtube.com/watch?v=xyz' }));
    await h.close();
  });
});

describe('gemini_interact from_clipboard', () => {
  it('passes clipboard image to client.interact when from_clipboard:true', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'clip-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'edit this', from_clipboard: true, output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/jpeg' })]),
    }));
    await h.close();
  });
});

describe('gemini_interact video_path (Files API upload)', () => {
  const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
  const uploaded = { name: 'files/abc123', uri: FILE_URI, mimeType: 'video/webm', expirationTime: '2026-06-14T15:26:39Z' };

  it('uploads the local video then interacts with the returned files/ uri', async () => {
    const videoPath = join(dir, 'clip.webm');
    writeFileSync(videoPath, Buffer.from('vid'));
    const up = vi.spyOn(client, 'uploadVideo').mockResolvedValue(uploaded);
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({ id: 'i1', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'flag', video_path: videoPath, output_dir: dir });
    expect(up).toHaveBeenCalledWith(videoPath, 'video/webm');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: FILE_URI, videoMimeType: 'video/webm' }));
    const data = parseToolResult<{ video_file: { uri: string } }>(res);
    expect(data.video_file).toMatchObject({ uri: FILE_URI });
    await h.close();
  });

  it('rejects video_path together with video_url', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', {
      input: 'flag',
      video_path: '/tmp/clip.mp4',
      video_url: 'https://www.youtube.com/watch?v=abc',
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not both/i);
    expect(up).not.toHaveBeenCalled();
    await h.close();
  });
});
