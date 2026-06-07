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
};

/** A generated image plus the base filename (no extension) to write it under. */
export interface NamedImage { image: GeneratedImage; base: string; }

/**
 * Either return images inline (base64 content blocks) or write them to disk and
 * return their paths as a text result. `inline` wins when true.
 */
export async function emit(named: NamedImage[], opts: { inline?: boolean; output_dir?: string }): Promise<CallToolResult> {
  if (opts.inline) {
    return {
      content: named.map((n) => ({ type: 'image' as const, data: n.image.base64, mimeType: n.image.mimeType })),
    };
  }
  const dir = resolveOutputDir(opts.output_dir);
  const images: string[] = [];
  for (const n of named) images.push(await writeImage(dir, n.base, n.image.base64, n.image.mimeType));
  return textResult({ images });
}
