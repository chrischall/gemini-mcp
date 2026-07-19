import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerMusicTools, __resetMusicMemory } from '../../src/tools/music.js';
import { client } from '../../src/client.js';
import { __resetJobRegistry } from '../../src/jobs.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const MP3 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAAD'; // arbitrary bytes — writeMedia just persists them

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-music-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); __resetMusicMemory(); __resetJobRegistry(); });

describe('gemini_music_generate', () => {
  it('writes an MP3 to disk and returns the interaction id + path', async () => {
    vi.spyOn(client, 'generateMusic').mockResolvedValue({ id: 'mus1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const res = await h.callTool('gemini_music_generate', { prompt: 'lofi hip hop', output_dir: dir });
    const data = parseToolResult<{ audios: string[]; interaction_id: string }>(res);
    expect(data.audios).toHaveLength(1);
    expect(basename(data.audios[0])).toMatch(/\.mp3$/);
    expect(existsSync(data.audios[0])).toBe(true);
    expect(data.interaction_id).toBe('mus1');
    await h.close();
  });

  it('returns audio inline when inline: true', async () => {
    vi.spyOn(client, 'generateMusic').mockResolvedValue({ id: 'm', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const res = await h.callTool('gemini_music_generate', { prompt: 'x', inline: true, output_dir: dir });
    const audioBlock = res.content.find((c: { type: string }) => c.type === 'audio') as { type: string; mimeType: string; data: string } | undefined;
    expect(audioBlock).toBeDefined();
    expect(audioBlock?.mimeType).toBe('audio/mpeg');
    await h.close();
  });

  it('rejects wav on a clip model (WAV is Pro-only)', async () => {
    const spy = vi.spyOn(client, 'generateMusic');
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const res = await h.callTool('gemini_music_generate', { prompt: 'x', audio_format: 'wav', output_dir: dir });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // rejected before any API call
    await h.close();
  });

  it('allows wav on the Pro model and passes the format through', async () => {
    const spy = vi.spyOn(client, 'generateMusic').mockResolvedValue({ id: 'm', audios: [{ base64: MP3, mimeType: 'audio/wav' }] });
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    await h.callTool('gemini_music_generate', { prompt: 'x', model: 'lyria-3-pro-preview', audio_format: 'wav', output_dir: dir });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ audioFormat: 'wav', model: 'lyria-3-pro-preview' }));
    await h.close();
  });

  it('returns a job_id immediately with async: true', async () => {
    vi.spyOn(client, 'generateMusic').mockResolvedValue({ id: 'm', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const res = await h.callTool('gemini_music_generate', { prompt: 'x', output_dir: dir, async: true });
    const data = parseToolResult<{ job_id: string; status: string }>(res);
    expect(typeof data.job_id).toBe('string');
    expect(data.status).toBe('running');
    await h.close();
  });

  it('reuses the recorded result for a repeat idempotency_key (no second generation)', async () => {
    let calls = 0;
    vi.spyOn(client, 'generateMusic').mockImplementation(() => {
      calls++;
      return Promise.resolve({ id: 'm', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] });
    });
    const h = await createTestHarness((srv) => registerMusicTools(srv, client));
    const args = { prompt: 'x', output_dir: dir, idempotency_key: 'mk' };
    const r1 = parseToolResult<{ audios: string[]; reused?: boolean }>(await h.callTool('gemini_music_generate', args));
    const r2 = parseToolResult<{ audios: string[]; reused?: boolean }>(await h.callTool('gemini_music_generate', args));
    expect(calls).toBe(1);
    expect(r2.reused).toBe(true);
    expect(r2.audios).toEqual(r1.audios);
    await h.close();
  });
});
