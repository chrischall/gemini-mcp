import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
