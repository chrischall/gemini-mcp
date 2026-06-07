import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { client } from '../client.js';
import { slugify, readImageAsInline } from '../images.js';
import { emit, type NamedImage } from './shared.js';

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
const IMAGE_SIZES = ['1K', '2K', '4K'] as const;

const shared = {
  model: z.string().optional().describe('Model id override (default: server default; see gemini_list_models)'),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio'),
  image_size: z.enum(IMAGE_SIZES).optional().describe('Output resolution'),
  output_dir: z.string().optional().describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
  inline: z.boolean().optional().describe('Return base64 images inline instead of writing to disk'),
};

export function registerGenerateTools(server: McpServer): void {
  server.registerTool(
    'gemini_generate_image',
    {
      description: 'Generate image(s) from a text prompt with a Gemini image model (Nano Banana / Nano Banana Pro).',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Text prompt describing the image'),
        count: z.number().int().positive().max(8).optional().describe('Number of independent images (default 1)'),
        ...shared,
      },
    },
    async (args) => {
      const count = args.count ?? 1;
      const slug = slugify(args.prompt);
      const named: NamedImage[] = [];
      for (let i = 0; i < count; i++) {
        const [img] = await client.generate({
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          imageSize: args.image_size,
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
        ...shared,
      },
    },
    async (args) => {
      const inputs = await Promise.all(args.images.map((p) => readImageAsInline(p)));
      const [img] = await client.generate({
        prompt: args.prompt,
        images: inputs,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
      });
      return emit([{ image: img, base: slugify(args.prompt) }], args);
    },
  );
}
