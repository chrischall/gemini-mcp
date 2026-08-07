import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, textResult } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { withProgressHeartbeat } from './shared.js';
import { base64ToBytes, wholeMb } from '../bytes.js';
import { fileNameFromUrl } from '../fetch-image.js';
import { downloadFilename } from '../media-name.js';
import { previewUnlessConfirmed, previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

/**
 * First-class Gemini Files API access.
 *
 * The problem these solve: on a hosted connector there is no filesystem, so the
 * only way to hand over a picture used to be `images_base64` — and a base64
 * JPEG is ~14k tokens of the model's context window per photo, corrupted
 * outright whenever the file read that produced it was truncated. A Files API
 * reference is a 20-character string that any number of later calls can reuse.
 *
 * Three ways in, none of which put bytes in the conversation:
 *
 *  - `gemini_upload_file` with `url` — the SERVER downloads it.
 *  - `POST /upload` on the connector with the raw bytes as the request body —
 *    the intended path for an agent with a shell (see README).
 *  - `gemini_upload_file` with `path` — stdio only, reads the local file.
 *
 * `data_base64` exists as a deliberate last resort: it is the one form that
 * *does* cost context, and it is documented as such.
 *
 * Uploads are retained ~48h. After that the uri stops resolving — which,
 * unhelpfully, surfaces as the same generic 404 an unknown model id produces
 * (see `ChainedRequest404Error` in client.ts), so the expiry is stated
 * everywhere a uri is returned.
 */

/**
 * A `url` upload is buffered whole before being forwarded (fetched bytes, then
 * a Blob copy of them), so the cap has to be one the runtime can actually hold
 * — an advertised limit that fails as an OOM is worse than a smaller honest
 * one. A Cloudflare isolate gets 128MB total, hence the much lower hosted
 * figure; Node has no comparable ceiling.
 *
 * `POST /upload` is unaffected: it streams, and is bounded only by the Files
 * API's own 2 GB cap.
 */
const UPLOAD_URL_MAX_BYTES_DISK = 100 * 1024 * 1024;
const UPLOAD_URL_MAX_BYTES_HOSTED = 25 * 1024 * 1024;
/** What a `url` upload will accept: the media the Files API is useful for. */
const UPLOAD_ACCEPT = ['image/', 'video/', 'audio/'];

const RETENTION_NOTE =
  'Gemini retains uploaded files for ~48h. Until then this reference can be reused across any number of calls ' +
  '(images_file_uris on gemini_image_generate / _edit / _set / gemini_interact, or video_url) without re-sending the bytes.';

/** Shape returned by every upload path. */
function uploadResult(file: { name: string; uri: string; mimeType: string; expirationTime?: string; sizeBytes?: string; displayName?: string }) {
  return textResult({
    // The `files/<id>` form is what every tool parameter documents, so it leads.
    file_uri: file.name,
    // The absolute uri, for callers that would rather pass it through verbatim.
    uri: file.uri,
    name: file.name,
    mime_type: file.mimeType,
    ...(file.sizeBytes ? { size_bytes: Number(file.sizeBytes) } : {}),
    ...(file.displayName ? { display_name: file.displayName } : {}),
    expires: file.expirationTime ?? '~48h from upload',
    hint: `Pass "${file.name}" in images_file_uris (or video_url for video) on any image tool. ${RETENTION_NOTE}`,
  });
}

export function registerFileTools(server: McpServer, client: GeminiClient): void {
  const onDisk = client.mediaSink?.persistsFiles ?? true;
  const urlMaxBytes = onDisk ? UPLOAD_URL_MAX_BYTES_DISK : UPLOAD_URL_MAX_BYTES_HOSTED;

  server.registerTool(
    'gemini_upload_file',
    {
      description:
        'Upload a file — an image, reference photo, picture, screenshot, video or audio clip — to the Gemini Files API ' +
        'ONCE, and get back a reusable `file_uri` (`files/<id>`) to attach to later image, video or music generations. ' +
        'Keywords: upload, upload file, upload image, upload photo, attach, reference image, reference photo, ' +
        'file_uri, files api, image reference, reuse across calls. ' +
        'Use this instead of pasting base64 into a tool call: the reference is a short string, so no image bytes ever ' +
        'enter the conversation, and it can be reused across many generations until it expires (~48h). ' +
        'Provide exactly one of `url` (the server downloads it), `data_base64`' +
        (onDisk
          ? ', or `path` (a local file).'
          : ', or `r2_key` (re-upload media this connector generated, from media[].r2_key in an earlier result).') +
        (onDisk
          ? ''
          : ' This connector also accepts raw bytes over HTTP: POST them to /upload with the same Authorization header ' +
            'and a Content-Type of image/*, which avoids base64 entirely.'),
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe(
            `Public https URL the SERVER downloads and uploads (image/video/audio, up to ${wholeMb(urlMaxBytes)}MB). ` +
              'No bytes pass through the conversation.' +
              (onDisk ? '' : ' Larger files: POST the raw bytes to /upload, which streams instead of buffering.'),
          ),
        data_base64: z
          .string()
          .min(1)
          .optional()
          .describe('Raw base64 or a data: URI. Last resort — this is the one form that costs model context (~14k tokens for a modest JPEG).'),
        r2_key: z
          .string()
          .min(1)
          .optional()
          .describe(
            onDisk
              ? 'Unavailable on this server (media is written to local disk) — pass the file path via `path` instead.'
              : 'An `r2_key` from a previous generation result (media[].r2_key) — re-uploads media THIS connector generated, ' +
                'so a generated image can become a reference image in one cheap call. The server reads its own bucket directly: ' +
                'no HTTP request, no signed URL, and no expiry to worry about. Do NOT pass a /media URL as `url` for this — ' +
                'that would be the connector fetching itself and needs a signature.',
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            onDisk
              ? 'Path to a local file (absolute, or resolved against $GEMINI_INPUT_DIR). Confirm-gated like every other local-file input.'
              : 'Unavailable on this hosted connector (no filesystem) — use `url`, `data_base64`, or POST /upload.',
          ),
        mime_type: z
          .string()
          .regex(/^[\w.+-]+\/[\w.+-]+$/, 'must be a MIME type like image/png')
          .optional()
          .describe('Override the detected MIME type (sniffed from the bytes / taken from the server response otherwise)'),
        display_name: z.string().min(1).optional().describe('Human-readable name recorded against the upload'),
        confirm: schemaConfirm,
      },
    },
    async (args, extra) => {
      const sources = [args.url && 'url', args.data_base64 && 'data_base64', args.r2_key && 'r2_key', args.path && 'path'].filter(Boolean);
      if (sources.length !== 1) {
        throw new McpToolError(
          sources.length === 0
            ? 'Provide exactly one of `url`, `data_base64`' + (onDisk ? ' or `path`.' : ' or `r2_key`.')
            : `Provide exactly one source, not ${sources.length} (${sources.join(', ')}).`,
        );
      }

      if (args.path) {
        if (!onDisk) {
          throw new McpToolError(
            '`path` is unavailable on the hosted connector: it runs on a Cloudflare Worker, which has no filesystem. ' +
              'Use `url` (the server downloads it), `data_base64`, or POST the raw bytes to /upload with the same Authorization header.',
            { hint: 'Use `url`, `data_base64`, or POST /upload.' },
          );
        }
        // Same gate as every other local-file input: a prompt-injected `path`
        // would otherwise ship an arbitrary local file to Google, and an
        // uploaded file is readable by anyone holding the api key for ~48h.
        const gate = await previewLocalInputsUnlessConfirmed(
          args.confirm,
          'Upload a local file to the Gemini Files API',
          '/upload/v1beta/files',
          [args.path],
        );
        if (gate) return gate;
      }

      const uploaded = await withProgressHeartbeat(extra, 'Uploading to the Gemini Files API', async () => {
        if (args.url) {
          const fetched = await client.fetchRemoteImage(args.url, { maxBytes: urlMaxBytes, accept: UPLOAD_ACCEPT });
          return client.uploadBytes(
            fetched.bytes,
            args.mime_type ?? fetched.mimeType,
            // 'upload', matching the data_base64 and path branches below —
            // this tool takes video and audio too, so 'image' would be a lie.
            args.display_name ?? fileNameFromUrl(args.url, 'upload'),
          );
        }
        if (args.r2_key) {
          if (onDisk) {
            throw new McpToolError(
              '`r2_key` is only available on the hosted connector — this server writes media to local disk, ' +
                'so pass the generated file via `path` instead.',
            );
          }
          // Reading our own bucket rather than fetching our own /media URL. A
          // self-fetch would need a signature the caller cannot mint, which is
          // exactly the 403 loop this parameter exists to remove.
          const stored = await client.readStoredMedia(args.r2_key);
          return client.uploadBytes(
            stored.bytes,
            args.mime_type ?? stored.mimeType,
            args.display_name ?? downloadFilename(args.r2_key),
          );
        }
        if (args.data_base64) {
          const { decodeImageInput } = await import('../images.js');
          const decoded = decodeImageInput(args.data_base64);
          const bytes = base64ToBytes(decoded.base64);
          return client.uploadBytes(bytes, args.mime_type ?? decoded.mimeType, args.display_name ?? 'upload');
        }
        const { readImageAsInline, resolveImagePath } = await import('../images.js');
        const resolved = resolveImagePath(args.path!);
        const inline = await readImageAsInline(resolved);
        const bytes = base64ToBytes(inline.base64);
        return client.uploadBytes(
          bytes,
          args.mime_type ?? inline.mimeType,
          args.display_name ?? (resolved.split(/[\\/]/).pop() || 'upload'),
        );
      });

      return uploadResult(uploaded);
    },
  );

  server.registerTool(
    'gemini_list_files',
    {
      description:
        'List files, images and photos currently uploaded to the Gemini Files API under this API key, with their reusable `file_uri` (`files/<id>`) references, ' +
        'MIME types and expiry times. Retention is ~48h, so an entry that has vanished has expired rather than failed.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        page_size: z.number().int().positive().max(100).optional().describe('Maximum files to return (1-100, default 100)'),
      },
    },
    async (args) => {
      const files = await client.listFiles(args.page_size ?? 100);
      return textResult({
        count: files.length,
        files: files.map((f) => ({
          file_uri: f.name,
          uri: f.uri,
          mime_type: f.mimeType,
          ...(f.displayName ? { display_name: f.displayName } : {}),
          ...(f.sizeBytes ? { size_bytes: Number(f.sizeBytes) } : {}),
          ...(f.state ? { state: f.state } : {}),
          ...(f.createTime ? { created: f.createTime } : {}),
          ...(f.expirationTime ? { expires: f.expirationTime } : {}),
        })),
        hint: files.length
          ? `Pass any file_uri above in images_file_uris on an image tool. ${RETENTION_NOTE}`
          : 'No files uploaded (or all have expired — retention is ~48h). Upload one with gemini_upload_file.',
      });
    },
  );

  // Hosted connector only. On a disk-backed server the result carries a path
  // that never expires, so a "refresh my link" tool would only ever error —
  // don't advertise it there (mirrors the Worker not registering video).
  if (!onDisk) {
    server.registerTool(
      'gemini_sign_media',
      {
        description:
          'Mint a FRESH signed URL for media this connector generated, from its `r2_key`. ' +
          'Signed media links expire well before the object behind them is cleaned up, so an expired link is not a dead ' +
          'end — re-sign it instead of re-generating (and re-paying for) the image. Keywords: expired link, refresh url, ' +
          're-sign, media url, download again.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: {
          r2_key: z.string().min(1).describe('The `media[].r2_key` from an earlier generation result'),
        },
      },
      async (args) => {
        const sink = client.mediaSink;
        if (!sink?.resign) {
          throw new McpToolError('This server does not serve media URLs — generated files are written to disk and the path in the result is already usable.', {
            hint: 'gemini_sign_media applies to the hosted connector only.',
          });
        }
        const fresh = await sink.resign(args.r2_key.trim());
        if (!fresh) {
          // Remediation goes in the MESSAGE: MCP serialization drops hints.
          throw new McpToolError(
            `No stored media for r2_key "${args.r2_key}" — it has probably passed its retention window. Re-run the generation to get a new one.`,
            { hint: 'Objects are swept on a retention schedule (MEDIA_TTL_DAYS, default 7 days).' },
          );
        }
        return textResult({
          url: fresh.ref,
          r2_key: fresh.key,
          ...(fresh.expiresAt ? { expires_at: fresh.expiresAt } : {}),
          curl_hint: `curl -sS -o ${downloadFilename(fresh.key ?? 'media')} "${fresh.ref}"`,
          hint: 'In a Claude chat client, download this URL into your sandbox and present it as an output file — inline image blocks and markdown embeds do not render for the end user.',
        });
      },
    );
  }

  server.registerTool(
    'gemini_delete_file',
    {
      description:
        'Delete an uploaded file, image or photo (by file_uri) from the Gemini Files API before its ~48h expiry. Any tool call still referencing it ' +
        'will then fail with a generic 404, so delete only references you are finished with.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        file_uri: z.string().min(1).describe('The `files/<id>` reference (or full uri) to delete'),
        confirm: schemaConfirm,
      },
    },
    async (args) => {
      // Deleting is a remote mutation with no undo — confirm-gated per the
      // fleet convention (unlike writing a generated image, which is local).
      const gate = previewUnlessConfirmed(args.confirm, 'Delete an uploaded Gemini file', 'DELETE', `/v1beta/${args.file_uri}`);
      if (gate) return gate;
      await client.deleteFile(args.file_uri);
      return textResult({ deleted: args.file_uri });
    },
  );
}

