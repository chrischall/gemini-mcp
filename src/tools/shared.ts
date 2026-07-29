import { z } from 'zod';
import { textResult, McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GeminiClient, GeneratedImage, GeneratedMedia } from '../client.js';
import { resolveVideoPath, videoMimeType } from '../images.js';
import { IMAGE_URL_MAX_BYTES } from '../fetch-image.js';
import { createDiskSink, type MediaSink } from '../storage/media.js';

/**
 * Fallback sink for call sites that pass no explicit one (every pre-existing
 * test, and any caller constructed before the sink seam existed). The stdio
 * server's behaviour is therefore unchanged by omission, not by convention.
 */
const DEFAULT_SINK = createDiskSink();

/** Supported output aspect ratios (Gemini image API). */
export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
/** Supported output resolutions. `512` is Flash-only (0.5K); `1K`/`2K`/`4K` work on all image models. */
export const IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;

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

/**
 * Per-call upstream timeout override, shared by every generation tool
 * (spread via {@link sharedImageSchema}; `gemini_interact` imports it directly
 * since its schema doesn't take the seed/clipboard fields).
 */
export const timeoutMsSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Upstream request timeout in ms for this call (default: $GEMINI_TIMEOUT_MS, else 60000 — or 120000 when image_size is 4K, which routinely runs past 60s)',
  );

/**
 * Idempotency key shared by every generation tool. A repeat call carrying the
 * same key returns the recorded result (`reused: true`) instead of billing a
 * fresh generation — the fix for a host timeout (`-32001`) prompting a blind
 * re-issue of a call the server actually completed.
 */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Opaque idempotency key: a repeat call with the same key returns the recorded result (reused: true) instead of billing a new generation. Set it when retrying after a host timeout (-32001) to avoid a duplicate charge.',
  );

/**
 * Async escape hatch shared by every generation tool: return a `job_id`
 * immediately so a long (Pro/4K) generation can't hit a host's fixed tools/call
 * timeout (`-32001`). The caller polls `gemini_get_result`.
 */
export const asyncSchema = z
  .boolean()
  .optional()
  .describe(
    'Run in the background and return a job_id immediately instead of the image, so a long (Pro/4K) generation cannot hit the host tools/call timeout (-32001). Poll gemini_get_result with the job_id to fetch the result (jobs are per-process and expire ~10 min after completion).',
  );

/**
 * Reference images the SERVER fetches, so the bytes never pass through the
 * model's context window. Defined once and reused under both the `images_url`
 * and `master_images_url` names.
 */
export function imagesUrlSchema(label = 'Reference images'): z.ZodOptional<z.ZodArray<z.ZodString>> {
  return z
    .array(z.string().url())
    .optional()
    .describe(
      `${label} as public https URLs — the SERVER downloads them, so no image bytes travel through the conversation. ` +
        'Preferred over images_base64, which costs ~14k tokens per photo and breaks if a file read was truncated. ' +
        `Max ${Math.round(IMAGE_URL_MAX_BYTES / (1024 * 1024))}MB each; must be a directly-linked image (Content-Type image/*).`,
    );
}

/**
 * Reference images already in the Gemini Files API. The cheapest form there is:
 * a short string, reusable across calls until the file expires.
 */
export function imagesFileUrisSchema(label = 'Reference images'): z.ZodOptional<z.ZodArray<z.ZodString>> {
  return z
    .array(z.string().min(1))
    .optional()
    .describe(
      `${label} by Gemini Files API reference ("files/<id>", or the full uri) from gemini_upload_file or POST /upload. ` +
        'Upload once, then reference it across as many calls as you like — no bytes are re-sent and none enter the conversation. ' +
        'Files are retained ~48h, after which the reference stops resolving.',
    );
}

/**
 * The model/aspect/size/output fields every generation tool shares. Defined once
 * here so descriptions can't drift between `generate.ts` and `set.ts`. Spread
 * into each tool's `inputSchema`.
 */
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
  timeout_ms: timeoutMsSchema,
  idempotency_key: idempotencyKeySchema,
  async: asyncSchema,
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
export async function resolveVideoInput(args: { video_url?: string; video_path?: string }, client: GeminiClient): Promise<VideoInput> {
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

// Progress-heartbeat cadence while a generation is in flight. MCP hosts
// enforce their own tools/call timeout (surfaced as -32001) but reset it on
// notifications/progress, so a heartbeat lets a 4K/Pro generation outlive the
// host's default budget. Tunable via $GEMINI_HEARTBEAT_MS (0 disables).
const HEARTBEAT_DEFAULT_MS = 10_000;

/**
 * The slice of the SDK's `RequestHandlerExtra` the heartbeat needs — kept
 * structural so tests can pass a plain object.
 */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * Run `fn`, emitting a `notifications/progress` heartbeat while it is pending —
 * but only when the caller asked for progress (sent a `progressToken`).
 * Send failures are swallowed (the client may have abandoned the request);
 * `fn`'s result/rejection passes through untouched.
 */
export async function withProgressHeartbeat<T>(
  extra: ProgressExtra | undefined,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const progressToken = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  const env = Number(readEnvVar('GEMINI_HEARTBEAT_MS'));
  const intervalMs = Number.isFinite(env) ? env : HEARTBEAT_DEFAULT_MS;
  const debug = !!readEnvVar('GEMINI_DEBUG');
  const active = progressToken !== undefined && !!send && intervalMs > 0;
  // Diagnostics (opt-in via GEMINI_DEBUG). Goes to stderr — the only channel
  // safe under the stdio transport, and where the host surfaces it (Claude
  // Desktop: ~/Library/Logs/Claude/mcp-server-*.log). The active/inactive line
  // reveals whether the host even asked for progress: a missing progressToken
  // means the host cannot be kept alive by our heartbeat, so a long call will
  // hit the host's own tools/call timeout no matter what we send.
  if (debug) {
    if (active) {
      console.error(`[gemini-mcp] heartbeat active: progressToken present, interval=${intervalMs}ms — ${message}`);
    } else {
      const reason = progressToken === undefined
        ? 'no progressToken from host (host cannot extend its tools/call timeout; long calls will hit it)'
        : !send
          ? 'host provided no sendNotification channel'
          : 'heartbeat disabled (GEMINI_HEARTBEAT_MS=0)';
      console.error(`[gemini-mcp] heartbeat inactive: ${reason} — ${message}`);
    }
  }
  if (progressToken === undefined || !send || intervalMs <= 0) return fn();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const elapsed = Math.round((ticks * intervalMs) / 1000);
    if (debug) console.error(`[gemini-mcp] heartbeat: ${message} — still working (${elapsed}s)`);
    void send({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: ticks,
        message: `${message} — still working (${elapsed}s)`,
      },
    }).catch(() => {});
  }, intervalMs);
  // Never hold the process open just for a heartbeat.
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Some configs routinely run long enough to trip a host's tools/call timeout —
 * Pro models, 4K output, or multi-image counts. Claude Desktop caps at ~30s,
 * ignores our progress heartbeat, and offers no config to raise it (verified: the
 * bundled MCP client's hard limit does not reset on notifications/progress), so
 * such a call surfaces as `-32001 Request timed out`. Returned as
 * `meta.timeout_risk` so a caller that *does* get the result is steered off the
 * slow path next time and knows the image still landed on disk when a host bails.
 * `undefined` for fast configs (no field added).
 *
 * `persistsFiles: false` (the hosted connector) swaps the disk-recovery half of
 * the advice for the async job handle — pointing a Worker's caller at "look in
 * the output dir" would be advice about a filesystem that does not exist.
 */
export function timeoutRiskHint(opts: { model: string; imageSize?: string; count?: number; persistsFiles?: boolean }): string | undefined {
  // Delimiter-anchored so real Pro ids (gemini-3-pro-image, nano-banana-pro)
  // match but incidental substrings (…-prototype-…, …-flash-proxy) don't.
  const proModel = /(?:^|[-_./])pro(?:[-_./]|$)/i.test(opts.model);
  const fourK = opts.imageSize === '4K';
  const multi = (opts.count ?? 1) > 1;
  if (!proModel && !fourK && !multi) return undefined;
  const why = [proModel && 'Pro model', fourK && '4K output', multi && `count=${opts.count}`]
    .filter(Boolean)
    .join(' + ');
  const lead = `Slow config (${why}) can exceed a host's tools/call timeout (e.g. Claude Desktop ~30s, error -32001). `;
  if (opts.persistsFiles === false) {
    return (
      lead +
      `This connector has no filesystem, so a lost response cannot be recovered from disk — there is no output dir and no ` +
      `<image>.json sidecar. Use \`async: true\` to get a job_id immediately and poll gemini_get_result, ` +
      `or use a Flash model / drop image_size to 1K/2K for a faster in-band result.`
    );
  }
  return (
    lead +
    `If the host gives up mid-generation the image is still written to disk (and gemini_interact leaves an ` +
    `<image>.json sidecar with the interaction id) — no rerun needed, just look in the output dir. ` +
    `For a faster in-band result use a Flash model, drop image_size to 1K/2K, or — in Claude Code — set MCP_TOOL_TIMEOUT.`
  );
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

/** A generated media item (image/video/audio) plus its base filename. */
export interface NamedMedia { media: GeneratedMedia; base: string; }

/**
 * Return generated media inline (base64 content blocks) or write to disk and
 * return the paths. `kind` selects the MCP inline block type: `image`/`audio`
 * are native MCP content types; **`video` has no inline block type, so it is
 * always written to disk** (an `inline` request is downgraded and noted in the
 * result). Disk mode returns `{ <kind>s: [paths], ...meta }`. `onWritten`
 * receives the written paths (disk mode only), awaited before returning.
 */
export async function emitMedia(
  named: NamedMedia[],
  kind: 'image' | 'video' | 'audio',
  opts: { inline?: boolean; output_dir?: string; sink?: MediaSink },
  meta?: Record<string, unknown>,
  onWritten?: (paths: string[]) => void | Promise<void>,
): Promise<CallToolResult> {
  const inline = opts.inline && kind !== 'video';
  if (inline) {
    const blocks = named.map((n) => ({ type: kind as 'image' | 'audio', data: n.media.base64, mimeType: n.media.mimeType }));
    if (meta && Object.keys(meta).length > 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }, ...blocks] };
    }
    return { content: blocks };
  }
  const sink = opts.sink ?? DEFAULT_SINK;
  const refs = await sink.persist(named.map((n) => ({ base: n.base, base64: n.media.base64, mimeType: n.media.mimeType })), {
    output_dir: opts.output_dir,
  });
  // `onWritten` (sidecars, the written-outputs set) is meaningful only when the
  // refs are real files. On a sink with no filesystem there is nothing to sit
  // next to, so it is skipped rather than handed URLs it would misinterpret.
  if (sink.persistsFiles) await onWritten?.(refs);
  // Note a downgraded inline-video request so the caller isn't left wondering.
  const note = opts.inline && kind === 'video' ? { inline_unsupported: 'video has no MCP inline content type — written to disk instead' } : {};
  // Say where the bytes actually went whenever they are NOT local paths — the
  // key is the same (`images`/`videos`/`audios`), so without this a caller would
  // reasonably read a URL as a file path.
  const storageNote = sink.note();
  const storage = sink.persistsFiles ? {} : { storage: sink.kind, storage_note: storageNote };
  return textResult({ [`${kind}s`]: refs, ...note, ...storage, ...meta });
}

/**
 * Image convenience wrapper over {@link emitMedia} — preserves the original
 * `emit(named, opts, meta, onWritten)` signature used by the image tools.
 */
export async function emit(
  named: NamedImage[],
  opts: { inline?: boolean; output_dir?: string; sink?: MediaSink },
  meta?: Record<string, unknown>,
  onWritten?: (paths: string[]) => void | Promise<void>,
): Promise<CallToolResult> {
  return emitMedia(named.map((n) => ({ media: n.image, base: n.base })), 'image', opts, meta, onWritten);
}

/**
 * Inputs that can only come off a local filesystem. On the hosted connector
 * (a Cloudflare Worker) none of them exist:
 *
 *  - `images` / `master_images` — file paths read with `node:fs`.
 *  - `from_clipboard` — shells out to `osascript`/`sips` via `child_process`.
 *  - `video_path` — the Files API upload streams the file off disk.
 *
 * Called at the top of every generation handler, BEFORE any billable upstream
 * call, so a caller gets a clear alternative instead of an obscure
 * module-resolution or ENOENT crash. A no-op on the disk sink, so the stdio
 * behaviour (including its own "Image not found" errors) is untouched.
 *
 * The remediation deliberately does NOT lead with `images_base64` any more.
 * Inlining a photo as a tool argument costs ~14k tokens of the model's context
 * and silently corrupts whenever the read that produced it was truncated — so
 * it is named last, after the three routes that move bytes without the model
 * ever seeing them.
 */
export function assertLocalInputsAvailable(
  sink: MediaSink | undefined,
  args: { images?: string[]; master_images?: string[]; from_clipboard?: boolean; video_path?: string },
): void {
  if ((sink ?? DEFAULT_SINK).persistsFiles) return;
  const unavailable: string[] = [];
  if (args.images?.length) unavailable.push('`images` (local file paths)');
  if (args.master_images?.length) unavailable.push('`master_images` (local file paths)');
  if (args.from_clipboard) unavailable.push('`from_clipboard` (reads the macOS clipboard via child_process)');
  if (args.video_path) unavailable.push('`video_path` (uploads a file streamed from disk)');
  if (unavailable.length === 0) return;
  // Remediation goes in the MESSAGE, not just `hint`: MCP error serialization
  // surfaces the message and drops the hint, so hint-only advice is invisible
  // exactly when it is needed.
  const fix =
    'Reference images WITHOUT putting bytes in the conversation, in order of preference: ' +
    '(1) `images_url` — public https URLs the server fetches itself; ' +
    '(2) `images_file_uris` — upload once with `gemini_upload_file` (it takes a `url` or `data_base64`) and reuse the returned files/… uri; ' +
    '(3) `POST /upload` on this connector with the raw bytes as the body ' +
    "(`curl -X POST <connector-url>/upload -H 'Authorization: Bearer <token>' -H 'Content-Type: image/jpeg' --data-binary @photo.jpg`), " +
    'then pass the returned file_uri. ' +
    'As a last resort `images_base64` still works, but it costs ~14k tokens per photo and breaks on a truncated read. ' +
    'Reference video by `video_url` (a public YouTube URL, or a files/… uri uploaded elsewhere) instead of `video_path`.';
  throw new McpToolError(
    `${unavailable.join(', ')} ${unavailable.length > 1 ? 'are' : 'is'} unavailable on the hosted connector: ` +
      `it runs on a Cloudflare Worker, which has no filesystem and no local clipboard. ${fix}`,
    { hint: fix },
  );
}
