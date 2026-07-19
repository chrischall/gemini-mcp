import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { GeminiClient } from './client.js';

/**
 * OAuth props persisted per authenticated connector user.
 *
 * This is what `@cloudflare/workers-oauth-provider` stores against the grant,
 * and what `buildClient` in `worker.ts` turns back into a per-user
 * {@link GeminiClient}. Deliberately minimal: the Google API key and nothing
 * else — anything added here is another secret at rest.
 */
export interface GeminiProps extends Record<string, unknown> {
  apiKey: string;
}

/**
 * Login definition for the hosted connector.
 *
 * Gemini has no OAuth flow we can broker — the Generative Language API
 * authenticates with a user-held API key in the `x-goog-api-key` header — so
 * the connector's own OAuth handshake wraps a one-field credential form.
 *
 * The type-only `ConnectorAuth` import keeps this module loadable under Node:
 * `@chrischall/mcp-connector`'s runtime entry pulls in `agents` /
 * `@cloudflare/workers-oauth-provider`, which only resolve inside workerd.
 */
export const geminiAuth: ConnectorAuth<GeminiProps> = {
  service: 'Gemini',
  // Google blue — the Gemini/AI Studio brand accent.
  accent: '#4285F4',
  fields: [
    {
      name: 'apiKey',
      label: 'Gemini API key',
      type: 'password',
    },
  ],
  // Honest, because the alternative is a lie the storage layer contradicts:
  // the OAuth provider persists these props in Cloudflare KV for as long as
  // the grant lives. Say so, say what it is used for, and say how to revoke.
  privacyNote:
    'Your API key is stored encrypted at rest in Cloudflare KV, tied to this connection, and used only to call ' +
    "Google's Generative Language API on your behalf. It is never sent anywhere else. Revoke the connection here, " +
    'or delete the key at https://aistudio.google.com/apikey, to stop it being used.',

  /**
   * Verify the key before the grant is issued, so a typo fails on the login
   * page instead of on the user's first tool call. `listModels()` is the
   * cheapest authenticated read the API offers (`GET /v1beta/models`) and is
   * free — it does not touch a paid generation endpoint.
   *
   * Throwing is the contract: `handleAuthorize` renders the thrown message back
   * onto the form.
   */
  async login(fields) {
    const apiKey = (fields.apiKey ?? '').trim();
    if (!apiKey) throw new Error('Enter your Gemini API key.');

    try {
      await new GeminiClient({ apiKey }).listModels();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not verify that Gemini API key: ${detail} — create or check a key at https://aistudio.google.com/apikey.`,
      );
    }

    return { apiKey };
  },
};
