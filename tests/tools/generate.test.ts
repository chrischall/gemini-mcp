import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { client } from '../../src/client.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-gen-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_generate_image', () => {
  it('writes a file and returns its path', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'a red leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(data.images).toHaveLength(1);
    expect(existsSync(data.images[0])).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a red leaf' }));
    await h.close();
  });

  it('count makes N independent calls', async () => {
    const spy = vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'leaf', count: 3, output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
    await h.close();
  });

  it('inline returns image content blocks, writes nothing', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'leaf', inline: true });
    expect(res.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await h.close();
  });
});

describe('gemini_generate_image filename param', () => {
  it('uses caller-supplied filename as the base name', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', {
      prompt: 'a red leaf',
      filename: 'my-custom.png',
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('my-custom.png');
    await h.close();
  });

  it('falls back to slugified prompt when no filename given', async () => {
    vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_generate_image', { prompt: 'red leaf', output_dir: dir });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('red-leaf.png');
    await h.close();
  });
});

describe('gemini_edit_image', () => {
  it('reads input images, passes them to generate, returns a path', async () => {
    const inPath = join(dir, 'src.png');
    writeFileSync(inPath, Buffer.from(PNG, 'base64'));
    const spy = vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_edit_image', { prompt: 'make it blue', images: [inPath], output_dir: dir });
    expect(parseToolResult<{ images: string[] }>(res).images).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
    );
    await h.close();
  });

  it('uses caller-supplied filename as the base name', async () => {
    const inPath = join(dir, 'src.png');
    writeFileSync(inPath, Buffer.from(PNG, 'base64'));
    vi.spyOn(client, 'generate').mockResolvedValue([{ base64: PNG, mimeType: 'image/png' }]);
    const h = await createTestHarness(registerGenerateTools);
    const res = await h.callTool('gemini_edit_image', {
      prompt: 'make it blue',
      images: [inPath],
      filename: 'edited-output',
      output_dir: dir,
    });
    const data = parseToolResult<{ images: string[] }>(res);
    expect(basename(data.images[0])).toBe('edited-output.png');
    await h.close();
  });
});
