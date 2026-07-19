import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerModelTools } from '../../src/tools/models.js';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerSetTools } from '../../src/tools/set.js';
import { registerInteractTools } from '../../src/tools/interact.js';
import { registerVideoTools } from '../../src/tools/video.js';
import { registerMusicTools } from '../../src/tools/music.js';
import { registerJobTools } from '../../src/tools/jobs.js';
import { client as singleton, type GeminiClient } from '../../src/client.js';
import { SessionState } from '../../src/session.js';

/**
 * Transport neutrality: the registrars must take their GeminiClient as an
 * argument rather than reaching for the module-level env-driven singleton, so a
 * Cloudflare Worker entry point can build one client PER AUTHENTICATED USER.
 *
 * These tests inject a stub client and assert the tools call *it*, never the
 * singleton.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MP4 = Buffer.from('fake-mp4').toString('base64');
const MP3 = Buffer.from('fake-mp3').toString('base64');

describe('registrars accept an injected client', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-inject-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registerModelTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'listModels');
    const injected = {
      listModels: vi.fn().mockResolvedValue([{ name: 'models/injected-image', displayName: 'Injected' }]),
      defaultModel: vi.fn().mockReturnValue('injected-default'),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerModelTools(s, injected));
    const body = parseToolResult<{ default: string; models: unknown[] }>(await h.callTool('gemini_list_models'));
    await h.close();

    expect(injected.listModels).toHaveBeenCalled();
    expect(body.default).toBe('injected-default');
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerGenerateTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'generate');
    const injected = {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerGenerateTools(s, injected));
    await h.callTool('gemini_image_generate', { prompt: 'a cat', inline: true });
    await h.close();

    expect(injected.generate).toHaveBeenCalled();
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerSetTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'generate');
    const injected = {
      generate: vi.fn().mockResolvedValue({ images: [{ base64: PNG, mimeType: 'image/png' }] }),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerSetTools(s, injected));
    await h.callTool('gemini_image_set', { master_prompt: 'a cat', scenes: ['sitting'], output_dir: dir });
    await h.close();

    expect(injected.generate).toHaveBeenCalled();
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerInteractTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'interact');
    const injected = {
      interact: vi.fn().mockResolvedValue({ id: 'interactions/injected', images: [{ base64: PNG, mimeType: 'image/png' }] }),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerInteractTools(s, injected));
    await h.callTool('gemini_interact', { input: 'a cat', output_dir: dir });
    await h.close();

    expect(injected.interact).toHaveBeenCalled();
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerVideoTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'generateVideo');
    const injected = {
      generateVideo: vi.fn().mockResolvedValue({ id: 'vid1', videos: [{ base64: MP4, mimeType: 'video/mp4' }] }),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerVideoTools(s, injected));
    await h.callTool('gemini_video_generate', { prompt: 'a cat walking', output_dir: dir });
    await h.close();

    expect(injected.generateVideo).toHaveBeenCalled();
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerMusicTools uses the injected client, not the singleton', async () => {
    const singletonSpy = vi.spyOn(singleton, 'generateMusic');
    const injected = {
      generateMusic: vi.fn().mockResolvedValue({ id: 'mus1', audios: [{ base64: MP3, mimeType: 'audio/mpeg' }] }),
      session: new SessionState(),
    } as unknown as GeminiClient;

    const h = await createTestHarness((s) => registerMusicTools(s, injected));
    await h.callTool('gemini_music_generate', { prompt: 'lo-fi beat', inline: true });
    await h.close();

    expect(injected.generateMusic).toHaveBeenCalled();
    expect(singletonSpy).not.toHaveBeenCalled();
  });

  it('registerJobTools takes its job registry from the client, not a module global', async () => {
    const injected = { session: new SessionState() } as unknown as GeminiClient;
    const h = await createTestHarness((s) => registerJobTools(s, injected));
    const names = (await h.listTools()).map((t) => t.name);
    await h.close();

    expect(names).toContain('gemini_get_result');
  });
});
