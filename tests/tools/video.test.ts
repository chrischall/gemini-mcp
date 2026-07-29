import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerVideoTools } from '../../src/tools/video.js';
import { client } from '../../src/client.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MP4 = 'AAAAIGZ0eXBpc29tAAAAAA=='; // arbitrary bytes — writeMedia just persists them

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-video-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); client.session.reset(); });

describe('gemini_video_generate', () => {
  it('writes an MP4 to disk and returns the interaction id + path', async () => {
    vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'vid1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    const res = await h.callTool('gemini_video_generate', { prompt: 'a cat surfing', output_dir: dir });
    const data = parseToolResult<{ videos: string[]; interaction_id: string }>(res);
    expect(data.videos).toHaveLength(1);
    expect(basename(data.videos[0])).toMatch(/\.mp4$/);
    expect(existsSync(data.videos[0])).toBe(true);
    expect(data.interaction_id).toBe('vid1');
    await h.close();
  });

  it('passes aspect_ratio and task through to the client', async () => {
    const spy = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    await h.callTool('gemini_video_generate', { prompt: 'x', aspect_ratio: '9:16', task: 'text_to_video', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: '9:16', task: 'text_to_video' }));
    await h.close();
  });

  it('image_to_video passes reference image inputs to the client', async () => {
    const spy = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    await h.callTool('gemini_video_generate', { prompt: 'animate this', task: 'image_to_video', images_base64: [PNG], output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png' })]),
    }));
    await h.close();
  });

  it('continue_last errors when there is no prior video interaction', async () => {
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    const res = await h.callTool('gemini_video_generate', { prompt: 'x', continue_last: true, output_dir: dir });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('continue_last chains from the most recent video interaction', async () => {
    const spy = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'vid-A', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    await h.callTool('gemini_video_generate', { prompt: 'first', output_dir: dir });
    spy.mockResolvedValue({ id: 'vid-B', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    await h.callTool('gemini_video_generate', { prompt: 'edit it', task: 'edit', continue_last: true, output_dir: dir });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ previousInteractionId: 'vid-A' }));
    await h.close();
  });

  it('returns a job_id immediately with async: true', async () => {
    vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    const res = await h.callTool('gemini_video_generate', { prompt: 'x', output_dir: dir, async: true });
    const data = parseToolResult<{ job_id: string; status: string }>(res);
    expect(typeof data.job_id).toBe('string');
    expect(data.status).toBe('running');
    await h.close();
  });

  it('reuses the recorded result for a repeat idempotency_key (no second generation)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generateVideo').mockImplementation(() => {
      calls++;
      return Promise.resolve({ id: 'v', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    });
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    const args = { prompt: 'x', output_dir: dir, idempotency_key: 'vk' };
    const r1 = parseToolResult<{ videos: string[]; reused?: boolean }>(await h.callTool('gemini_video_generate', args));
    const r2 = parseToolResult<{ videos: string[]; reused?: boolean }>(await h.callTool('gemini_video_generate', args));
    expect(calls).toBe(1);
    expect(r2.reused).toBe(true);
    expect(r2.videos).toEqual(r1.videos);
    await h.close();
  });
});

/**
 * Video and music used to load their reference stills through a SECOND input
 * funnel (`gatherImageInputs`), which is why they never gained `images_url` /
 * `images_file_uris` — and why CLAUDE.md's "a new input form is a change in
 * inputs.ts and nowhere else" was not actually true. One funnel now.
 */
describe('gemini_video_generate reference inputs', () => {
  it('accepts images_url, fetched by the server', async () => {
    const generateVideo = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    vi.spyOn(client, 'fetchRemoteImage').mockResolvedValue({
      bytes: Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
      mimeType: 'image/png', size: 68,
      finalUrl: 'https://cdn.example.com/still.png', requestedUrl: 'https://cdn.example.com/still.png',
    });
    const h = await createTestHarness((s) => registerVideoTools(s, client));
    const res = await h.callTool('gemini_video_generate', {
      prompt: 'pan across it',
      task: 'image_to_video',
      images_url: ['https://cdn.example.com/still.png'],
      output_dir: dir,
    });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(generateVideo.mock.calls[0][0].images).toEqual([{ base64: PNG, mimeType: 'image/png' }]);
  });

  it('accepts images_file_uris by reference, moving no bytes', async () => {
    const generateVideo = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const getFile = vi.spyOn(client, 'getFile').mockResolvedValue({
      name: 'files/s1', uri: 'https://g/v1beta/files/s1', mimeType: 'image/png',
    });
    const h = await createTestHarness((s) => registerVideoTools(s, client));
    const res = await h.callTool('gemini_video_generate', {
      prompt: 'pan across it',
      images_file_uris: ['files/s1'],
      output_dir: dir,
    });
    await h.close();

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(generateVideo.mock.calls[0][0].images).toEqual([{ uri: 'https://g/v1beta/files/s1', mimeType: 'image/png' }]);
    expect(parseToolResult<{ image_inputs?: { file_uris?: string[] } }>(res).image_inputs?.file_uris).toEqual(['files/s1']);
  });
});
