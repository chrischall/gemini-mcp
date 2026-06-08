import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client } from '../client.js';
import { slugify, readImageAsInline, baseName, loadImageInputs } from '../images.js';
import { emit, sharedImageSchema, pickSeed, type NamedImage } from './shared.js';

export function registerGenerateTools(server: McpServer): void {
  server.registerTool(
    'gemini_generate_image',
    {
      description: 'Generate image(s) from a text prompt with a Gemini image model (Nano Banana / Nano Banana Pro).',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Text prompt describing the image'),
        count: z.number().int().positive().max(8).optional().describe('Number of independent images (default 1)'),
        filename: z.string().optional().describe('Base filename for the output image (extension stripped; default: slugified prompt)'),
        images: z.array(z.string().min(1)).optional().describe('Paths to reference input images (image-conditioned generation)'),
        images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs'),
        ...sharedImageSchema,
      },
    },
    async (args) => {
      const count = args.count ?? 1;
      const seed = pickSeed(args.seed);
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const refInputs = await loadImageInputs(args.images, args.images_base64);
      const named: NamedImage[] = [];
      for (let i = 0; i < count; i++) {
        const [img] = await client.generate({
          prompt: args.prompt,
          images: refInputs.length > 0 ? refInputs : undefined,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          imageSize: args.image_size,
          seed,
        });
        named.push({ image: img, base: count === 1 ? slug : `${slug}-${String(i + 1).padStart(2, '0')}` });
      }
      const meta: Record<string, unknown> = { model, seed };
      if (args.aspect_ratio) meta.aspect_ratio = args.aspect_ratio;
      if (args.image_size) meta.image_size = args.image_size;
      return emit(named, args, meta);
    },
  );

  server.registerTool(
    'gemini_edit_image',
    {
      description:
        'Edit or compose images: provide one or more input images (paths or base64), plus a text instruction. ' +
        'Gemini over-preserves the input; there is no edit-strength control — for large structural changes, reroll with a different `seed` or more forceful wording.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Instruction describing the edit or composition'),
        images: z.array(z.string().min(1)).optional().describe('Paths to input image file(s) (1 = edit, 2+ = compose)'),
        images_base64: z.array(z.string().min(1)).optional().describe('Input images as base64 strings or data URIs'),
        filename: z.string().optional().describe('Base filename for the output image (extension stripped; default: slugified prompt)'),
        ...sharedImageSchema,
      },
    },
    async (args) => {
      const hasPaths = (args.images?.length ?? 0) > 0;
      const hasBase64 = (args.images_base64?.length ?? 0) > 0;
      if (!hasPaths && !hasBase64) {
        throw new McpToolError('Provide at least one input image via `images` or `images_base64`.');
      }
      const seed = pickSeed(args.seed);
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const inputs = await loadImageInputs(args.images, args.images_base64);
      const [img] = await client.generate({
        prompt: args.prompt,
        images: inputs,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
        seed,
      });
      const meta: Record<string, unknown> = { model, seed };
      if (args.aspect_ratio) meta.aspect_ratio = args.aspect_ratio;
      if (args.image_size) meta.image_size = args.image_size;
      return emit([{ image: img, base: slug }], args, meta);
    },
  );
}
