import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerModelTools } from '../../src/tools/models.js';
import { client } from '../../src/client.js';

afterEach(() => vi.restoreAllMocks());

describe('gemini_list_models', () => {
  it('returns the default model and the image-model list', async () => {
    vi.spyOn(client, 'defaultModel').mockReturnValue('gemini-3-pro-image');
    vi.spyOn(client, 'listModels').mockResolvedValue([
      { id: 'gemini-3-pro-image', displayName: 'Pro Image', description: 'pro' },
    ]);
    const h = await createTestHarness((srv) => registerModelTools(srv, client));
    const res = await h.callTool('gemini_list_models');
    const data = parseToolResult<{ default: string; models: unknown[] }>(res);
    expect(data.default).toBe('gemini-3-pro-image');
    expect(data.models).toHaveLength(1);
    await h.close();
  });
});
