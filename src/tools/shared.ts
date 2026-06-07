import { textResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GeneratedImage } from '../client.js';
import { writeImage, resolveOutputDir } from '../images.js';

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
