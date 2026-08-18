import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { UPLOAD_MAX_BYTES, RASTER_IMAGE_TYPE_PATTERN } from '../upload-url.js';
import { wholeMb } from '../bytes.js';
import { step } from '../errors.js';

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
 * Hosted only — stdio has no HTTP surface to PUT against (and no need: it reads
 * local paths directly). Gated on `client.uploadUrls`, the same pattern as
 * `gemini_sign_media` / the library tools.
 *
 * ## The PUT response body is NOT the contract any more
 *
 * The retired Cloudflare connector served `/put` itself and answered
 * `201 { r2_key, size_bytes, content_type, hint }`. mcp-host's blob gateway is
 * a generic object store: it answers a bare 2xx and the body is whatever the
 * gateway feels like. So the `r2_key` a caller must keep is the one in THIS
 * result, minted here, known before a byte is sent — and success is "the PUT
 * returned 2xx", nothing finer. Every hint below says so; don't reintroduce
 * guidance to read the key out of the PUT response, it isn't there.
 *
 * ## Minting writes nothing
 *
 * There is no reservation, no pending-upload record, no placeholder object —
 * a mint is a tenant id, a key string and one HMAC. That is what makes a failed
 * mint atomic: it cannot leave orphaned state behind because it never had any
 * to leave. `tests/upload-flow.test.ts` holds that property to a fake gateway
 * that fails the call if it is touched at all.
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
        'A 2xx from that PUT means the bytes are stored; the key to reference them is the `r2_key` in THIS result (the PUT ' +
        'itself returns no useful body). Pass that r2_key in `images_r2_keys` on generation tools, save it permanently with ' +
        'gemini_save_character, or convert it to a ~48h Files API reference with gemini_upload_file({ r2_key }). Prefer this ' +
        'over images_base64 (which costs ~14k tokens per photo) whenever the caller has a shell. Images only, up to ' +
        `${wholeMb(UPLOAD_MAX_BYTES)}MB. The PUT must send exactly the Content-Type this URL was minted for — the signature ` +
        'covers it, so a mismatched header is rejected.',
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
      // `step` names the operation in the message, and `surfaceToolErrors`
      // (wired in index.ts) prefixes the tool and flattens the cause chain —
      // between them a mint failure can no longer reach the client as a bare
      // "Error occurred during tool execution".
      const minted = await step(
        `minting a signed upload URL for ${args.filename} (${args.content_type})`,
        () => minter.mint(args.filename, args.content_type),
      );
      return textResult({
        upload_url: minted.url,
        method: 'PUT',
        r2_key: minted.key,
        content_type: minted.contentType,
        expires_at: new Date(minted.expiresAtMs).toISOString(),
        max_bytes: UPLOAD_MAX_BYTES,
        curl_hint: `curl -sS -X PUT -H "Content-Type: ${minted.contentType}" --data-binary @${args.filename} "${minted.url}"`,
        // Named for what it is: the PUT's own body is the object store's, not
        // this connector's, so 2xx is the whole success signal.
        success_is: 'any 2xx from the PUT; the response body is not part of the contract and carries no r2_key',
        hint:
          'PUT the raw bytes within ~10 minutes with exactly the Content-Type above; no Authorization header is needed ' +
          '(the signature in the URL is the auth, and it covers the content type). On a 2xx, reference the `r2_key` from ' +
          'THIS result — not the PUT response: images_r2_keys on generation tools (master_images_r2_keys on ' +
          'gemini_image_set), gemini_save_character to keep it with no expiry, or gemini_upload_file({ r2_key }) for a ' +
          '~48h files/… reference. Uploads themselves follow the media retention schedule (default 7 days).',
      });
    },
  );
}
