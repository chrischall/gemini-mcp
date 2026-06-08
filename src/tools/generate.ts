import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { client } from '../client.js';
import { slugify, readImageAsInline, baseName } from '../images.js';
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
        ...sharedImageSchema,
      },
    },
    async (args) => {
      const count = args.count ?? 1;
      const seed = pickSeed(args.seed);
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const named: NamedImage[] = [];
      for (let i = 0; i < count; i++) {
        const [img] = await client.generate({
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          imageSize: args.image_size,
          seed,
        });
        named.push({ image: img, base: count === 1 ? slug : `${slug}-${String(i + 1).padStart(2, '0')}` });
      }
      return emit(named, args);
    },
  );

  server.registerTool(
    'gemini_edit_image',
    {
      description:
        'Edit or compose images: provide one image to edit, or multiple images to combine/blend, plus a text instruction.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Instruction describing the edit or composition'),
        images: z.array(z.string().min(1)).min(1).describe('Paths to input image file(s) (1 = edit, 2+ = compose)'),
        filename: z.string().optional().describe('Base filename for the output image (extension stripped; default: slugified prompt)'),
        ...sharedImageSchema,
      },
    },
    async (args) => {
      const seed = pickSeed(args.seed);
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const inputs = await Promise.all(args.images.map((p) => readImageAsInline(p)));
      const [img] = await client.generate({
        prompt: args.prompt,
        images: inputs,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
        seed,
      });
      return emit([{ image: img, base: slug }], args);
    },
  );
}
