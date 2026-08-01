import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, textResult } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { UPLOAD_MAX_BYTES, RASTER_IMAGE_TYPE_PATTERN } from '../upload-url.js';
import { wholeMb } from '../bytes.js';

/**
 * `gemini_get_upload_url` — mint a short-lived signed PUT URL so a shell can
 * upload a reference image with ZERO auth headers:
 *
 *   curl -sS -X PUT -H "Content-Type: image/jpeg" --data-binary @photo.jpg "<upload_url>"
 *
 * This closes the last gap in the no-bytes-in-the-conversation story. The two
 * existing byte routes each exclude a common caller: `images_base64` costs
 * ~14k tokens per photo and corrupts silently on a truncated read, and
 * `POST /upload` needs the MCP session's OAuth bearer token, which a sandboxed
 * shell doesn't have. A signed URL is mintable by the session and usable by
 * the shell.
 *
 * Hosted connector only — stdio has no HTTP surface to PUT against (and no
 * need: it reads local paths directly). Gated on `client.uploadUrls`, the same
 * pattern as `gemini_sign_media` / the library tools.
 */
export function registerUploadUrlTools(server: McpServer, client: GeminiClient): void {
  const minter = client.uploadUrls;
  if (!minter) return;

  server.registerTool(
    'gemini_get_upload_url',
    {
      description:
        'Mint a short-lived (~10 min) signed PUT URL for uploading one reference image to this connector with NO auth ' +
        'headers — usable from any shell: curl -sS -X PUT -H "Content-Type: image/jpeg" --data-binary @photo.jpg "<upload_url>". ' +
        'The response to the PUT returns an `r2_key` to reference the upload: pass it in `images_r2_keys` on generation ' +
        'tools, save it permanently with gemini_save_character, or convert it to a ~48h Files API reference with ' +
        'gemini_upload_file({ r2_key }). Prefer this over images_base64 (which costs ~14k tokens per photo) whenever the ' +
        `caller has a shell. Images only, up to ${wholeMb(UPLOAD_MAX_BYTES)}MB.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        filename: z
          .string()
          .min(1)
          .max(120)
          .describe('Filename of the upload (e.g. "finn.jpg") — sanitized into the object key and the suggested curl command'),
        content_type: z
          .string()
          // Raster only — image/svg+xml is a scriptable document and /media
          // serves from the connector's own origin (see RASTER_IMAGE_TYPE_PATTERN).
          .regex(RASTER_IMAGE_TYPE_PATTERN, 'must be a raster image MIME type like image/jpeg (SVG is not accepted)')
          .describe('MIME type of the bytes that will be PUT — raster images only (jpeg/png/webp/gif/avif/heic/heif/bmp/tiff; not SVG). The PUT must send exactly this Content-Type.'),
      },
    },
    async (args) => {
      let minted;
      try {
        minted = await minter.mint(args.filename, args.content_type);
      } catch (err) {
        throw new McpToolError(err instanceof Error ? err.message : String(err));
      }
      return textResult({
        upload_url: minted.url,
        method: 'PUT',
        r2_key: minted.key,
        content_type: minted.contentType,
        expires_at: new Date(minted.expiresAtMs).toISOString(),
        max_bytes: UPLOAD_MAX_BYTES,
        curl_hint: `curl -sS -X PUT -H "Content-Type: ${minted.contentType}" --data-binary @${args.filename} "${minted.url}"`,
        hint:
          'PUT the raw bytes within ~10 minutes; no Authorization header is needed (the signature in the URL is the auth). ' +
          'Then reference the returned r2_key: images_r2_keys on generation tools (master_images_r2_keys on gemini_image_set), ' +
          'gemini_save_character to keep it with no expiry, or gemini_upload_file({ r2_key }) for a ~48h files/… reference. ' +
          'Uploads themselves follow the media retention schedule (default 7 days).',
      });
    },
  );
}
