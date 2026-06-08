import { z } from 'zod';
import { textResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GeneratedImage } from '../client.js';
import { writeImage, resolveOutputDir } from '../images.js';

/** Supported output aspect ratios (Gemini image API). */
export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
/** Supported output resolutions. */
export const IMAGE_SIZES = ['1K', '2K', '4K'] as const;

/**
 * The model/aspect/size/output fields every generation tool shares. Defined once
 * here so descriptions can't drift between `generate.ts` and `set.ts`. Spread
 * into each tool's `inputSchema`.
 */
export const sharedImageSchema = {
  model: z.string().optional().describe('Model id override (default: server default; see gemini_list_models)'),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Output aspect ratio'),
  image_size: z.enum(IMAGE_SIZES).optional().describe('Output resolution'),
  output_dir: z.string().optional().describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
  inline: z.boolean().optional().describe('Return base64 images inline instead of writing to disk'),
  seed: z.number().int().optional().describe('Seed for reproducible generation; random if omitted'),
};

/** A generated image plus the base filename (no extension) to write it under. */
export interface NamedImage { image: GeneratedImage; base: string; }

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
