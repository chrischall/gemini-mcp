import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerInteractTools } from '../../src/tools/interact.js';
import { client } from '../../src/client.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-guard-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function mockInteract(id: string) {
  return vi.spyOn(client, 'interact').mockResolvedValue({
    id,
    images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
  });
}

// These tests exercise the module-level memory of output paths this server
// wrote, so (like interact-continue.test.ts) they rely on vitest's per-file
// module registry; each test generates its own outputs in a fresh temp dir.
describe('gemini_interact chained re-attach guard', () => {
  it('drops a chained input image that this server generated and notes it in meta', async () => {
    const spy = mockInteract('guard-turn-1');
    const h = await createTestHarness(registerInteractTools);
    const res1 = await h.callTool('gemini_interact', { input: 'a poster', output_dir: dir });
    const out1 = parseToolResult<{ images: string[] }>(res1).images[0];

    spy.mockResolvedValue({ id: 'guard-turn-2', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    const res2 = await h.callTool('gemini_interact', {
      input: 'neutralize the pink tint',
      previous_interaction_id: 'guard-turn-1',
      images: [out1],
      output_dir: dir,
    });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ images: undefined }));
    const data2 = parseToolResult<{ dropped_previous_output?: string[] }>(res2);
    expect(data2.dropped_previous_output).toEqual([out1]);
    await h.close();
  });

  it('keeps genuinely new reference images while dropping the re-attached output', async () => {
    const spy = mockInteract('guard-mixed-1');
    const h = await createTestHarness(registerInteractTools);
    const res1 = await h.callTool('gemini_interact', { input: 'a poster', output_dir: dir });
    const out1 = parseToolResult<{ images: string[] }>(res1).images[0];

    const fresh = join(dir, 'style-ref.png');
    writeFileSync(fresh, Buffer.from(PNG, 'base64'));

    spy.mockResolvedValue({ id: 'guard-mixed-2', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    const res2 = await h.callTool('gemini_interact', {
      input: 'match this style',
      previous_interaction_id: 'guard-mixed-1',
      images: [out1, fresh],
      confirm: true,
      output_dir: dir,
    });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      images: [expect.objectContaining({ mimeType: 'image/png' })],
    }));
    const data2 = parseToolResult<{ dropped_previous_output?: string[] }>(res2);
    expect(data2.dropped_previous_output).toEqual([out1]);
    await h.close();
  });

  it('passes a server-generated output through when NOT chaining (new interaction from an old result is legit)', async () => {
    const spy = mockInteract('guard-fresh-1');
    const h = await createTestHarness(registerInteractTools);
    const res1 = await h.callTool('gemini_interact', { input: 'a poster', output_dir: dir });
    const out1 = parseToolResult<{ images: string[] }>(res1).images[0];

    spy.mockResolvedValue({ id: 'guard-fresh-2', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    const res2 = await h.callTool('gemini_interact', { input: 'reimagine this poster', images: [out1], confirm: true, output_dir: dir });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      images: [expect.objectContaining({ mimeType: 'image/jpeg' })],
    }));
    const data2 = parseToolResult<{ dropped_previous_output?: string[] }>(res2);
    expect(data2.dropped_previous_output).toBeUndefined();
    await h.close();
  });

  it('does not drop unrelated images on a chained call', async () => {
    const spy = mockInteract('guard-unrelated-1');
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'a poster', output_dir: dir });

    const fresh = join(dir, 'reference.png');
    writeFileSync(fresh, Buffer.from(PNG, 'base64'));

    spy.mockResolvedValue({ id: 'guard-unrelated-2', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    const res2 = await h.callTool('gemini_interact', {
      input: 'add this logo',
      previous_interaction_id: 'guard-unrelated-1',
      images: [fresh],
      confirm: true,
      output_dir: dir,
    });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      images: [expect.objectContaining({ mimeType: 'image/png' })],
    }));
    const data2 = parseToolResult<{ dropped_previous_output?: string[] }>(res2);
    expect(data2.dropped_previous_output).toBeUndefined();
    await h.close();
  });

  it('still errors on a chained call whose image path does not exist', async () => {
    const spy = mockInteract('guard-missing-1');
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'a poster', output_dir: dir });

    spy.mockClear();
    const res = await h.callTool('gemini_interact', {
      input: 'edit',
      previous_interaction_id: 'guard-missing-1',
      images: [join(dir, 'does-not-exist.png')],
      output_dir: dir,
    });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    await h.close();
  });
});
