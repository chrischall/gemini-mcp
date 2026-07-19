import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { registerModelTools } from '../src/tools/models.js';
import { registerGenerateTools } from '../src/tools/generate.js';
import { registerSetTools } from '../src/tools/set.js';
import { registerInteractTools } from '../src/tools/interact.js';
import { registerVideoTools } from '../src/tools/video.js';
import { registerMusicTools } from '../src/tools/music.js';
import { registerJobTools } from '../src/tools/jobs.js';
import { client } from '../src/client.js';

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const h = await createTestHarness((s) => {
      registerModelTools(s, client);
      registerGenerateTools(s, client);
      registerSetTools(s, client);
      registerInteractTools(s, client);
      registerVideoTools(s, client);
      registerMusicTools(s, client);
      registerJobTools(s, client);
    });
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'gemini_get_result',
      'gemini_image_edit',
      'gemini_image_generate',
      'gemini_image_set',
      'gemini_interact',
      'gemini_list_models',
      'gemini_music_generate',
      'gemini_video_generate',
    ]);
    await h.close();
  });
});
