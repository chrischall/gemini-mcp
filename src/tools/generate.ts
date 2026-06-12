import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { client, type GroundingResult } from '../client.js';
import { slugify, baseName, gatherImageInputs } from '../images.js';
import { emit, sharedImageSchema, pickSeed, buildMeta, resolveVideoInput, videoPathSchema, type NamedImage } from './shared.js';

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
        video_url: z.string().url().optional().describe('Public YouTube URL (or a previously uploaded Files API uri) as a video reference (video→image; use a Flash model e.g. gemini-3.1-flash-image)'),
        video_path: videoPathSchema,
        ...sharedImageSchema,
      },
    },
    async (args) => {
      const count = args.count ?? 1;
      const seed = pickSeed(args.seed);
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const refInputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
      // Upload ONCE (before the count loop) — every generate call references
      // the same files/… uri.
      const video = await resolveVideoInput(args);
      const named: NamedImage[] = [];
      let capturedText: string | undefined;
      // For count>1, surface the FIRST call's grounding (each call grounds
      // independently; one representative set of sources beats concatenating N).
      let capturedGrounding: GroundingResult | undefined;
      for (let i = 0; i < count; i++) {
        // Distinct seed per image (seed+0 for the single-image case == echoed seed)
        // so count>1 yields N *different* images, not N duplicates.
        const result = await client.generate({
          prompt: args.prompt,
          images: refInputs.length > 0 ? refInputs : undefined,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          imageSize: args.image_size,
          seed: seed + i,
          thinkingLevel: args.thinking_level,
          googleSearch: args.google_search,
          videoUrl: video.videoUrl,
          videoMimeType: video.videoMimeType,
        });
        const { images: [img], text } = result;
        if (text && !capturedText) capturedText = text;
        if (result.grounding && !capturedGrounding) capturedGrounding = result.grounding;
        named.push({ image: img, base: count === 1 ? slug : `${slug}-${String(i + 1).padStart(2, '0')}` });
      }
      const meta = buildMeta(model, seed, args);
      if (capturedText) meta.text = capturedText;
      if (capturedGrounding) meta.grounding = capturedGrounding;
      if (video.videoFileMeta) meta.video_file = video.videoFileMeta;
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
      if (!hasPaths && !hasBase64 && !args.from_clipboard) {
        throw new McpToolError('Provide at least one input image via `images`, `images_base64`, or `from_clipboard`.');
      }
      const seed = pickSeed(args.seed);
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
      const inputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
      const result = await client.generate({
        prompt: args.prompt,
        images: inputs,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        imageSize: args.image_size,
        seed,
        thinkingLevel: args.thinking_level,
        googleSearch: args.google_search,
      });
      const { images: [img], text } = result;
      const meta = buildMeta(model, seed, args);
      if (text) meta.text = text;
      if (result.grounding) meta.grounding = result.grounding;
      return emit([{ image: img, base: slug }], args, meta);
    },
  );
}
