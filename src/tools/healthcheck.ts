import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { GeminiClient } from '../client.js';

/**
 * Register `gemini_healthcheck` — resolves the API key the way real tools do,
 * then makes one authenticated call to `/models`.
 *
 * Gemini has no browser bridge, so health here is entirely about the
 * credential: whether one resolved, and whether Google still accepts it. Those
 * are different problems with different fixes, and without this both surface
 * as the same opaque tool error.
 *
 * `/models` is the probe because it is the cheapest endpoint that REQUIRES a
 * key — an unauthenticated one would pass while the key was revoked, which is
 * the failure most worth catching. It is also read-only and free, so a
 * healthcheck never costs a generation.
 */
export function registerHealthcheckTools(server: McpServer, client: GeminiClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'gemini',
    hostLabel: 'generativelanguage.googleapis.com',
    probePath: '/v1beta/models',
    resolveCredential: async () => client.describeCredential(),
    probeFn: () => client.listModels(),
    hints: {
      no_credential:
        'No Gemini API key resolved. Set GEMINI_API_KEY (https://aistudio.google.com/apikey), or reconnect the connector so it supplies one.',
      credential_rejected:
        'Google rejected the API key. It is present but no longer valid — most often revoked, or restricted to different APIs/referrers. Issue a new key at https://aistudio.google.com/apikey.',
    },
  });
}
