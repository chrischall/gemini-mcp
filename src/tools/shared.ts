import { z } from 'zod';
import { textResult, McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GeminiClient, GeneratedImage, GeneratedMedia, ImageInput } from '../client.js';
import { resolveVideoPath, videoMimeType } from '../images.js';
import { IMAGE_URL_MAX_BYTES, IMAGE_INLINE_MAX_BYTES } from '../fetch-image.js';
import { bytesToBase64, base64ToBytes, wholeMb } from '../bytes.js';
import { createDiskSink, type MediaSink } from '../storage/media.js';
import { downloadFilename } from '../media-name.js';
import { buildZip } from '../zip.js';

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
 * The words people actually use for shape, as a shorthand over
 * {@link ASPECT_RATIOS}.
 *
 * Landscape and portrait output was always *possible* — every generation tool
 * has taken `aspect_ratio` since the beginning. But that parameter is a
 * 14-value enum described as "Output aspect ratio", with nothing linking
 * "portrait" to `9:16`, so a request phrased the way a person phrases it did
 * not reliably reach the API. A capability that cannot be addressed is, from
 * the caller's side, a missing one.
 */
export const ORIENTATIONS = ['landscape', 'portrait', 'square'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/**
 * One mapping, deliberately shared by images and video.
 *
 * `16:9`/`9:16` rather than a photo ratio like `3:2` so that "portrait" means
 * the same shape whatever is being generated — omni offers only these two, and
 * an orientation that silently meant something different per tool would be a
 * worse shorthand than no shorthand. Anyone wanting 35mm or print proportions
 * still names the ratio outright, which always wins (see
 * {@link resolveAspectRatio}).
 */
const ORIENTATION_RATIO: Record<Orientation, string> = {
  landscape: '16:9',
  portrait: '9:16',
  square: '1:1',
};

/**
 * Settle `aspect_ratio` and `orientation` into the one value sent upstream.
 *
 * An explicit ratio wins: it is the more specific request, and a caller who
 * named `21:9` while also saying "landscape" meant `21:9`. `supported` is the
 * calling tool's own enum — the image tools accept all of
 * {@link ASPECT_RATIOS}, omni accepts two — and an orientation outside it is
 * REFUSED rather than rounded to the nearest shape. Quietly substituting
 * `16:9` for an unsupported `square` would hand back a picture the caller
 * never asked for and give them no way to tell it had been swapped.
 */
export function resolveAspectRatio<T extends string>(
  opts: { aspect_ratio?: T; orientation?: Orientation },
  supported: readonly T[],
): T | undefined {
  if (opts.aspect_ratio) return opts.aspect_ratio;
  if (!opts.orientation) return undefined;
  const ratio = ORIENTATION_RATIO[opts.orientation] as T;
  if (!supported.includes(ratio)) {
    // Remediation belongs in the MESSAGE — the host drops `hint`.
    throw new McpToolError(
      `orientation "${opts.orientation}" (${ratio}) is not available for this model, which supports ${supported.join(' and ')}. ` +
        `Ask for ${supported.map((r) => `"${r}"`).join(' or ')} via aspect_ratio, or choose another orientation.`,
      { hint: `Supported aspect ratios: ${supported.join(', ')}.` },
    );
  }
  return ratio;
}

/** The `orientation` parameter, worded so the shorthand is discoverable. */
export const orientationSchema = z
  .enum(ORIENTATIONS)
  .optional()
  .describe(
    'Shape of the output, in plain terms: "landscape" (wide, 16:9), "portrait" (tall, 9:16) or "square" (1:1). ' +
      'Use this for a request phrased as landscape/portrait/vertical/horizontal. For any other proportion — ' +
      '35mm photo (3:2), print (4:3), social (4:5), cinematic (21:9) — name it with aspect_ratio instead, ' +
      'which overrides this when both are given.',
  );

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
    'Run in the background and return a job_id immediately instead of the image, so a long (Pro/4K) generation cannot hit ' +
      'the host tools/call timeout (-32001). Poll gemini_get_result with the job_id to fetch the result. ' +
      'PREFER `max_wait_ms` on the hosted connector: it runs where the executor is only guaranteed to stay alive while the ' +
      'request is open, so this option is served there as a bounded wait rather than an immediate hand-off.',
  );

/**
 * Wait-then-hand-off budget shared by every generation tool: wait up to the
 * budget for the in-band result, and past it return a `{ job_id }` handle
 * (the work continues; the caller polls `gemini_get_result`). The middle
 * ground between fully synchronous and `async: true`.
 */
export const maxWaitMsSchema = z
  .number()
  .int()
  .positive()
  .max(600_000)
  .optional()
  .describe(
    'Wait up to this many ms for the result; if generation is still running when the budget expires, return ' +
      '{ job_id, status: "running" } immediately instead (poll gemini_get_result). Keeps fast results in-band while a ' +
      'slow batch can never trip the host tools/call timeout (-32001) — e.g. 20000 for multi-image sets. Ignored when async is set.',
  );

/**
 * Reference images already in THIS connector's object store, by `r2_key`.
 * Hosted connector only — the server reads its own bucket (tenant-gated), so
 * no bytes enter the conversation and no signed URL is needed.
 */
export function imagesR2KeysSchema(label = 'Reference images'): z.ZodOptional<z.ZodArray<z.ZodString>> {
  return z
    .array(z.string().min(1))
    .optional()
    .describe(
      `${label} by r2_key from THIS connector's store: a signed upload (gemini_get_upload_url → curl PUT) or an earlier ` +
        "generation's media[].r2_key. The server reads its own bucket directly — no bytes in the conversation, no signed URL, " +
        'no ~48h Files API expiry. Hosted connector only.',
    );
}

/** Saved-character names attached to a generation (hosted connector only). */
export const charactersSchema = z
  .array(z.string().min(1))
  .max(8)
  .optional()
  .describe(
    'Names of saved characters (see gemini_list_characters / gemini_save_character): each one\'s reference image and ' +
      'description are attached to the request automatically, keeping recurring subjects consistent without re-sending anything. ' +
      'Hosted connector only.',
  );

/** Saved-style name applied to a generation (hosted connector only). */
export const styleSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Name of a saved style preset (see gemini_list_styles / gemini_save_style): its prompt fragment — and reference image, ' +
      'if it has one — is applied to the request automatically. Hosted connector only.',
  );

/** What {@link resolveCharacterRefs} hands back to a generation handler. */
export interface CharacterRefs {
  /** Character reference images (in name order), then the style reference if any. */
  inputs: ImageInput[];
  /** Prompt preamble naming each attached character. */
  characterLine?: string;
  /** The saved style's prompt fragment, to append to every prompt. */
  styleFragment?: string;
  /** `characters` / `style` echoes for the result meta. */
  meta?: Record<string, unknown>;
}

/**
 * Turn `characters: ["finn", …]` / `style: "…"` into reference-image inputs
 * plus prompt text, from the account's saved library.
 *
 * A name that is not saved fails BEFORE any billable call, and names what IS
 * saved — a generation silently missing its reference is a wasted charge that
 * looks like a model failure.
 */
export async function resolveCharacterRefs(
  client: GeminiClient,
  names: string[] | undefined,
  styleName: string | undefined,
): Promise<CharacterRefs> {
  if (!names?.length && !styleName) return { inputs: [] };
  const library = client.library;
  if (!library) {
    throw new McpToolError(
      '`characters` / `style` reference this account\'s saved library, which exists on the hosted connector only. ' +
        'On this server pass the reference images directly (images / images_url / images_file_uris) and put the style text in the prompt.',
    );
  }
  const inputs: ImageInput[] = [];
  const described: string[] = [];
  // Same size rule as every other funnel: a large reference is promoted to a
  // Files API reference rather than inlined — generateContent caps a whole
  // request near 20MB, and a crew of full-resolution characters would hit it.
  const toInput = async (image: { bytes: Uint8Array; mimeType: string }, displayName: string): Promise<ImageInput> => {
    if (image.bytes.byteLength <= IMAGE_INLINE_MAX_BYTES) {
      return { base64: bytesToBase64(image.bytes), mimeType: image.mimeType };
    }
    const uploaded = await client.uploadBytes(image.bytes, image.mimeType, displayName);
    return { uri: uploaded.uri, mimeType: uploaded.mimeType };
  };
  for (const name of names ?? []) {
    const record = await library.getCharacter(name);
    const image = record && (await library.readCharacterImage(name));
    if (!record || !image) {
      const available = (await library.listCharacters()).map((c) => c.name);
      throw new McpToolError(
        `No saved character "${name}". ` +
          (available.length ? `Saved characters: ${available.join(', ')}. ` : 'None are saved yet. ') +
          'Save one with gemini_save_character.',
      );
    }
    inputs.push(await toInput(image, name));
    described.push(`${record.name} — ${record.description}`);
  }
  let styleFragment: string | undefined;
  let styleImageAttached = false;
  if (styleName) {
    const record = await library.getStyle(styleName);
    if (!record) {
      const available = (await library.listStyles()).map((s) => s.name);
      throw new McpToolError(
        `No saved style "${styleName}". ` +
          (available.length ? `Saved styles: ${available.join(', ')}. ` : 'None are saved yet. ') +
          'Save one with gemini_save_style.',
      );
    }
    styleFragment = record.prompt_fragment;
    if (record.image_key) {
      const image = await library.readStyleImage(styleName);
      if (image) {
        inputs.push(await toInput(image, styleName));
        styleImageAttached = true;
      }
    }
  }
  // The style note is POSITIONAL, never "the final attached image": every
  // caller appends the caller's own reference images (images / images_url /
  // images_file_uris / images_r2_keys) AFTER these inputs, so a "final image"
  // claim would point the model at the caller's last subject photo whenever
  // characters/style are combined with direct references. These inputs always
  // lead the attachment order, so index-based wording stays true regardless
  // of what follows.
  const characterLine = described.length
    ? `Use the attached reference images for these characters, in order: ${described
        .map((d, i) => `(${i + 1}) ${d}`)
        .join('; ')}. Keep each character visually consistent with their reference image.` +
      (styleImageAttached ? ` Attached image (${described.length + 1}) is a style reference, not a character.` : '')
    : styleImageAttached
      ? 'The first attached image is a style reference.'
      : undefined;
  const meta: Record<string, unknown> = {};
  if (names?.length) meta.characters = names;
  if (styleName) meta.style = styleName;
  return { inputs, characterLine, styleFragment, meta: Object.keys(meta).length ? meta : undefined };
}

/** Compose the effective prompt from the caller's text + library lines. */
export function composePrompt(prompt: string, refs: { characterLine?: string; styleFragment?: string }): string {
  return [refs.characterLine, prompt, refs.styleFragment ? `Style: ${refs.styleFragment}` : undefined]
    .filter(Boolean)
    .join('\n\n');
}

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
        `Max ${wholeMb(IMAGE_URL_MAX_BYTES)}MB each; must be a directly-linked image (Content-Type image/*).`,
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
  aspect_ratio: z
    .enum(ASPECT_RATIOS)
    .optional()
    .describe('Exact output aspect ratio. For a plain landscape/portrait/square request, `orientation` is the shorthand; this wins if both are given.'),
  orientation: orientationSchema,
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
  max_wait_ms: maxWaitMsSchema,
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
    // Deliberately NOT `async: true`. This connector runs on a machine that is
    // stopped whenever no request is in flight, so an immediate hand-off is
    // what gets a generation killed mid-flight; holding the request open is
    // what keeps it alive. Recommending async here was recommending the
    // failure mode (see src/job-store.ts).
    return (
      lead +
      `This connector has no filesystem, so a lost response cannot be recovered from disk — there is no output dir and no ` +
      `<image>.json sidecar. Set \`max_wait_ms\` (e.g. 240000): keeping the request open is also what keeps the generation ` +
      `running here, and a batch that outlives the budget hands back a job_id to poll with gemini_get_result. ` +
      `For a faster in-band result use a Flash model or drop image_size to 1K/2K. If a result is ever lost, ` +
      `list what was already generated with gemini_list_recent_media before paying for it again.`
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
  opts: { aspect_ratio?: string; image_size?: string; orientation?: Orientation },
): Record<string, unknown> {
  const meta = reportShape({ model, seed }, opts);
  if (opts.image_size) meta.image_size = opts.image_size;
  return meta;
}

/**
 * Record the shape a generation produced, into any meta object.
 *
 * The RESOLVED ratio, and the `orientation` only when one was actually asked
 * for — so a caller who said "portrait" sees both what they asked and what it
 * became, while a bare `21:9` is not handed back a word nobody used.
 *
 * It lives apart from `buildMeta` because two tools cannot use that function:
 * `gemini_interact` and `gemini_video_generate` build their metas around
 * `interaction_id` and chain state rather than a seed, and so reported no shape
 * at all until #166. Sharing the rule rather than copying it is what keeps
 * those hand-rolled metas from drifting again.
 */
export function reportShape(
  meta: Record<string, unknown>,
  opts: { aspect_ratio?: string; orientation?: Orientation },
): Record<string, unknown> {
  if (opts.aspect_ratio) meta.aspect_ratio = opts.aspect_ratio;
  if (opts.orientation) meta.orientation = opts.orientation;
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
  opts: { inline?: boolean; output_dir?: string; sink?: MediaSink; urlTtlMs?: number },
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
  const persisted = await sink.persist(named.map((n) => ({ base: n.base, base64: n.media.base64, mimeType: n.media.mimeType })), {
    output_dir: opts.output_dir,
    urlTtlMs: opts.urlTtlMs,
  });
  const refs = persisted.map((p) => p.ref);
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
  // Per-item detail (`url` / `r2_key` / `expires_at`) alongside the flat list,
  // so a caller can reason about retention without parsing a URL. Only emitted
  // where there IS extra detail — the disk sink's absolute paths say it all,
  // and adding a parallel array there would change a stable result shape.
  // A stored-but-unaddressable object is a configuration failure, not a mode.
  // Saying so in the result beats handing back a bare key that reads like a
  // filename — the silent-unopenable-ref problem this change exists to end.
  const unavailable = persisted.some((p) => p.unavailable)
    ? {
        media_url_unavailable:
          'The media was stored but no public URL could be generated for it, so the values above are bare object keys, not links. ' +
          'This is a connector misconfiguration: set MEDIA_PUBLIC_BASE_URL, or use inline: true to receive the bytes directly.',
      }
    : {};
  const detailed = persisted.filter((p) => p.key !== undefined);
  const media = detailed.length === persisted.length && detailed.length > 0
    ? {
        media: persisted.map((p) => ({
          url: p.ref,
          ...(p.key ? { r2_key: p.key } : {}),
          ...(p.expiresAt ? { expires_at: p.expiresAt } : {}),
          // A ready-to-run command, not a description of one. Models copy an
          // exact string far more reliably than they compose one — and in a
          // chat client this download-then-attach flow is the ONLY way the end
          // user actually sees the image (inline MCP blocks and markdown embeds
          // both render for the model and not for them).
          ...(p.key ? { curl_hint: `curl -sS -o ${downloadFilename(p.key)} "${p.ref}"` } : {}),
        })),
      }
    : {};
  const storage = sink.persistsFiles ? {} : { storage: sink.kind, storage_note: storageNote };
  return textResult({ [`${kind}s`]: refs, ...media, ...unavailable, ...note, ...storage, ...meta });
}

/**
 * Image convenience wrapper over {@link emitMedia} — preserves the original
 * `emit(named, opts, meta, onWritten)` signature used by the image tools.
 */
export async function emit(
  named: NamedImage[],
  opts: { inline?: boolean; output_dir?: string; sink?: MediaSink; urlTtlMs?: number },
  meta?: Record<string, unknown>,
  onWritten?: (paths: string[]) => void | Promise<void>,
): Promise<CallToolResult> {
  return emitMedia(named.map((n) => ({ media: n.image, base: n.base })), 'image', opts, meta, onWritten);
}

/**
 * Signed-URL lifetime for MULTI-image results (and their bundle zip) on
 * object-storage sinks: ~7 days rather than the default ~48h, clamped by the
 * sink to the retention window. A set is a batch someone comes back to; its
 * links dying in two days while the objects live seven served nobody.
 */
export const SET_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Total DECODED size cap for bundling a set into a zip. Zipping holds roughly
 * 4× the set's bytes at peak (the decoded copies, the STORE zip, and the
 * zip's own base64) on top of the base64 strings the result already carries —
 * and a Cloudflare isolate gets ~128MB, where an OOM kill is uncatchable, so
 * the try/catch in {@link persistBundle} cannot honor its best-effort promise
 * against it. The guard runs on sizes ESTIMATED from base64 length, before a
 * single byte is decoded.
 */
export const BUNDLE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * Bundle a multi-image result into ONE downloadable zip and return the meta
 * fields to merge into the result (`bundle_url` + a detailed `bundle` object).
 *
 * Object-storage sinks only, and only when there is more than one image — the
 * point is turning N downloads into one `curl`, which a single image already
 * is. Best-effort: a result that cost N billable generations must never fail
 * because zipping or storing the bundle did — but a skipped bundle is SAID
 * (`bundle_skipped`), never silently absent, so the caller falls back to the
 * per-image URLs instead of hunting for a field that will never appear.
 */
export async function persistBundle(
  named: NamedImage[],
  sink: MediaSink | undefined,
  base: string,
): Promise<Record<string, unknown>> {
  if (!sink || sink.persistsFiles || named.length < 2) return {};
  const totalBytes = named.reduce((sum, n) => sum + Math.floor((n.image.base64.length * 3) / 4), 0);
  if (totalBytes > BUNDLE_MAX_TOTAL_BYTES) {
    return {
      bundle_skipped:
        `The set totals ~${wholeMb(totalBytes)}MB decoded, over the ${wholeMb(BUNDLE_MAX_TOTAL_BYTES)}MB bundling cap ` +
        '(zipping peaks at ~4x that in Worker memory). Download the images individually via their media urls / curl_hints.',
    };
  }
  try {
    const { mediaExt } = await import('../images.js');
    const zip = buildZip(named.map((n) => ({ name: `${n.base}.${mediaExt(n.image.mimeType)}`, bytes: base64ToBytes(n.image.base64) })));
    const [persisted] = await sink.persist(
      [{ base: `${base}-bundle`, base64: bytesToBase64(zip), mimeType: 'application/zip' }],
      { urlTtlMs: SET_URL_TTL_MS },
    );
    if (!persisted || persisted.unavailable) {
      return { bundle_skipped: 'The bundle zip could not be stored; the images themselves are unaffected — download them individually via their media urls / curl_hints.' };
    }
    return {
      bundle_url: persisted.ref,
      bundle: {
        url: persisted.ref,
        ...(persisted.key ? { r2_key: persisted.key } : {}),
        ...(persisted.expiresAt ? { expires_at: persisted.expiresAt } : {}),
        files: named.map((n) => n.base),
        ...(persisted.key ? { curl_hint: `curl -sS -o ${downloadFilename(persisted.key)} "${persisted.ref}"` } : {}),
      },
    };
  } catch {
    return { bundle_skipped: 'Bundling failed; the images themselves are unaffected — download them individually via their media urls / curl_hints.' };
  }
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
