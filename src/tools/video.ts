import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpToolError } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { slugify, baseName } from '../images.js';
import { resolveImageInputs } from '../inputs.js';
import { DEFAULT_VIDEO_MODEL } from '../models.js';
import { emitMedia, timeoutMsSchema, idempotencyKeySchema, asyncSchema, withProgressHeartbeat, assertLocalInputsAvailable, imagesUrlSchema, imagesFileUrisSchema, type NamedMedia } from './shared.js';
import { fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

/** omni's own aspect-ratio enum — NOT the image tools' ASPECT_RATIOS. */
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;
const VIDEO_TASKS = ['text_to_video', 'image_to_video', 'reference_to_video', 'edit'] as const;

// The most-recent video interaction id (for continue_last) lives on
// `client.session`, NOT at module scope — one Cloudflare isolate serves many
// authenticated connector sessions, so a module-level id would let one user's
// continue_last resume another user's interaction under their own key. Video is
// not registered on the Worker today, but the hazard is identical, so it is
// scoped the same way. It stays separate from the image interact memory: a
// "last video" and a "last image" are distinct chains. See src/session.ts.

export function registerVideoTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_video_generate',
    {
      description:
        'Generate a short video via the Gemini omni model (preview): text→video, image→video / reference→video ' +
        '(supply reference image[s]), or edit a prior video (task: "edit" + previous_interaction_id / continue_last). ' +
        'Output is written to disk as MP4 (video has no inline MCP block). Video runs long — use `async: true` to get a ' +
        'job_id immediately and poll gemini_get_result, or raise `timeout_ms`. Preview model: needs a funded account.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Description of the video to generate (or the edit instruction when task=edit)'),
        aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional().describe('Output aspect ratio (omni: 16:9 or 9:16)'),
        task: z.enum(VIDEO_TASKS).optional().describe('text_to_video (default), image_to_video / reference_to_video (need image input), or edit (needs previous_interaction_id)'),
        images: z.array(z.string().min(1)).optional().describe('Reference image path(s) for image_to_video / reference_to_video'),
        images_url: imagesUrlSchema('Reference stills'),
        images_file_uris: imagesFileUrisSchema('Reference stills'),
        images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs. Last resort: prefer images_url or images_file_uris, which keep image bytes out of the conversation'),
        from_clipboard: z.boolean().optional().describe('Use the image currently on the macOS clipboard as a reference'),
        filename: z.string().optional().describe('Base filename for the output video (extension stripped; default: slugified prompt)'),
        output_dir: z.string().optional().describe('Directory to write the video to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        model: z
          .string()
          .regex(/^[\w.-]+$/, 'must be a bare model id (letters, digits, ".", "_", "-")')
          .optional()
          .describe(`Model id override (default: ${DEFAULT_VIDEO_MODEL})`),
        previous_interaction_id: z.string().optional().describe('Interaction id to edit/continue (with task: "edit")'),
        continue_last: z.boolean().optional().describe('Continue from the most recent video interaction this server created (explicit previous_interaction_id wins)'),
        timeout_ms: timeoutMsSchema,
        idempotency_key: idempotencyKeySchema,
        async: asyncSchema,
        confirm: schemaConfirm,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      let previousInteractionId = args.previous_interaction_id;
      if (!previousInteractionId && args.continue_last) {
        if (!client.session.lastVideoInteractionId) {
          throw new McpToolError('No previous video interaction to continue in this session.', {
            hint: 'Generate a video first, or pass an explicit previous_interaction_id.',
          });
        }
        previousInteractionId = client.session.lastVideoInteractionId;
      }
      // Confirm-gate local file inputs (a prompt-injected `images` path could
      // exfiltrate a local file); base64 / clipboard pass through ungated.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local image input(s) to the Gemini omni API', '/v1beta/interactions', args.images);
      if (gate) return gate;
      const model = args.model?.trim() || DEFAULT_VIDEO_MODEL;
      const fingerprint = fingerprintRequest('gemini_video_generate', {
        model, prompt: args.prompt, aspect_ratio: args.aspect_ratio, task: args.task,
        images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
        images_url: args.images_url, images_file_uris: args.images_file_uris,
        previous_interaction_id: previousInteractionId,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_video_generate', fingerprint, idempotencyKey: args.idempotency_key, async: args.async }, async () => {
        const { inputs, report } = await resolveImageInputs(args, client);
        const r = await withProgressHeartbeat(extra, `Generating video (${model})`, () =>
          client.generateVideo({
            input: args.prompt,
            images: inputs.length ? inputs : undefined,
            model: args.model,
            aspectRatio: args.aspect_ratio,
            task: args.task,
            previousInteractionId,
            timeoutMs: args.timeout_ms,
          }));
        client.session.lastVideoInteractionId = r.id;

        const meta: Record<string, unknown> = { model, interaction_id: r.id };
        if (previousInteractionId) meta.previous_interaction_id = previousInteractionId;
        if (r.text) meta.text = r.text;
        if (report) meta.image_inputs = report;
        meta.hint = `To edit this video, call gemini_video_generate again with task: "edit" and previous_interaction_id: "${r.id}" (or continue_last: true).`;

        const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
        const named: NamedMedia[] = r.videos.map((media, i) => ({
          media,
          base: r.videos.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
        }));
        return emitMedia(named, 'video', { output_dir: args.output_dir, sink: client.mediaSink }, meta);
      });
    },
  );
}
