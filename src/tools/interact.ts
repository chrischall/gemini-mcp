import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client } from '../client.js';
import { slugify, baseName, gatherImageInputs } from '../images.js';
import { emit, ASPECT_RATIOS, IMAGE_SIZES, MODEL_CHOICE_GUIDE, resolveVideoInput, videoPathSchema, type NamedImage } from './shared.js';

// The most recent interaction id this server process created — what
// `continue_last: true` resumes. In-memory only: an MCP server lives for the
// host session, so "last" means "last in this session".
let lastInteractionId: string | undefined;

export function registerInteractTools(server: McpServer): void {
  server.registerTool(
    'gemini_interact',
    {
      description:
        'Preferred tool for iterative or multi-step refinement of a single image — ' +
        "multi-turn generation/editing via Gemini's Interactions API. " +
        'To refine, capture the returned interaction `id` and pass it as `previous_interaction_id` ' +
        'on the next call — do NOT start a new interaction or re-upload the image for each tweak. ' +
        '`continue_last: true` chains from this session\'s most recent interaction without threading the id. ' +
        'Output is JPEG.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        input: z.string().min(1).describe('Text prompt or editing instruction'),
        previous_interaction_id: z
          .string()
          .optional()
          .describe('ID from a prior gemini_interact call — continues that multi-turn conversation'),
        continue_last: z
          .boolean()
          .optional()
          .describe('Continue from the most recent interaction this server created (convenience for previous_interaction_id; an explicit id wins)'),
        images: z
          .array(z.string().min(1))
          .optional()
          .describe('Paths to reference input images'),
        images_base64: z
          .array(z.string().min(1))
          .optional()
          .describe('Reference images as base64 strings or data URIs'),
        model: z
          .string()
          .optional()
          .describe(`Model id override (default: server default; see gemini_list_models). ${MODEL_CHOICE_GUIDE}`),
        aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio'),
        image_size: z
          .enum(IMAGE_SIZES)
          .optional()
          .describe('Output resolution (512 = 0.5K, Flash-only)'),
        thinking_level: z
          .enum(['minimal', 'high'])
          .optional()
          .describe('Reasoning depth; higher can help complex/structural edits'),
        filename: z
          .string()
          .optional()
          .describe('Base filename for the output image (extension stripped; default: slugified input)'),
        output_dir: z
          .string()
          .optional()
          .describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        inline: z
          .boolean()
          .optional()
          .describe('Return base64 images inline instead of writing to disk'),
        google_search: z
          .boolean()
          .optional()
          .describe('Ground the image in live Google Search results (current events, weather, data)'),
        video_url: z
          .string()
          .url()
          .optional()
          .describe('Public YouTube URL (or a previously uploaded Files API uri) as a video reference (video→image; use a Flash model e.g. gemini-3.1-flash-image)'),
        video_path: videoPathSchema,
        from_clipboard: z
          .boolean()
          .optional()
          .describe('Use the image currently on the macOS system clipboard as an input (downscaled to JPEG)'),
      },
    },
    async (args) => {
      let previousInteractionId = args.previous_interaction_id;
      if (!previousInteractionId && args.continue_last) {
        if (!lastInteractionId) {
          throw new McpToolError('No previous interaction to continue in this session.', {
            hint: 'Call gemini_interact once without continue_last first, or pass an explicit previous_interaction_id.',
          });
        }
        previousInteractionId = lastInteractionId;
      }
      const inputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
      const video = await resolveVideoInput(args);
      const r = await client.interact({
        input: args.input,
        images: inputs.length ? inputs : undefined,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
        thinkingLevel: args.thinking_level,
        previousInteractionId,
        googleSearch: args.google_search,
        videoUrl: video.videoUrl,
        videoMimeType: video.videoMimeType,
      });
      lastInteractionId = r.id;

      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const meta: Record<string, unknown> = { model, interaction_id: r.id };
      if (previousInteractionId) meta.previous_interaction_id = previousInteractionId;
      meta.hint = `To refine this image, call gemini_interact again with previous_interaction_id: "${r.id}" (or continue_last: true).`;
      if (r.text) meta.text = r.text;
      if (r.grounding) meta.grounding = r.grounding;
      if (video.videoFileMeta) meta.video_file = video.videoFileMeta;

      const slug = args.filename ? baseName(args.filename) : slugify(args.input);
      const named: NamedImage[] = r.images.map((image, i) => ({
        image,
        base: r.images.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
      }));

      return emit(named, args, meta);
    },
  );
}
