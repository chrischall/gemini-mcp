import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerInteractTools, __resetInteractSessionForTest } from '../../src/tools/interact.js';
import { client, ChainNotFoundError } from '../../src/client.js';

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-chain-'));
  __resetInteractSessionForTest();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** Seed a prior turn's output image + `<image>.json` sidecar in the output dir. */
function seedPriorTurn(base: string, interactionId: string): string {
  const image = join(dir, `${base}.jpg`);
  writeFileSync(image, Buffer.from(JPEG_BASE64, 'base64'));
  writeFileSync(`${image}.json`, JSON.stringify({ interaction_id: interactionId, images: [image] }));
  return image;
}

const ok = (id: string) => ({ id, images: [{ base64: JPEG_BASE64, mimeType: 'image/jpeg' }] });

describe('continue_last across a server restart', () => {
  it('resumes from the newest sidecar when the in-memory id is gone', async () => {
    // A restarted server has no lastInteractionId, but the chain is alive
    // upstream and named by the sidecar the previous process wrote.
    seedPriorTurn('v11', 'id-v11');
    const spy = vi.spyOn(client, 'interact').mockResolvedValue(ok('id-v12'));
    const h = await createTestHarness(registerInteractTools);

    const res = await h.callTool('gemini_interact', { input: 'make it blue', continue_last: true, output_dir: dir });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ previousInteractionId: 'id-v11' }));
    expect(parseToolResult(res)).toMatchObject({ continued_from_sidecar: true, previous_interaction_id: 'id-v11' });
    await h.close();
  });

  it('prefers the in-memory id over the sidecar', async () => {
    seedPriorTurn('stale', 'id-stale');
    const spy = vi.spyOn(client, 'interact').mockResolvedValue(ok('id-live'));
    const h = await createTestHarness(registerInteractTools);
    await h.callTool('gemini_interact', { input: 'a red circle', output_dir: dir });

    await h.callTool('gemini_interact', { input: 'make it blue', continue_last: true, output_dir: dir });

    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ previousInteractionId: 'id-live' }));
    await h.close();
  });
});

describe('automatic re-anchor when an interaction id is gone upstream', () => {
  it('retries un-chained with the dead turn\'s image re-attached', async () => {
    const image = seedPriorTurn('v11', 'id-v11');
    const spy = vi.spyOn(client, 'interact')
      .mockRejectedValueOnce(new ChainNotFoundError('id-v11', { hint: 'x' }))
      .mockResolvedValueOnce(ok('id-v12'));
    const h = await createTestHarness(registerInteractTools);

    const res = await h.callTool('gemini_interact', {
      input: 'make it blue', previous_interaction_id: 'id-v11', output_dir: dir,
    });

    expect(res.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(2);
    // The retry drops the dead chain and carries the image forward instead.
    const retry = spy.mock.calls[1][0];
    expect(retry.previousInteractionId).toBeUndefined();
    expect(retry.images).toEqual([expect.objectContaining({ mimeType: 'image/jpeg' })]);
    expect(retry.input).toBe('make it blue');
    expect(parseToolResult(res)).toMatchObject({
      interaction_id: 'id-v12',
      chain_recovered: { expired_interaction_id: 'id-v11', reanchored_on: [image] },
    });
    await h.close();
  });

  it('keeps genuinely new reference images alongside the re-anchored one', async () => {
    seedPriorTurn('v11', 'id-v11');
    const reference = join(dir, 'style.jpg');
    writeFileSync(reference, Buffer.from(JPEG_BASE64, 'base64'));
    const spy = vi.spyOn(client, 'interact')
      .mockRejectedValueOnce(new ChainNotFoundError('id-v11', { hint: 'x' }))
      .mockResolvedValueOnce(ok('id-v12'));
    const h = await createTestHarness(registerInteractTools);

    await h.callTool('gemini_interact', {
      // confirm: true — a local-file input is confirm-gated; without it the
      // call returns a dry-run preview and never reaches the API.
      input: 'apply this style', previous_interaction_id: 'id-v11', images: [reference], confirm: true, output_dir: dir,
    });

    expect(spy.mock.calls[1][0].images).toHaveLength(2);
    await h.close();
  });

  it('surfaces the original error when the dead id has no sidecar to re-anchor on', async () => {
    // Nothing on disk for this id — re-anchoring on the wrong image would
    // silently corrupt the edit, so fail with the actionable error instead.
    seedPriorTurn('unrelated', 'id-other');
    const spy = vi.spyOn(client, 'interact')
      .mockRejectedValue(new ChainNotFoundError('id-gone', { hint: 'start a new chain' }));
    const h = await createTestHarness(registerInteractTools);

    const res = await h.callTool('gemini_interact', {
      input: 'make it blue', previous_interaction_id: 'id-gone', output_dir: dir,
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/was not found/i);
    expect(spy).toHaveBeenCalledTimes(1); // no re-anchor attempted
    await h.close();
  });

  it('does not re-anchor a non-chain failure', async () => {
    seedPriorTurn('v11', 'id-v11');
    const spy = vi.spyOn(client, 'interact').mockRejectedValue(new Error('safety filter blocked'));
    const h = await createTestHarness(registerInteractTools);

    const res = await h.callTool('gemini_interact', {
      input: 'make it blue', previous_interaction_id: 'id-v11', output_dir: dir,
    });

    expect(res.isError).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    await h.close();
  });
});
