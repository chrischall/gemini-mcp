import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerInteractTools } from '../../src/tools/interact.js';
import { registerVideoTools } from '../../src/tools/video.js';
import { registerMusicTools } from '../../src/tools/music.js';
import { registerFileTools } from '../../src/tools/files.js';
import { client, type GeminiClient } from '../../src/client.js';
import { SessionState } from '../../src/session.js';
import { createDiskSink } from '../../src/storage/media.js';
import { phaseOne } from '../confirm-helpers.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

/**
 * Local file inputs and remote deletes are confirmed before anything leaves the
 * box. A harness with no elicitation handler is a client that cannot show a
 * prompt, so (with the default MCP_CONFIRM_MODE=ask-user) it gets the two-phase
 * token flow: phase 1 previews and writes nothing, phase 2 with the token writes
 * exactly once.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG, 'base64').length;
const MP4 = 'AAAAIGZ0eXBpc29tAAAAAA==';
const MP3 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAAD';

let dir: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-confirm-'));
  savedEnv = { ...process.env };
  delete process.env.MCP_CONFIRM_MODE;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  client.session.reset();
  process.env = savedEnv;
});

function writePng(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(PNG, 'base64'));
  return p;
}

type Preview = { action: string; method: string; path: string; willSend: { inputs: Array<{ path: string; mimeType: string; size: number }> } };

describe('confirm-gate: local file inputs need a confirmed token', () => {
  it('gemini_image_edit: phase 1 previews with NO API call, phase 2 generates once', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const inPath = writePng('secret.png');
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'make it blue', images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_image_edit', args);
    expect(spy).not.toHaveBeenCalled();
    const p = first.preview as Preview;
    expect(p.method).toBe('POST');
    expect(p.path).toBe('/v1beta/models/{model}:generateContent');
    expect(p.willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    const res = await h.callTool('gemini_image_edit', { ...args, confirmToken: first.confirmToken });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_image_generate (image input): phase 1 previews, phase 2 generates once', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const inPath = writePng('ref.png');
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const args = { prompt: 'style', images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_image_generate', args);
    expect(spy).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    await h.callTool('gemini_image_generate', { ...args, confirmToken: first.confirmToken });
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_image_generate (video input) previews without uploading', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const gen = vi.spyOn(client, 'generate');
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('videobytes'));
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const first = await phaseOne(h, 'gemini_image_generate', { prompt: 'flag', video_path: videoPath, output_dir: dir });
    expect(up).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: videoPath, mimeType: 'video/mp4', size: 'videobytes'.length }]);
    await h.close();
  });

  it('gemini_image_set (master_images): phase 1 previews, phase 2 generates', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const inPath = writePng('master.png');
    const h = await createTestHarness((srv) => registerSetTools(srv, client));
    const args = { master_prompt: 'fox', count: 1, master_images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_image_set', args);
    expect(spy).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    const res = await h.callTool('gemini_image_set', { ...args, confirmToken: first.confirmToken });
    expect(res.isError).toBeFalsy();
    // One run: the master plus its one variation.
    expect(spy).toHaveBeenCalledTimes(2);
    await h.close();
  });

  it('gemini_interact: phase 1 previews, phase 2 interacts once', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({ id: 'i1', images: [{ base64: PNG, mimeType: 'image/png' }] });
    const inPath = writePng('input.png');
    const h = await createTestHarness((srv) => registerInteractTools(srv, client));
    const args = { input: 'edit this', images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_interact', args);
    expect(spy).not.toHaveBeenCalled();
    expect((first.preview as Preview).path).toBe('/v1beta/interactions');
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    await h.callTool('gemini_interact', { ...args, confirmToken: first.confirmToken });
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_interact (video input) previews without uploading', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const inter = vi.spyOn(client, 'interact');
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('videobytes'));
    const h = await createTestHarness((srv) => registerInteractTools(srv, client));
    const first = await phaseOne(h, 'gemini_interact', { input: 'describe this', video_path: videoPath, output_dir: dir });
    expect(up).not.toHaveBeenCalled();
    expect(inter).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: videoPath, mimeType: 'video/mp4', size: 'videobytes'.length }]);
    await h.close();
  });

  it('gemini_video_generate (image input): phase 1 previews, phase 2 generates once', async () => {
    const spy = vi.spyOn(client, 'generateVideo').mockResolvedValue({ id: 'v', videos: [{ base64: MP4, mimeType: 'video/mp4' }] });
    const inPath = writePng('first-frame.png');
    const h = await createTestHarness((srv) => registerVideoTools(srv, client));
    const args = { prompt: 'animate', images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_video_generate', args);
    expect(spy).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    await h.callTool('gemini_video_generate', { ...args, confirmToken: first.confirmToken });
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_music_generate (image input): phase 1 previews, phase 2 generates once', async () => {
    const spy = vi.spyOn(client, 'generateMusic').mockResolvedValue({ id: 'm', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    const inPath = writePng('cover.png');
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const args = { prompt: 'lofi', images: [inPath], output_dir: dir };
    const first = await phaseOne(h, 'gemini_music_generate', args);
    expect(spy).not.toHaveBeenCalled();
    expect((first.preview as Preview).willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);

    await h.callTool('gemini_music_generate', { ...args, confirmToken: first.confirmToken });
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  // Pure text-to-image (no local input file) must NOT be gated.
  it('gemini_image_generate with no local input is unaffected (proceeds on the first call)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_generate', { prompt: 'a red circle', output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_image_edit with base64 input is unaffected (proceeds on the first call)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const res = await h.callTool('gemini_image_edit', { prompt: 'brighter', images_base64: [PNG], output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('binds the whole request: a changed prompt between the phases is DRAFT_CHANGED and generates nothing', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const inPath = writePng('ref.png');
    const h = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const first = await phaseOne(h, 'gemini_image_edit', { prompt: 'make it blue', images: [inPath], output_dir: dir });
    const res = await h.callTool('gemini_image_edit', { prompt: 'make it red', images: [inPath], output_dir: dir, confirmToken: first.confirmToken });
    expect(res.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(res).error).toBe('DRAFT_CHANGED');
    expect(spy).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('confirm-token behaviour (on gemini_delete_file)', () => {
  function fileClient(deleteFile: ReturnType<typeof vi.fn>): GeminiClient {
    return { mediaSink: createDiskSink(), session: new SessionState(), deleteFile } as unknown as GeminiClient;
  }

  it('refuses a replayed token with TOKEN_REUSED and deletes only once', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, fileClient(deleteFile)));
    const first = await phaseOne(h, 'gemini_delete_file', { file_uri: 'files/a1' });
    await h.callTool('gemini_delete_file', { file_uri: 'files/a1', confirmToken: first.confirmToken });
    const replay = await h.callTool('gemini_delete_file', { file_uri: 'files/a1', confirmToken: first.confirmToken });
    await h.close();

    expect(replay.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(replay).error).toBe('TOKEN_REUSED');
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it('refuses a token issued for a different file_uri (the bound target) and deletes nothing', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, fileClient(deleteFile)));
    const first = await phaseOne(h, 'gemini_delete_file', { file_uri: 'files/a1' });
    const res = await h.callTool('gemini_delete_file', { file_uri: 'files/b2', confirmToken: first.confirmToken });
    await h.close();

    expect(res.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(res).error).toBe('TOKEN_INVALID');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('deletes on an accepted elicitation prompt, with no token round-trip', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, fileClient(deleteFile)), {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    const res = await h.callTool('gemini_delete_file', { file_uri: 'files/a1' });
    await h.close();

    expect(res.isError).toBeFalsy();
    expect(parseToolResult<{ deleted: string }>(res).deleted).toBe('files/a1');
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it('deletes nothing when the elicitation prompt is declined', async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, fileClient(deleteFile)), {
      elicitation: async () => ({ action: 'decline' }),
    });
    await h.callTool('gemini_delete_file', { file_uri: 'files/a1' });
    await h.close();

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('refuses outright under MCP_CONFIRM_MODE=refuse on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const h = await createTestHarness((s) => registerFileTools(s, fileClient(deleteFile)));
    const res = await h.callTool('gemini_delete_file', { file_uri: 'files/a1' });
    await h.close();

    expect(parseToolResult<{ reason: string }>(res).reason).toBe('confirmation-unsupported');
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe('confirm-gate: schema', () => {
  it('every gated stdio tool takes confirmToken and no longer takes confirm', async () => {
    const gated = ['gemini_image_generate', 'gemini_image_edit', 'gemini_image_set', 'gemini_interact', 'gemini_video_generate', 'gemini_music_generate', 'gemini_upload_file', 'gemini_delete_file'];
    const h = await createTestHarness((srv) => {
      registerGenerateTools(srv, client);
      registerSetTools(srv, client);
      registerInteractTools(srv, client);
      registerVideoTools(srv, client);
      registerMusicTools(srv, client);
      registerFileTools(srv, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();
    for (const name of gated) {
      const tool = tools.find((t) => t.name === name);
      const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props, name).toHaveProperty('confirmToken');
      expect(props, name).not.toHaveProperty('confirm');
      expect(tool?.description, name).toMatch(/confirmToken/);
    }
  });
});
