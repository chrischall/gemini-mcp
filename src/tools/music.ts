import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpToolError } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { slugify, baseName, gatherImageInputs } from '../images.js';
import { DEFAULT_MUSIC_MODEL } from '../models.js';
import { emitMedia, timeoutMsSchema, idempotencyKeySchema, asyncSchema, withProgressHeartbeat, assertLocalInputsAvailable, type NamedMedia } from './shared.js';
import { dispatch, fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

const MUSIC_MODELS = ['lyria-3-clip-preview', 'lyria-3-pro-preview'] as const;
const AUDIO_FORMATS = ['mp3', 'wav'] as const;
/** WAV is Lyria-3-Pro-only (docs); reject it on the clip model up front. */
function isProModel(model: string): boolean { return /pro/i.test(model); }

// Most-recent music interaction id (this process), for continue_last.
let lastMusicInteractionId: string | undefined;
/** Test-only: clear the module-level session memory. */
export function __resetMusicMemory(): void { lastMusicInteractionId = undefined; }

export function registerMusicTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_music_generate',
    {
      description:
        'Generate music from a text prompt (mood, genre, instruments, structure, or lyrics inline) via a Lyria model ' +
        '(preview): lyria-3-clip-preview (~30s clips, default) or lyria-3-pro-preview (longer, WAV-capable). Written to ' +
        'disk as MP3/WAV (or returned inline). Runs long — use `async: true` + gemini_get_result, or raise `timeout_ms`. ' +
        'Preview model: needs a funded account.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Description of the music: mood, genre, instruments, tempo, structure, or lyrics'),
        model: z.enum(MUSIC_MODELS).optional().describe(`Lyria model (default: ${DEFAULT_MUSIC_MODEL}). Pro is longer-form and supports WAV.`),
        audio_format: z.enum(AUDIO_FORMATS).optional().describe('Output format (default mp3). wav is lyria-3-pro-preview-only.'),
        images: z.array(z.string().min(1)).optional().describe('Optional reference image path(s) to condition the music'),
        images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs'),
        from_clipboard: z.boolean().optional().describe('Use the image currently on the macOS clipboard as a reference'),
        filename: z.string().optional().describe('Base filename for the output audio (extension stripped; default: slugified prompt)'),
        output_dir: z.string().optional().describe('Directory to write audio to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        inline: z.boolean().optional().describe('Return base64 audio inline instead of writing to disk'),
        previous_interaction_id: z.string().optional().describe('Interaction id to continue from'),
        continue_last: z.boolean().optional().describe('Continue from the most recent music interaction this server created (explicit previous_interaction_id wins)'),
        timeout_ms: timeoutMsSchema,
        idempotency_key: idempotencyKeySchema,
        async: asyncSchema,
        confirm: schemaConfirm,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      const model = args.model ?? DEFAULT_MUSIC_MODEL;
      if (args.audio_format === 'wav' && !isProModel(model)) {
        throw new McpToolError(`WAV output requires a Pro model; ${model} only produces MP3.`, {
          hint: 'Use model: "lyria-3-pro-preview" for WAV, or drop audio_format to get MP3.',
        });
      }
      let previousInteractionId = args.previous_interaction_id;
      if (!previousInteractionId && args.continue_last) {
        if (!lastMusicInteractionId) {
          throw new McpToolError('No previous music interaction to continue in this session.', {
            hint: 'Generate music first, or pass an explicit previous_interaction_id.',
          });
        }
        previousInteractionId = lastMusicInteractionId;
      }
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local image input(s) to the Gemini Lyria API', '/v1beta/interactions', args.images);
      if (gate) return gate;
      const fingerprint = fingerprintRequest('gemini_music_generate', {
        model, prompt: args.prompt, audio_format: args.audio_format,
        images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
        previous_interaction_id: previousInteractionId,
      });
      return dispatch({ toolName: 'gemini_music_generate', fingerprint, idempotencyKey: args.idempotency_key, async: args.async }, async () => {
        const inputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
        const r = await withProgressHeartbeat(extra, `Generating music (${model})`, () =>
          client.generateMusic({
            input: args.prompt,
            images: inputs.length ? inputs : undefined,
            model: args.model,
            audioFormat: args.audio_format,
            previousInteractionId,
            timeoutMs: args.timeout_ms,
          }));
        lastMusicInteractionId = r.id;

        const meta: Record<string, unknown> = { model, interaction_id: r.id };
        if (previousInteractionId) meta.previous_interaction_id = previousInteractionId;
        if (r.text) meta.text = r.text;
        meta.hint = `To continue this track, call gemini_music_generate again with previous_interaction_id: "${r.id}" (or continue_last: true).`;

        const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
        const named: NamedMedia[] = r.audios.map((media, i) => ({
          media,
          base: r.audios.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
        }));
        return emitMedia(named, 'audio', { inline: args.inline, output_dir: args.output_dir, sink: client.mediaSink }, meta);
      });
    },
  );
}
