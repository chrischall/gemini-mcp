import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerInteractTools } from '../../src/tools/interact.js';
import { client } from '../../src/client.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG, 'base64').length;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-confirm-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function writePng(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(PNG, 'base64'));
  return p;
}

type Preview = { dryRun: boolean; willSend: { inputs: Array<{ path: string; mimeType: string; size: number }> }; note: string };

describe('confirm-gate: local file inputs require confirm:true', () => {
  it('gemini_edit_image without confirm returns a dry-run and makes NO API call', async () => {
    const spy = vi.spyOn(client, 'generate');
    const inPath = writePng('secret.png');
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_edit_image', { prompt: 'make it blue', images: [inPath], output_dir: dir });
    expect(spy).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.dryRun).toBe(true);
    expect(p.willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);
    expect(p.note).toMatch(/confirm: true/);
    await h.close();
  });

  it('gemini_generate_image without confirm (image input) returns a dry-run and makes NO API call', async () => {
    const spy = vi.spyOn(client, 'generate');
    const inPath = writePng('ref.png');
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'style', images: [inPath], output_dir: dir });
    expect(spy).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.dryRun).toBe(true);
    expect(p.willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);
    await h.close();
  });

  it('gemini_generate_image without confirm (video input) previews without uploading', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const gen = vi.spyOn(client, 'generate');
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('videobytes'));
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'flag', video_path: videoPath, output_dir: dir });
    expect(up).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.willSend.inputs).toEqual([{ path: videoPath, mimeType: 'video/mp4', size: 'videobytes'.length }]);
    await h.close();
  });

  it('gemini_generate_set without confirm (master_images) returns a dry-run and makes NO API call', async () => {
    const spy = vi.spyOn(client, 'generate');
    const inPath = writePng('master.png');
    const h = await createTestHarness(registerSetTools);
    const res = await h.callTool('gemini_generate_set', { master_prompt: 'fox', count: 2, master_images: [inPath], output_dir: dir });
    expect(spy).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.dryRun).toBe(true);
    expect(p.willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);
    await h.close();
  });

  it('gemini_interact without confirm returns a dry-run and makes NO API call', async () => {
    const spy = vi.spyOn(client, 'interact');
    const inPath = writePng('input.png');
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'edit this', images: [inPath], output_dir: dir });
    expect(spy).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.dryRun).toBe(true);
    expect(p.willSend.inputs).toEqual([{ path: inPath, mimeType: 'image/png', size: PNG_BYTES }]);
    await h.close();
  });

  it('gemini_interact without confirm (video input) previews without uploading', async () => {
    const up = vi.spyOn(client, 'uploadVideo');
    const inter = vi.spyOn(client, 'interact');
    const videoPath = join(dir, 'clip.mp4');
    writeFileSync(videoPath, Buffer.from('videobytes'));
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'describe this', video_path: videoPath, output_dir: dir });
    expect(up).not.toHaveBeenCalled();
    expect(inter).not.toHaveBeenCalled();
    const p = parseToolResult<Preview>(res);
    expect(p.dryRun).toBe(true);
    expect(p.willSend.inputs).toEqual([{ path: videoPath, mimeType: 'video/mp4', size: 'videobytes'.length }]);
    await h.close();
  });

  // Pure text-to-image (no local input file) must NOT be gated.
  it('gemini_generate_image with no local input is unaffected (proceeds without confirm)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'a red circle', output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });

  it('gemini_edit_image with base64 input is unaffected (proceeds without confirm)', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_edit_image', { prompt: 'brighter', images_base64: [PNG], output_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    await h.close();
  });
});
