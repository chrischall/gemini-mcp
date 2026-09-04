import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, minifiedResult } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { LIBRARY_NAME_PATTERN, type CharacterLibrary, type LibraryImage } from '../library.js';
import { acceptableUploadType } from '../upload-url.js';
import { withProgressHeartbeat } from './shared.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

/**
 * Tools over the per-account reference library (src/library.ts): named
 * characters and styles that persist across sessions with NO expiry.
 *
 * Hosted connector only — the library lives in the connector's R2 bucket, so
 * on stdio (no bucket) none of these register, mirroring how
 * `gemini_sign_media` is absent on disk sinks.
 */

const NAME_FIELD = z
  .string()
  .regex(LIBRARY_NAME_PATTERN, 'must be 1-40 lowercase letters, digits, "-" or "_"')
  .describe('Library name (slug): 1-40 lowercase letters, digits, "-" or "_", e.g. "finn" or "bold-cartoon-sports"');

const USE_CHARACTERS_HINT =
  'Pass characters: ["<name>", …] on gemini_image_generate / gemini_image_edit / gemini_image_set and the saved ' +
  'reference image + description are attached to the request automatically — nothing to re-upload and no bytes in the conversation.';

const USE_STYLE_HINT =
  'Pass style: "<name>" on gemini_image_generate / gemini_image_edit / gemini_image_set and the saved prompt fragment ' +
  '(and reference image, if any) are applied automatically.';

/**
 * Resolve the one image source a save call may carry. `image_r2_key` reads the
 * connector's own store (a signed upload or an earlier generation — tenant
 * gated); `image_url` is fetched by the server with the same SSRF guards as
 * `images_url`.
 */
async function resolveLibraryImage(
  client: GeminiClient,
  args: { image_r2_key?: string; image_url?: string },
  required: boolean,
): Promise<LibraryImage | undefined> {
  if (args.image_r2_key && args.image_url) {
    throw new McpToolError('Provide `image_r2_key` OR `image_url`, not both.');
  }
  // Raster only, on BOTH sources: library images can be re-signed and served
  // from /media (the connector's own origin), so a scriptable SVG saved here
  // would be stored XSS — the same gate the signed-upload path enforces.
  const rasterOnly = (image: LibraryImage): LibraryImage => {
    if (!acceptableUploadType(image.mimeType)) {
      throw new McpToolError(
        `The reference image is "${image.mimeType}", but the library accepts raster images only ` +
          '(jpeg/png/webp/gif/avif/heic/heif/bmp/tiff — not SVG, which can carry scripts). Convert it to PNG or JPEG first.',
      );
    }
    return image;
  };
  if (args.image_r2_key) {
    return rasterOnly(await client.readStoredMedia(args.image_r2_key));
  }
  if (args.image_url) {
    const fetched = await client.fetchRemoteImage(args.image_url);
    return rasterOnly({ bytes: fetched.bytes, mimeType: fetched.mimeType });
  }
  if (required) {
    throw new McpToolError(
      'Provide the reference image via `image_r2_key` (from gemini_get_upload_url + PUT, or a generation result\'s media[].r2_key) ' +
        'or `image_url` (a public https URL the server fetches).',
    );
  }
  return undefined;
}

export function registerLibraryTools(server: McpServer, client: GeminiClient): void {
  const library: CharacterLibrary | undefined = client.library;
  if (!library) return;

  server.registerTool(
    'gemini_save_character',
    {
      description:
        'Save a named character to this account\'s persistent reference library: one reference image plus a short ' +
        'description. Saved characters have NO expiry — unlike uploads (~retention window) and Files API references (~48h) ' +
        '— so a name saved once keeps working in every later session. Re-saving a name replaces it. ' +
        USE_CHARACTERS_HINT,
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        name: NAME_FIELD,
        description: z
          .string()
          .min(1)
          .describe('Short prose description woven into generation prompts (age, look, defining features, species…)'),
        image_r2_key: z
          .string()
          .min(1)
          .optional()
          .describe('Reference image already in this connector\'s store: an `r2_key` from gemini_get_upload_url + PUT, or from a generation result\'s media[].r2_key'),
        image_url: z.string().url().optional().describe('Reference image as a public https URL the SERVER fetches'),
      },
    },
    async (args, extra) => {
      const image = (await withProgressHeartbeat(extra, 'Loading the reference image', () =>
        resolveLibraryImage(client, args, true),
      ))!;
      const record = await library.saveCharacter({ name: args.name, description: args.description, image });
      return minifiedResult({
        saved: 'character',
        name: record.name,
        description: record.description,
        mime_type: record.mime_type,
        created_at: record.created_at,
        updated_at: record.updated_at,
        hint: USE_CHARACTERS_HINT,
      });
    },
  );

  server.registerTool(
    'gemini_list_characters',
    {
      description:
        'List this account\'s saved characters (persistent reference library): names, descriptions and timestamps. ' +
        USE_CHARACTERS_HINT,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const characters = await library.listCharacters();
      return minifiedResult({
        count: characters.length,
        characters: characters.map((c) => ({
          name: c.name,
          description: c.description,
          mime_type: c.mime_type,
          created_at: c.created_at,
          updated_at: c.updated_at,
        })),
        hint: characters.length
          ? USE_CHARACTERS_HINT
          : 'No saved characters yet. Save one with gemini_save_character (image via image_r2_key or image_url).',
      });
    },
  );

  server.registerTool(
    'gemini_delete_character',
    {
      description: 'Delete a saved character from this account\'s reference library. Generation calls naming it will then fail until it is re-saved.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { name: NAME_FIELD, confirm: schemaConfirm },
    },
    async (args) => {
      const gate = previewUnlessConfirmed(args.confirm, 'Delete a saved character (its reference image and description)', 'DELETE', `characters/${args.name}`);
      if (gate) return gate;
      const existed = await library.deleteCharacter(args.name);
      if (!existed) {
        throw new McpToolError(`No saved character "${args.name}". List what exists with gemini_list_characters.`);
      }
      return minifiedResult({ deleted: 'character', name: args.name });
    },
  );

  server.registerTool(
    'gemini_save_style',
    {
      description:
        'Save a named style preset to this account\'s persistent reference library: a reusable prompt fragment (and ' +
        'optionally a reference image) that a single word then applies to any generation. No expiry; re-saving a name replaces it. ' +
        USE_STYLE_HINT,
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        name: NAME_FIELD,
        prompt_fragment: z
          .string()
          .min(1)
          .describe('The style text appended to generation prompts, e.g. "bold cartoon style, thick outlines, saturated colors"'),
        image_r2_key: z.string().min(1).optional().describe('Optional style reference image already in this connector\'s store (an r2_key)'),
        image_url: z.string().url().optional().describe('Optional style reference image as a public https URL the SERVER fetches'),
      },
    },
    async (args, extra) => {
      const image = await withProgressHeartbeat(extra, 'Loading the style reference image', () =>
        resolveLibraryImage(client, args, false),
      );
      const record = await library.saveStyle({ name: args.name, promptFragment: args.prompt_fragment, image });
      return minifiedResult({
        saved: 'style',
        name: record.name,
        prompt_fragment: record.prompt_fragment,
        ...(record.image_key ? { has_reference_image: true } : {}),
        created_at: record.created_at,
        updated_at: record.updated_at,
        hint: USE_STYLE_HINT,
      });
    },
  );

  server.registerTool(
    'gemini_list_styles',
    {
      description: 'List this account\'s saved style presets (persistent reference library). ' + USE_STYLE_HINT,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const styles = await library.listStyles();
      return minifiedResult({
        count: styles.length,
        styles: styles.map((s) => ({
          name: s.name,
          prompt_fragment: s.prompt_fragment,
          ...(s.image_key ? { has_reference_image: true } : {}),
          created_at: s.created_at,
          updated_at: s.updated_at,
        })),
        hint: styles.length ? USE_STYLE_HINT : 'No saved styles yet. Save one with gemini_save_style.',
      });
    },
  );

  server.registerTool(
    'gemini_delete_style',
    {
      description: 'Delete a saved style preset from this account\'s reference library.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: { name: NAME_FIELD, confirm: schemaConfirm },
    },
    async (args) => {
      const gate = previewUnlessConfirmed(args.confirm, 'Delete a saved style preset', 'DELETE', `styles/${args.name}`);
      if (gate) return gate;
      const existed = await library.deleteStyle(args.name);
      if (!existed) {
        throw new McpToolError(`No saved style "${args.name}". List what exists with gemini_list_styles.`);
      }
      return minifiedResult({ deleted: 'style', name: args.name });
    },
  );
}
