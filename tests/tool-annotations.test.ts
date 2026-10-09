import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { GeminiClient } from '../src/client.js';

/**
 * Invariant: every tool states `openWorldHint` explicitly, so a client that
 * keys its permission UX off it treats sibling tools consistently.
 *
 * `gemini_list_models` calls Google's API but shipped with only
 * `readOnlyHint` while `gemini_list_files` — the same kind of read — said
 * `openWorldHint: true` (fleet-audit#848). An omitted hint is not the same as
 * `false`: the MCP spec defaults it to `true`, and clients differ on whether
 * they apply that default, so leaving it out is the inconsistent case.
 */
describe('tool annotations', () => {
  async function registeredTools() {
    const client = new GeminiClient({ apiKey: 'k' });
    const h = await createTestHarness((server) => {
      for (const register of TOOL_REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();
    return tools;
  }

  it('declares openWorldHint on every tool', async () => {
    const missing = (await registeredTools())
      .filter((t) => typeof t.annotations?.openWorldHint !== 'boolean')
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('marks gemini_list_models as a read-only call to Google', async () => {
    const tool = (await registeredTools()).find((t) => t.name === 'gemini_list_models');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
