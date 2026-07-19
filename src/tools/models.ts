import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';

export function registerModelTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_list_models',
    {
      description:
        'List the Gemini image-generation models available to your API key (Nano Banana / Nano Banana Pro family), and the current default model.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const models = await client.listModels();
      return textResult({ default: client.defaultModel(), models });
    },
  );
}
