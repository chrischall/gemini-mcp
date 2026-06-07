import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError } from '@chrischall/mcp-utils';
import { client, type GeneratedImage } from '../client.js';
import { slugify } from '../images.js';
import { emit, type NamedImage } from './shared.js';

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
const IMAGE_SIZES = ['1K', '2K', '4K'] as const;

export function registerSetTools(server: McpServer): void {
  server.registerTool(
    'gemini_generate_set',
    {
      description:
        'Generate a consistent SET of images: a master image from master_prompt, then one image per scene that references the master so the subject/style stays consistent. Provide `scenes` (explicit per-image prompts) OR `count` (variations of the master).',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        master_prompt: z.string().min(1).describe('Prompt for the master/reference image'),
        scenes: z.array(z.string().min(1)).optional().describe('Per-image prompts; each references the master'),
        count: z.number().int().positive().max(8).optional().describe('Number of variations of master_prompt (when scenes omitted)'),
        reference_mode: z.enum(['master', 'chain']).optional().describe('master: every image references the master (default). chain: each references the previous.'),
        model: z.string().optional().describe('Model id override (see gemini_list_models)'),
        aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio'),
        image_size: z.enum(IMAGE_SIZES).optional().describe('Output resolution'),
        output_dir: z.string().optional().describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        inline: z.boolean().optional().describe('Return base64 images inline instead of writing to disk'),
      },
    },
    async (args) => {
      if ((args.scenes && args.count) || (!args.scenes && !args.count)) {
        throw new McpToolError('Provide exactly one of `scenes` or `count`.');
      }
      const cfg = { model: args.model, aspectRatio: args.aspect_ratio, imageSize: args.image_size };
      const slug = slugify(args.master_prompt);

      // 1. master
      const [master] = await client.generate({ prompt: args.master_prompt, ...cfg });
      const named: NamedImage[] = [{ image: master, base: `${slug}-master` }];

      // 2. scene prompts (explicit, or N repeats of master_prompt for variations)
      const scenePrompts = args.scenes ?? Array.from({ length: args.count ?? 0 }, () => args.master_prompt);
      const mode = args.reference_mode ?? 'master';

      if (mode === 'chain') {
        let ref: GeneratedImage = master;
        for (let i = 0; i < scenePrompts.length; i++) {
          const [img] = await client.generate({ prompt: scenePrompts[i], images: [ref], ...cfg });
          named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` });
          ref = img;
        }
      } else {
        const scenes = await Promise.all(
          scenePrompts.map((p) => client.generate({ prompt: p, images: [master], ...cfg }).then((r) => r[0])),
        );
        scenes.forEach((img, i) => named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` }));
      }

      return emit(named, args);
    },
  );
}
