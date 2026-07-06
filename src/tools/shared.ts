import { z } from 'zod';
import { textResult, McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { client, type GeneratedImage } from '../client.js';
import { writeImage, resolveOutputDir, resolveVideoPath, videoMimeType } from '../images.js';

/** Supported output aspect ratios (Gemini image API). */
export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
/** Supported output resolutions. `512` is Flash-only (0.5K); `1K`/`2K`/`4K` work on all image models. */
export const IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;

/**
 * The model/aspect/size/output fields every generation tool shares. Defined once
 * here so descriptions can't drift between `generate.ts` and `set.ts`. Spread
 * into each tool's `inputSchema`.
 */
/**
 * When to pick which Nano Banana model — shared by every tool's `model` param
 * so the guidance can't drift between them.
 */
export const MODEL_CHOICE_GUIDE =
  'gemini-3.1-flash-image (Nano Banana 2) is the versatile generalist workhorse — balances speed with ' +
  'state-of-the-art 4K generation, world knowledge, and reliable text rendering; excels at multi-reference-image ' +
  'processing and consistency. gemini-3-pro-image (Nano Banana Pro) is the premium choice for the most complex ' +
  'visual tasks — highest world knowledge, advanced localization, accurate brand consistency, precision creative control. ' +
  'gemini-3.1-flash-lite-image (Nano Banana 2 Lite) is the fastest/cheapest for simple tasks (1K only, no search grounding).';

export const sharedImageSchema = {
  // Bare id only: the model is interpolated into the URL path
  // (`/models/${model}:generateContent`), so slashes/colons/queries must be
  // rejected to keep a crafted value from escaping the path segment.
  model: z
    .string()
    .regex(/^[\w.-]+$/, 'must be a bare model id (letters, digits, ".", "_", "-")')
    .optional()
    .describe(`Model id override (default: server default; see gemini_list_models). ${MODEL_CHOICE_GUIDE}`),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio'),
  image_size: z.enum(IMAGE_SIZES).optional().describe('Output resolution (512 = 0.5K, Flash-only)'),
  output_dir: z.string().optional().describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
  inline: z.boolean().optional().describe('Return base64 images inline instead of writing to disk'),
  seed: z.number().int().optional().describe('Seed for reproducible generation; random if omitted'),
  thinking_level: z.enum(['minimal', 'high']).optional().describe('Reasoning depth (Gemini 3 models); higher can help complex/structural edits'),
  google_search: z.boolean().optional().describe('Ground the image in live Google Search results (current events, weather, data)'),
  from_clipboard: z.boolean().optional().describe('Use the image currently on the macOS system clipboard as an input (downscaled to JPEG)'),
};

/** A generated image plus the base filename (no extension) to write it under. */
export interface NamedImage { image: GeneratedImage; base: string; }

/** The resolved video reference a tool passes to the client, plus meta to echo. */
export interface VideoInput {
  videoUrl?: string;
  videoMimeType?: string;
  /** Echoed in result meta so callers can reuse the uploaded uri (~48h TTL). */
  videoFileMeta?: Record<string, unknown>;
}

/**
 * Turn the `video_url` / `video_path` tool args into the client's video opts.
 * A `video_path` is resolved locally (absolute → $GEMINI_INPUT_DIR → cwd),
 * uploaded to the Gemini Files API (streamed, never buffered), and waited to
 * `ACTIVE`; the returned `files/…` uri is what the generate call references.
 * The uploaded file (uri + expiry) is echoed via `videoFileMeta` so a caller
 * can pass the uri straight back as `video_url` instead of re-uploading.
 */
export async function resolveVideoInput(args: { video_url?: string; video_path?: string }): Promise<VideoInput> {
  if (args.video_url && args.video_path) {
    throw new McpToolError('Provide `video_url` OR `video_path`, not both.');
  }
  if (!args.video_path) return { videoUrl: args.video_url };
  const path = resolveVideoPath(args.video_path);
  const uploaded = await client.uploadVideo(path, videoMimeType(args.video_path));
  const videoFileMeta: Record<string, unknown> = { uri: uploaded.uri, name: uploaded.name };
  if (uploaded.expirationTime) videoFileMeta.expires = uploaded.expirationTime;
  return { videoUrl: uploaded.uri, videoMimeType: uploaded.mimeType, videoFileMeta };
}

/** Shared zod field for the `video_path` tool param. */
export const videoPathSchema = z
  .string()
  .optional()
  .describe(
    'Path to a local video file — uploaded to the Gemini Files API (~48h retention, 2 GB max) and used as the video reference. Alternative to video_url.',
  );

/**
 * Return the provided seed, or pick a random one. Capped well below INT32_MAX
 * so derived per-image seeds (`seed + i`) can't overflow a 32-bit int.
 */
export function pickSeed(seed?: number): number {
  return seed ?? Math.floor(Math.random() * 2_147_483_000);
}

/** Build the result metadata echoed to the caller (omitting unset optionals). */
export function buildMeta(
  model: string,
  seed: number,
  opts: { aspect_ratio?: string; image_size?: string },
): Record<string, unknown> {
  const meta: Record<string, unknown> = { model, seed };
  if (opts.aspect_ratio) meta.aspect_ratio = opts.aspect_ratio;
  if (opts.image_size) meta.image_size = opts.image_size;
  return meta;
}

/**
 * Either return images inline (base64 content blocks) or write them to disk and
 * return their paths as a text result. `inline` wins when true.
 * Optional `meta` is merged into the disk-path JSON result, or prepended as a
 * text block in inline mode (only if meta has keys).
 */
export async function emit(
  named: NamedImage[],
  opts: { inline?: boolean; output_dir?: string },
  meta?: Record<string, unknown>,
): Promise<CallToolResult> {
  if (opts.inline) {
    const imageBlocks = named.map((n) => ({ type: 'image' as const, data: n.image.base64, mimeType: n.image.mimeType }));
    if (meta && Object.keys(meta).length > 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }, ...imageBlocks],
      };
    }
    return { content: imageBlocks };
  }
  const dir = resolveOutputDir(opts.output_dir);
  const images: string[] = [];
  for (const n of named) images.push(await writeImage(dir, n.base, n.image.base64, n.image.mimeType));
  return textResult({ images, ...meta });
}
