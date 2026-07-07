import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness } from '@chrischall/mcp-utils/test';

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

// These tests exercise the module-level "last interaction id" memory, so each
// test re-imports interact.js (and the client it closes over) from a FRESH
// module registry — no test can observe another's lastInteractionId, whatever
// order they run in.
let registerInteractTools: typeof import('../../src/tools/interact.js')['registerInteractTools'];
let client: typeof import('../../src/client.js')['client'];

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-continue-'));
  vi.resetModules();
  ({ registerInteractTools } = await import('../../src/tools/interact.js'));
  ({ client } = await import('../../src/client.js'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('gemini_interact continue_last', () => {
  it('errors actionably when continue_last:true and no interaction has run yet', async () => {
    const spy = vi.spyOn(client, 'interact');
    const h = await createTestHarness(registerInteractTools);
    const res = await h.callTool('gemini_interact', { input: 'add a hat', continue_last: true, output_dir: dir });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/no previous interaction/i);
    expect(spy).not.toHaveBeenCalled();
    await h.close();
  });

  it('reuses the most recent interaction id when continue_last:true', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'first-run-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'a red circle', output_dir: dir });

    spy.mockResolvedValue({ id: 'second-run-id', images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });
    await h.callTool('gemini_interact', { input: 'make it blue', continue_last: true, output_dir: dir });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ previousInteractionId: 'first-run-id' }));
    await h.close();
  });

  it('lets an explicit previous_interaction_id win over continue_last', async () => {
    const spy = vi.spyOn(client, 'interact').mockResolvedValue({
      id: 'third-run-id',
      images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }],
    });
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', {
      input: 'add stars',
      continue_last: true,
      previous_interaction_id: 'explicit-id',
      output_dir: dir,
    });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ previousInteractionId: 'explicit-id' }));
    await h.close();
  });
});
