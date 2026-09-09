import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GeminiClient } from '../client.js';
import { slugify, baseName } from '../images.js';
import { resolveImageInputs } from '../inputs.js';
import { DEFAULT_MUSIC_MODEL } from '../models.js';
import { emitMedia, timeoutMsSchema, idempotencyKeySchema, asyncSchema, maxWaitMsSchema, withProgressHeartbeat, assertLocalInputsAvailable, imagesUrlSchema, imagesFileUrisSchema, type NamedMedia } from './shared.js';
import { fingerprintRequest } from '../jobs.js';
import { attachCost } from '../pricing.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

const MUSIC_MODELS = ['lyria-3-clip-preview', 'lyria-3.5', 'lyria-3-pro-preview'] as const;

/**
 * There is no output-format parameter, and there is no chaining.
 *
 * Both were docs-derived and both were wrong (probed live 2026-09-09):
 * `response_format.audio_format` is not a field — every Lyria model answers
 * `400 Unknown parameter 'audio_format' at 'response_format'` — and its real
 * name, `mime_type`, currently refuses every value but MP3 per-model
 * (`Audio MIME type AUDIO_WAV is not supported for models/lyria-3.5`). A
 * chained call dies inside the model, on the track it is handed back:
 * `400 Unsupported input mime type for this model: audio/s16le`.
 *
 * So neither is exposed. A parameter whose every non-default value is a 400 is
 * worse than an absent one: it costs schema tokens on every request and spends
 * a caller's turn discovering it does not work.
 */

export function registerMusicTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_music_generate',
    {
      description:
        'Generate music from a text prompt (mood, genre, instruments, structure, or lyrics inline) via a Lyria model: ' +
        'lyria-3-clip-preview (30s instrumental clip, default, cheapest), lyria-3.5 (full-length song with vocals) or ' +
        'lyria-3-pro-preview (longer-form). Output is MP3, written to disk (or returned inline). Single-turn: a track ' +
        'cannot be refined by a follow-up call, so put the whole brief in the prompt. Runs long — use `async: true` + ' +
        'gemini_get_result, or raise `timeout_ms`. Needs a funded account.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Description of the music: mood, genre, instruments, tempo, structure, or lyrics'),
        model: z.enum(MUSIC_MODELS).optional().describe(`Lyria model (default: ${DEFAULT_MUSIC_MODEL} — 30s, $0.04). lyria-3.5 and lyria-3-pro-preview run minutes-long at $0.08.`),
        images: z.array(z.string().min(1)).optional().describe('Optional reference image path(s) to condition the music'),
        images_url: imagesUrlSchema('Reference images'),
        images_file_uris: imagesFileUrisSchema('Reference images'),
        images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs. Last resort: prefer images_url or images_file_uris, which keep image bytes out of the conversation'),
        from_clipboard: z.boolean().optional().describe('Use the image currently on the macOS clipboard as a reference'),
        filename: z.string().optional().describe('Base filename for the output audio (extension stripped; default: slugified prompt)'),
        output_dir: z.string().optional().describe('Directory to write audio to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        inline: z.boolean().optional().describe('Return base64 audio inline instead of writing to disk'),
        background: z.boolean().optional().describe('Run the generation on Google\'s side and poll it, so a killed job can be recovered by gemini_get_result. Off by default — see gemini_video_generate'),
        timeout_ms: timeoutMsSchema,
        idempotency_key: idempotencyKeySchema,
        async: asyncSchema,
        max_wait_ms: maxWaitMsSchema,
        confirm: schemaConfirm,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      const model = args.model ?? DEFAULT_MUSIC_MODEL;
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local image input(s) to the Gemini Lyria API', '/v1beta/interactions', args.images);
      if (gate) return gate;
      const fingerprint = fingerprintRequest('gemini_music_generate', {
        model, prompt: args.prompt,
        images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
        images_url: args.images_url, images_file_uris: args.images_file_uris,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_music_generate', fingerprint, idempotencyKey: args.idempotency_key, async: args.async, waitMs: args.max_wait_ms }, async (ctx) => {
        const { inputs, report } = await resolveImageInputs(args, client);
        const r = await withProgressHeartbeat(extra, `Generating music (${model})`, () =>
          client.generateMusic({
            input: args.prompt,
            images: inputs.length ? inputs : undefined,
            model: args.model,
            timeoutMs: args.timeout_ms,
            background: args.background,
            // See gemini_video_generate: the id is what survives the executor.
            onInteractionStarted: ctx.reportInteraction,
          }));
        // The interaction id is still reported — it is the handle
        // gemini_get_result recovers a killed job's output with — but it is not
        // a conversation handle: Lyria has no second turn.
        const meta: Record<string, unknown> = { model, interaction_id: r.id };
        if (r.usage) meta.usage = r.usage;
        attachCost(meta, model, r.usage);
        if (r.text) meta.text = r.text;
        if (report) meta.image_inputs = report;
        meta.hint = 'Lyria is single-turn: to change this track, call gemini_music_generate again with a fuller prompt rather than a follow-up instruction.';

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
