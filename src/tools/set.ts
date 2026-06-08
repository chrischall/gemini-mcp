import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client, type GeneratedImage } from '../client.js';
import { slugify, baseName, loadImageInputs } from '../images.js';
import { emit, sharedImageSchema, pickSeed, buildMeta, type NamedImage } from './shared.js';

export function registerSetTools(server: McpServer): void {
  server.registerTool(
    'gemini_generate_set',
    {
      description:
        'Generate a consistent SET of images: a master image from master_prompt, then one image per scene that references the master so the subject/style stays consistent. Provide `scenes` (explicit per-image prompts) OR `count` (variations of the master).',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        master_prompt: z.string().min(1).describe('Prompt for the master/reference image'),
        scenes: z.array(z.string().min(1)).min(1).max(8).optional().describe('Per-image prompts (1-8); each references the master'),
        count: z.number().int().positive().max(8).optional().describe('Number of variations of master_prompt (when scenes omitted)'),
        reference_mode: z.enum(['master', 'chain']).optional().describe('master: every image references the master (default). chain: each references the previous.'),
        basename: z.string().optional().describe('Base filename prefix for output images (default: slugified master_prompt)'),
        master_images: z.array(z.string().min(1)).optional().describe('Reference image paths passed to the master generation call'),
        master_images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs for master generation'),
        ...sharedImageSchema,
      },
    },
    async (args) => {
      // `scenes` is min(1) at the schema, so a non-undefined value is non-empty.
      if ((args.scenes && args.count) || (!args.scenes && !args.count)) {
        throw new McpToolError('Provide exactly one of `scenes` or `count`.');
      }
      const seed = pickSeed(args.seed);
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const cfg = { model: args.model, aspectRatio: args.aspect_ratio, imageSize: args.image_size, thinkingLevel: args.thinking_level };
      const slug = args.basename ? baseName(args.basename) : slugify(args.master_prompt);

      // 1. master (optionally seeded from reference images)
      const masterRefInputs = await loadImageInputs(args.master_images, args.master_images_base64);
      const [master] = await client.generate({
        prompt: args.master_prompt,
        images: masterRefInputs.length > 0 ? masterRefInputs : undefined,
        seed,
        ...cfg,
      });
      const named: NamedImage[] = [{ image: master, base: `${slug}-master` }];

      // 2. scene prompts (explicit, or N repeats of master_prompt for variations)
      const scenePrompts = args.scenes ?? Array.from({ length: args.count ?? 0 }, () => args.master_prompt);
      const mode = args.reference_mode ?? 'master';

      if (mode === 'chain') {
        let ref: GeneratedImage = master;
        for (let i = 0; i < scenePrompts.length; i++) {
          const [img] = await client.generate({ prompt: scenePrompts[i], images: [ref], seed: seed + i + 1, ...cfg });
          named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` });
          ref = img;
        }
      } else {
        const scenes = await Promise.all(
          scenePrompts.map((p, i) => client.generate({ prompt: p, images: [master], seed: seed + i + 1, ...cfg }).then((r) => r[0])),
        );
        scenes.forEach((img, i) => named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` }));
      }

      return emit(named, args, buildMeta(model, seed, args));
    },
  );
}
