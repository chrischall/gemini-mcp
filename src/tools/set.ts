import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client, type GeneratedImage } from '../client.js';
import { slugify, baseName, gatherImageInputs } from '../images.js';
import { emit, sharedImageSchema, pickSeed, buildMeta, timeoutRiskHint, withProgressHeartbeat, type NamedImage } from './shared.js';
import { dispatch, fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerSetTools(server: McpServer): void {
  server.registerTool(
    'gemini_image_set',
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
        confirm: schemaConfirm,
        ...sharedImageSchema,
      },
    },
    async (args, extra) => {
      // `scenes` is min(1) at the schema, so a non-undefined value is non-empty.
      if ((args.scenes && args.count) || (!args.scenes && !args.count)) {
        throw new McpToolError('Provide exactly one of `scenes` or `count`.');
      }
      // Confirm-gate local file inputs: only `master_images` (paths) can read a
      // local file; base64 references pass through ungated. Dry-run makes NO API call.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local master image input(s) to the Gemini API', '/v1beta/models/{model}:generateContent', args.master_images);
      if (gate) return gate;
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const fingerprint = fingerprintRequest('gemini_image_set', {
        model, master_prompt: args.master_prompt, scenes: args.scenes, count: args.count,
        reference_mode: args.reference_mode, aspect_ratio: args.aspect_ratio, image_size: args.image_size,
        thinking_level: args.thinking_level, google_search: args.google_search,
        master_images: args.master_images, master_images_base64: args.master_images_base64, from_clipboard: args.from_clipboard,
      });
      return dispatch({ toolName: 'gemini_image_set', fingerprint, idempotencyKey: args.idempotency_key, async: args.async }, async () => {
        const seed = pickSeed(args.seed);
        const cfg = { model: args.model, aspectRatio: args.aspect_ratio, imageSize: args.image_size, thinkingLevel: args.thinking_level, googleSearch: args.google_search, timeoutMs: args.timeout_ms };
        const slug = args.basename ? baseName(args.basename) : slugify(args.master_prompt);

        // 1. master (optionally seeded from reference images)
        const masterRefInputs = await gatherImageInputs({ images: args.master_images, images_base64: args.master_images_base64, from_clipboard: args.from_clipboard });
        const named: NamedImage[] = [];
        const masterResult = await withProgressHeartbeat(extra, `Generating image set (${model})`, async () => {
          const result = await client.generate({
            prompt: args.master_prompt,
            images: masterRefInputs.length > 0 ? masterRefInputs : undefined,
            seed,
            ...cfg,
          });
          const master = result.images[0];
          named.push({ image: master, base: `${slug}-master` });

          // Only the master's text is surfaced (below). Per-scene text is intentionally
          // dropped — a set returns one combined result and merging N captions is noise.
          // 2. scene prompts (explicit, or N repeats of master_prompt for variations)
          const scenePrompts = args.scenes ?? Array.from({ length: args.count ?? 0 }, () => args.master_prompt);
          const mode = args.reference_mode ?? 'master';

          if (mode === 'chain') {
            let ref: GeneratedImage = master;
            for (let i = 0; i < scenePrompts.length; i++) {
              const { images: [img] } = await client.generate({ prompt: scenePrompts[i], images: [ref], seed: seed + i + 1, ...cfg });
              named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` });
              ref = img;
            }
          } else {
            const scenes = await Promise.all(
              scenePrompts.map((p, i) => client.generate({ prompt: p, images: [master], seed: seed + i + 1, ...cfg }).then((r) => r.images[0])),
            );
            scenes.forEach((img, i) => named.push({ image: img, base: `${slug}-${String(i + 1).padStart(2, '0')}` }));
          }
          return result;
        });
        const masterText = masterResult.text;

        const meta = buildMeta(model, seed, args);
        if (masterText) meta.text = masterText;
        if (masterResult.grounding) meta.grounding = masterResult.grounding;
        // A set is master + N scenes in one tools/call — the most timeout-prone
        // tool. Effective image count drives the risk hint.
        const risk = timeoutRiskHint({ model, imageSize: args.image_size, count: named.length });
        if (risk) meta.timeout_risk = risk;
        return emit(named, args, meta);
      });
    },
  );
}
