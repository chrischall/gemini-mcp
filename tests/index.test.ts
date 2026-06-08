import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { registerModelTools } from '../src/tools/models.js';
import { registerGenerateTools } from '../src/tools/generate.js';
import { registerSetTools } from '../src/tools/set.js';

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const h = await createTestHarness((s) => {
      registerModelTools(s);
      registerGenerateTools(s);
      registerSetTools(s);
    });
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['gemini_edit_image', 'gemini_generate_image', 'gemini_generate_set', 'gemini_list_models']);
    await h.close();
  });
});
