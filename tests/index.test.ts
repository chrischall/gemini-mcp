import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { registerModelTools } from '../src/tools/models.js';
import { registerGenerateTools } from '../src/tools/generate.js';
import { registerSetTools } from '../src/tools/set.js';
import { registerInteractTools } from '../src/tools/interact.js';

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const h = await createTestHarness((s) => {
      registerModelTools(s);
      registerGenerateTools(s);
      registerSetTools(s);
      registerInteractTools(s);
    });
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['gemini_image_edit', 'gemini_image_generate', 'gemini_image_set', 'gemini_interact', 'gemini_list_models']);
    await h.close();
  });
});
