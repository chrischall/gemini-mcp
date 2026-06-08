import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client } from '../client.js';
import { slugify, baseName, loadImageInputs } from '../images.js';
import { emit, ASPECT_RATIOS, IMAGE_SIZES, type NamedImage } from './shared.js';

export function registerInteractTools(server: McpServer): void {
  server.registerTool(
    'gemini_interact',
    {
      description:
        "Multi-turn image generation/editing via Gemini's Interactions API (Beta). " +
        'Returns an interaction `id`; pass it back as `previous_interaction_id` to iteratively ' +
        'refine the SAME image conversationally (the recommended way to make incremental edits). ' +
        'Output is JPEG.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        input: z.string().min(1).describe('Text prompt or editing instruction'),
        previous_interaction_id: z
          .string()
          .optional()
          .describe('ID from a prior gemini_interact call — continues that multi-turn conversation'),
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
          .describe('Model id override (default: server default; see gemini_list_models)'),
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
          .describe('Public YouTube URL as a video reference (video→image; use a Flash model e.g. gemini-3.1-flash-image)'),
      },
    },
    async (args) => {
      const inputs = await loadImageInputs(args.images, args.images_base64);
      const r = await client.interact({
        input: args.input,
        images: inputs.length ? inputs : undefined,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
        thinkingLevel: args.thinking_level,
        previousInteractionId: args.previous_interaction_id,
        googleSearch: args.google_search,
        videoUrl: args.video_url,
      });

      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const meta: Record<string, unknown> = { model, interaction_id: r.id };
      if (r.text) meta.text = r.text;
      if (r.grounding) meta.grounding = r.grounding;

      const slug = args.filename ? baseName(args.filename) : slugify(args.input);
      const named: NamedImage[] = r.images.map((image, i) => ({
        image,
        base: r.images.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
      }));

      return emit(named, args, meta);
    },
  );
}
