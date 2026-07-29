import { basename } from 'node:path';
import { readEnvVar, McpToolError, ApiError, createApiClient, formatApiError, fileBlob, type ApiClient } from '@chrischall/mcp-utils';
import { resolveModel, filterImageModels, DEFAULT_VIDEO_MODEL, DEFAULT_MUSIC_MODEL, type GeminiModel, type RawModel } from './models.js';
import { createDiskSink, type MediaSink } from './storage/media.js';
import { SessionState } from './session.js';
import { fetchRemoteImage, type FetchedImage } from './fetch-image.js';

// NOTE: this module must stay SIDE-EFFECT-FREE at module scope — no I/O, no
// top-level await, no `import.meta.url`. `src/worker.ts` imports it, so every
// line here runs during Cloudflare isolate startup, where global-scope I/O is
// forbidden and wrangler's bundle leaves `import.meta.url` undefined. The
// stdio `.env` bootstrap that used to live here now lives in `src/dotenv.ts`,
// imported only by `src/index.ts`. Guarded by tests/connector-boot.test.ts.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'; // v1 lacks gemini-3-pro-image; confirmed via Task 5
const SERVICE = 'Gemini';
const INTERACTIONS_SERVICE = 'Gemini Interactions';
// Per-request abort budget. Image generation routinely runs 30s+ on the Pro
// model, so this is deliberately 60s (NOT the fleet's usual 15–30s) — and 4K
// output routinely runs past 60s, hence the doubled 4K default. Both are
// overridable: per-call `timeout_ms` beats $GEMINI_TIMEOUT_MS beats these.
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_4K_MS = 120_000;

/**
 * Effective upstream timeout for one request:
 * per-call `timeout_ms` → `$GEMINI_TIMEOUT_MS` → 120s for 4K output → 60s.
 * Resolved at request time so an env change doesn't require a new process.
 */
export function resolveTimeoutMs(perCallMs?: number, imageSize?: string): number {
  if (perCallMs !== undefined && perCallMs > 0) return perCallMs;
  const env = Number(readEnvVar('GEMINI_TIMEOUT_MS'));
  if (Number.isFinite(env) && env > 0) return env;
  return imageSize === '4K' ? REQUEST_TIMEOUT_4K_MS : REQUEST_TIMEOUT_MS;
}

// Files API (local-video upload — docs/GEMINI-API.md "Files API — local video
// upload", verified 2026-06-12). The resumable upload endpoint lives under
// `/upload/v1beta`, NOT the normal `/v1beta` base.
const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';
// Documented Files API per-file cap (2 GB); enforced locally so a too-big video
// fails fast instead of uploading gigabytes just to be rejected.
const FILE_MAX_BYTES = 2 * 1024 ** 3;
// PROCESSING→ACTIVE poll: every 2s for up to 5 minutes. A 2s clip went ACTIVE
// in ~1s (verified); longer videos take proportionally longer to process.
const FILE_POLL_INTERVAL_MS = 2_000;
const FILE_POLL_MAX_ATTEMPTS = 150;

// The interactions store is eventually consistent: a freshly returned id can
// 404 while the SAME id + key resolves fine *minutes* later (observed live
// 2026-07-06, verified against a real failing id created moments before the
// failure — docs/GEMINI-API.md). The lag is intermittent and load-dependent, so
// a heavy turn (4K / Pro / thinking:high) is the likeliest to hit it — which is
// exactly the turn a caller most wants to chain from.
//
// This budget used to be two fixed retries (~6s total) against a lag the repo's
// own notes measured in minutes, so every rapid iteration surfaced as an expired
// chain. Match the budget to the observed lag instead: exponential backoff
// (capped per-sleep) until the budget is spent. A 404'd chained call generates
// nothing and is not billed, so waiting costs only time — and under `async: true`
// nothing is even blocking on it.
const CHAIN_404_RETRY_BUDGET_MS = 120_000;
const CHAIN_404_RETRY_BASE_MS = 2_000;
const CHAIN_404_RETRY_MAX_SLEEP_MS = 30_000;

/** Retry budget for a chained 404: `$GEMINI_CHAIN_RETRY_MS` → 120s. */
export function resolveChainRetryBudgetMs(): number {
  const env = Number(readEnvVar('GEMINI_CHAIN_RETRY_MS'));
  return Number.isFinite(env) && env >= 0 ? env : CHAIN_404_RETRY_BUDGET_MS;
}

/**
 * A request carrying `previous_interaction_id` returned HTTP 404, after the
 * store-lag retries were exhausted.
 *
 * Deliberately NOT named "chain expired": the only 404 body observed live is
 * generic ("Requested entity was not found.") and never says *which* entity was
 * missing. An unknown/renamed model id and an expired Files API `files/…` uri
 * (~48h TTL) produce the same status and the same generic text, so a 404 on a
 * chained request is evidence of *a* missing entity, not proof it was the
 * interaction. Asserting otherwise fabricates a cause and hides the real one —
 * which is why the upstream text is carried in the message rather than replaced.
 *
 * Its own type (rather than a message to regex) so `tools/interact.ts` can key
 * its sidecar re-anchor off it; that re-issue doubles as the probe that tells
 * the cases apart (see `chain_recovered` / `chain_not_the_cause` there).
 */
export class ChainedRequest404Error extends McpToolError {
  constructor(
    readonly previousInteractionId: string,
    /** The upstream error text, verbatim (already redacted + truncated). */
    readonly upstreamMessage: string,
    /** How hard we waited out the store lag before giving up. */
    readonly retries: { attempts: number; waitedMs: number },
    opts: { hint: string; cause?: unknown },
  ) {
    super(
      `Gemini returned HTTP 404 for a chained request (previous_interaction_id: "${previousInteractionId}"), retried ${retries.attempts}× over ~${Math.round(retries.waitedMs / 1000)}s for store lag. Upstream said: ${upstreamMessage}. ` +
        'This does not necessarily mean the interaction expired — an unknown model id or an expired files/… uri returns the same generic 404. ' +
        '(For reference: interactions are retained 55 days on the paid tier, 1 day on the free tier, and are scoped to the API key that created them.)',
      opts,
    );
  }
}

export interface GeneratedImage { base64: string; mimeType: string; }

/**
 * ONE reference image, however it reached us.
 *
 * Every input form the tools accept — a local path (stdio), raw base64 / a
 * `data:` URI, an `https://` URL the *server* fetches, or a Files API
 * `files/…` uri — is normalized to this before it touches the Gemini API (see
 * `src/inputs.ts`). Exactly one carrier is set:
 *
 *  - `base64` → an inline part (`inline_data` / `{type:'image', data}`).
 *  - `uri`    → a by-reference part (`file_data` / `{type:'image', uri}`),
 *               costing no request bytes and reusable until the file expires
 *               (~48h).
 *
 * `base64` stays optional-but-usually-present rather than a discriminated
 * union so the pre-existing `{ base64, mimeType }` call sites (and their tests)
 * remain valid values of this type.
 */
export interface ImageInput {
  /** Inline bytes. Ignored when `uri` is set. */
  base64?: string;
  /** Files API uri (`https://…/v1beta/files/<id>` or a bare `files/<id>`). */
  uri?: string;
  mimeType: string;
}

/** `generateContent` part for one reference image (by uri, else inline). */
function generatePart(img: ImageInput): Record<string, unknown> {
  return img.uri
    ? { file_data: { file_uri: img.uri, mime_type: img.mimeType } }
    : { inline_data: { mime_type: img.mimeType, data: img.base64 } };
}

/** Interactions `input` part for one reference image (by uri, else inline). */
function interactPart(img: ImageInput): Record<string, unknown> {
  return img.uri
    ? { type: 'image', uri: img.uri, mime_type: img.mimeType }
    : { type: 'image', mime_type: img.mimeType, data: img.base64 };
}

/** A single grounding source. Both fields optional — defensive against a beta
 * API omitting one (the doc shows `{uri, title}` always present). */
export interface GroundingSource { uri?: string; title?: string }
export interface GroundingResult {
  queries?: string[];
  sources?: GroundingSource[];
  /**
   * HTML "search suggestion" chips from `google_search_result` steps
   * (Interactions API). Populated only when `image_search` grounding was
   * requested — Google's ToS require displaying them in that case.
   */
  search_suggestions?: string[];
}

/** Grounding search types the Interactions API accepts on the google_search tool. */
export type SearchType = 'web_search' | 'image_search';
/** Raw `candidates[].groundingMetadata` shape we read from. */
interface GroundingChunk { web?: GroundingSource }
interface GroundingMeta { webSearchQueries?: string[]; groundingChunks?: GroundingChunk[] }

export interface GenerateResult { images: GeneratedImage[]; text?: string; grounding?: GroundingResult; }

export interface InteractOpts {
  input: string;
  images?: ImageInput[];
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  thinkingLevel?: 'minimal' | 'high';
  previousInteractionId?: string;
  googleSearch?: boolean;
  /** Grounding search types; setting this implies google_search grounding. */
  searchTypes?: SearchType[];
  videoUrl?: string;
  /** MIME type for the video reference (default `video/mp4` — the YouTube path). */
  videoMimeType?: string;
  /** Per-call upstream timeout override; see {@link resolveTimeoutMs}. */
  timeoutMs?: number;
}

/** A file uploaded to the Gemini Files API, ready to reference by `uri`. */
export interface UploadedFile {
  /** Resource name, `files/<id>`. */
  name: string;
  /** Full URI to pass as the generate `file_uri` / interact `uri`. */
  uri: string;
  mimeType: string;
  /** When the file is deleted server-side (~48h after upload). */
  expirationTime?: string;
  /** Bytes stored, as reported by the API (a STRING in the wire format). */
  sizeBytes?: string;
  displayName?: string;
}

/** Historical alias — video was the first thing this server uploaded. */
export type UploadedVideo = UploadedFile;

/**
 * Reduce any accepted spelling of a Files API reference to the bare resource
 * name `files/<id>`.
 *
 * Callers hand these back and forth all day — a result echoes the full
 * `https://…/v1beta/files/<id>` uri, docs and error messages say `files/<id>` —
 * so both must work. The name is interpolated into a URL path, which is why the
 * shape is asserted rather than assumed (same posture as the model-id guard).
 */
export function normalizeFileName(ref: string): string {
  const trimmed = ref.trim();
  const match = /(?:^|\/)(files\/[\w-]+)\/?$/.exec(trimmed);
  if (!match) {
    throw new McpToolError(`Not a Gemini Files API reference: "${ref}"`, {
      hint: 'Pass the `files/<id>` name (or the full https://…/v1beta/files/<id> uri) returned by gemini_upload_file / POST /upload.',
    });
  }
  return match[1];
}

/** One entry from `GET /v1beta/files`. */
export interface ListedFile extends UploadedFile {
  state?: string;
  createTime?: string;
}

/** Raw File resource (finalize wraps it in `{file:}`; the GET poll does not). */
interface GeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  expirationTime?: string;
  createTime?: string;
  sizeBytes?: string;
  displayName?: string;
  error?: { message?: string };
}

export interface InteractResult { id: string; images: GeneratedImage[]; text?: string; grounding?: GroundingResult; }

/** Inline media returned by the Interactions API (image / video / audio) — all
 * just base64 bytes + MIME. Structurally identical to {@link GeneratedImage}. */
export interface GeneratedMedia { base64: string; mimeType: string; }

/** A `steps[]` entry from the Interactions API (shared by interact/video/music). */
interface StepPart { type: string; mime_type?: string; mimeType?: string; data?: string; text?: string; uri?: string }
interface Step {
  type: string;
  content?: StepPart[];
  summary?: StepPart[];
  // `arguments` is null on some google_search_call steps (verified 2026-07-06).
  arguments?: { queries?: string[] } | null;
  result?: Array<{ search_suggestions?: string }>;
}
/** Everything the `model_output` (+ grounding) steps yield, by media type. */
interface ExtractedInteraction {
  images: GeneratedMedia[];
  videos: GeneratedMedia[];
  audios: GeneratedMedia[];
  text?: string;
  grounding?: GroundingResult;
}

export interface VideoOpts {
  input: string;
  /** Reference stills for image_to_video / reference_to_video. */
  images?: ImageInput[];
  model?: string;
  aspectRatio?: '9:16' | '16:9';
  task?: 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'edit';
  previousInteractionId?: string;
  timeoutMs?: number;
}
export interface VideoResult { id: string; videos: GeneratedMedia[]; text?: string; }

export interface MusicOpts {
  input: string;
  images?: ImageInput[];
  model?: string;
  /** `wav` is Lyria-3-Pro-only; the client sends it through, the tool validates. */
  audioFormat?: 'mp3' | 'wav';
  previousInteractionId?: string;
  timeoutMs?: number;
}
export interface MusicResult { id: string; audios: GeneratedMedia[]; text?: string; }

export interface GenerateOpts {
  prompt: string;
  images?: ImageInput[];
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  seed?: number;
  thinkingLevel?: 'minimal' | 'high';
  googleSearch?: boolean;
  videoUrl?: string;
  /** MIME type for the video reference (default `video/mp4` — the YouTube path). */
  videoMimeType?: string;
  /** Per-call upstream timeout override; see {@link resolveTimeoutMs}. */
  timeoutMs?: number;
}

export interface GeminiClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Explicit API key, for runtimes that have no ambient env — notably the
   * hosted connector, which builds one client PER AUTHENTICATED USER from the
   * key that user supplied at OAuth time. Omitted (the stdio path) it falls
   * back to `$GEMINI_API_KEY` exactly as before.
   */
  apiKey?: string;
  /**
   * Where generated media is persisted. Defaults to the disk sink, so the stdio
   * server behaves identically to before this seam existed; the Worker passes
   * an R2-backed sink because it has no filesystem.
   */
  mediaSink?: MediaSink;
}

export class GeminiClient {
  /**
   * A key handed in explicitly (the connector's per-session key). When absent
   * the key is read from the environment at REQUEST time, not here — see
   * `requireKey`.
   */
  private readonly explicitApiKey: string | undefined;
  private readonly apis = new Map<number, { api: ApiClient; interactionsApi: ApiClient }>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * The media destination for every tool this client is handed to. Public and
   * readonly: `tools/*` read `client.mediaSink` to decide disk-vs-URL output
   * AND whether disk-only *inputs* (local paths, clipboard, video upload) are
   * even available on this runtime.
   */
  readonly mediaSink: MediaSink;

  /**
   * This client's session memory — job registry, last-interaction id, written
   * outputs. One client is one session: the hosted connector builds a client
   * per authenticated user, so hanging the state here is what keeps it from
   * leaking between tenants sharing an isolate (see src/session.ts). The stdio
   * server is single-user, so its one singleton client is one session.
   */
  readonly session = new SessionState();

  constructor(opts: GeminiClientOptions = {}) {
    this.mediaSink = opts.mediaSink ?? createDiskSink();
    this.explicitApiKey = opts.apiKey?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * The `createApiClient` pair for one timeout budget, built lazily and
   * memoized per distinct timeout (a handful of values in practice). Both
   * share: the key in the `x-goog-api-key` header (Gemini does not use
   * `Authorization: Bearer`) and the default 429 retry (once after 2s — the
   * free tier rate-limits aggressively). `getToken` calls requireKey() so key
   * resolution stays at REQUEST time: the server boots without a key and the
   * actionable config error (with its aistudio hint) surfaces on the first
   * tool call, not at startup.
   */
  private apisFor(timeoutMs: number): { api: ApiClient; interactionsApi: ApiClient } {
    let entry = this.apis.get(timeoutMs);
    if (!entry) {
      const shared = {
        tokenHeader: 'x-goog-api-key',
        getToken: () => this.requireKey(),
        timeout: timeoutMs,
        fetchImpl: this.fetchImpl,
      };
      entry = {
        api: createApiClient({ baseUrl: BASE_URL, serviceName: SERVICE, ...shared }),
        // Separate client for the Interactions API so errors name the right API.
        // The beta-era Api-Revision header is gone: the API went GA and requests
        // succeed without it (verified live 2026-07-06; see docs/GEMINI-API.md).
        // Don't re-add a pinned revision — it would freeze us on old semantics.
        interactionsApi: createApiClient({ baseUrl: BASE_URL, serviceName: INTERACTIONS_SERVICE, ...shared }),
      };
      this.apis.set(timeoutMs, entry);
    }
    return entry;
  }

  /**
   * The API key for this request: an explicitly-injected key (the connector's
   * per-session key) else `$GEMINI_API_KEY`.
   *
   * Resolved HERE, at request time, not in the constructor — same as every
   * other env var this client reads. Two reasons:
   *
   * 1. It keeps the actionable config error deferred to the first tool call, so
   *    the server still boots and answers a host's install-time `tools/list`
   *    probe without a key. (That was already true; this preserves it.)
   * 2. It makes module-evaluation order irrelevant. `src/index.ts` loads `.env`
   *    before serving, and reading the key in the constructor meant the
   *    `client` singleton — constructed when `client.js` is first evaluated —
   *    could latch "unset" before dotenv ran, depending on import ordering.
   *    That is an invisible, silent failure (the key just stops working); not
   *    depending on the order removes the hazard instead of documenting it.
   */
  private requireKey(): string {
    const key = this.explicitApiKey || readEnvVar('GEMINI_API_KEY');
    if (!key) {
      throw new McpToolError('GEMINI_API_KEY environment variable is required', {
        hint: 'Create a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY in your MCP host env or .env',
      });
    }
    return key;
  }

  /**
   * Fetch one `images_url` reference server-side. Routed through the client so
   * it uses the SAME injected `fetchImpl` as every upstream call — which is
   * what makes it mockable in tests and correct on the Worker.
   */
  async fetchRemoteImage(url: string, opts: { maxBytes?: number; accept?: string[]; timeoutMs?: number } = {}): Promise<FetchedImage> {
    // Same timeout resolution as every other upstream call (per-call
    // `timeout_ms` → $GEMINI_TIMEOUT_MS → 60s), so a URL fetch cannot be the
    // one unbounded network operation in the server.
    return fetchRemoteImage(url, { ...opts, fetchImpl: this.fetchImpl, timeoutMs: resolveTimeoutMs(opts.timeoutMs) });
  }

  /** The default model after env override (no per-call arg). */
  defaultModel(): string {
    return resolveModel(undefined, readEnvVar('GEMINI_IMAGE_MODEL'));
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const { api } = this.apisFor(timeoutMs ?? resolveTimeoutMs());
    return api.fetchJson<T>(method, path, body !== undefined ? { body } : {});
  }

  /**
   * Upload a local video to the Gemini Files API (resumable protocol) and wait
   * for it to become usable. Three live-verified steps (docs/GEMINI-API.md
   * "Files API — local video upload"):
   *
   *  1. `POST {UPLOAD_BASE_URL}/files` (command `start`) → the upload session
   *     URL arrives in the `x-goog-upload-url` RESPONSE HEADER (body is empty).
   *  2. `POST <session url>` (command `upload, finalize`) with the bytes —
   *     a file-backed Blob (`fileBlob`/`fs.openAsBlob`), so fetch STREAMS the
   *     video from disk; it is never buffered in memory. Response: `{file:…}`.
   *  3. Poll `GET /v1beta/files/<id>` while `state` is `PROCESSING`, until
   *     `ACTIVE` (the poll response is the File object UNWRAPPED).
   *
   * These two upload calls are raw `fetchImpl` (not `createApiClient`): step 1
   * needs the response *header* and step 2 posts a binary body — neither fits
   * `fetchJson`. The poll DOES go through the shared client (timeout + retry).
   * Uploads deliberately have no abort timeout: a multi-hundred-MB video can
   * legitimately take longer than any fixed budget.
   *
   * Returned files live ~48h (`expirationTime`); per-file cap is 2 GB
   * (enforced locally before any bytes are sent).
   */
  async uploadVideo(path: string, mimeType: string): Promise<UploadedFile> {
    const blob = await fileBlob(path, { type: mimeType, maxBytes: FILE_MAX_BYTES, label: 'Video' });
    return this.uploadToFilesApi(blob, mimeType, basename(path), blob.size);
  }

  /**
   * Upload already-in-memory bytes (a fetched `images_url`, a `data_base64`
   * payload, an inline `gemini_upload_file` body) to the Files API. Same three
   * steps as {@link uploadVideo}, minus the filesystem — which is what makes it
   * usable on the hosted connector, where there is no disk to stream from.
   */
  async uploadBytes(bytes: Uint8Array | ArrayBuffer, mimeType: string, displayName: string): Promise<UploadedFile> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteLength > FILE_MAX_BYTES) {
      throw new McpToolError(`File is ${view.byteLength} bytes, over the Gemini Files API limit of ${FILE_MAX_BYTES} bytes (2 GB).`);
    }
    // `new Blob([view])` already copies exactly the VIEW's bytes — its byte
    // offset and length, not the whole backing buffer — so an extra `.slice()`
    // here bought nothing and doubled peak memory, which matters most on the
    // Worker's 128MB isolate where the fetched buffer is still live.
    // The cast is a TS lib artefact: `BlobPart` is declared over
    // `ArrayBuffer`-backed views, while a `Uint8Array` is generic in its buffer
    // type. The runtime accepts any view.
    const body = new Blob([view as unknown as BlobPart], { type: mimeType });
    return this.uploadToFilesApi(body, mimeType, displayName, view.byteLength);
  }

  /**
   * Upload a request body straight through to the Files API without buffering
   * it — the direct-upload HTTP endpoint (`POST /upload` on the Worker) hands
   * us a `ReadableStream` and a `Content-Length`, and the whole point of that
   * endpoint is that the bytes never materialize anywhere they'd cost context
   * or memory.
   *
   * `contentLength` is REQUIRED because the resumable protocol's start step
   * declares it up front (`X-Goog-Upload-Header-Content-Length`); a stream of
   * unknown length has to be buffered by the caller first.
   */
  async uploadStream(stream: ReadableStream<Uint8Array>, mimeType: string, displayName: string, contentLength: number): Promise<UploadedFile> {
    if (contentLength > FILE_MAX_BYTES) {
      throw new McpToolError(`File is ${contentLength} bytes, over the Gemini Files API limit of ${FILE_MAX_BYTES} bytes (2 GB).`);
    }
    return this.uploadToFilesApi(stream, mimeType, displayName, contentLength);
  }

  /**
   * The resumable upload itself. Three live-verified steps (docs/GEMINI-API.md
   * "Files API — local video upload"):
   *
   *  1. `POST {UPLOAD_BASE_URL}/files` (command `start`) → the upload session
   *     URL arrives in the `x-goog-upload-url` RESPONSE HEADER (body is empty).
   *  2. `POST <session url>` (command `upload, finalize`) with the bytes.
   *     Response: `{file:…}`.
   *  3. Poll `GET /v1beta/files/<id>` while `state` is `PROCESSING`, until
   *     `ACTIVE` (the poll response is the File object UNWRAPPED). Images are
   *     usually `ACTIVE` immediately; video is what processes.
   *
   * These two upload calls are raw `fetchImpl` (not `createApiClient`): step 1
   * needs the response *header* and step 2 posts a binary body — neither fits
   * `fetchJson`. The poll DOES go through the shared client (timeout + retry).
   * Uploads deliberately have no abort timeout: a multi-hundred-MB file can
   * legitimately take longer than any fixed budget.
   */
  private async uploadToFilesApi(
    body: Blob | ReadableStream<Uint8Array>,
    mimeType: string,
    displayName: string,
    contentLength: number,
  ): Promise<UploadedFile> {
    const key = this.requireKey();

    // 1. start — establish the resumable upload session
    const startPath = '/files';
    const startRes = await this.fetchImpl(`${UPLOAD_BASE_URL}${startPath}`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(contentLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    });
    if (!startRes.ok) {
      throw new McpToolError(
        formatApiError(startRes.status, 'POST', `/upload/v1beta${startPath}`, await startRes.text(), { service: SERVICE }),
      );
    }
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new McpToolError(`${SERVICE} upload start did not return an x-goog-upload-url header`, {
        hint: 'The Files API resumable-upload contract may have changed — see docs/GEMINI-API.md.',
      });
    }

    // 2. upload + finalize — single shot; the session URL is self-authorizing
    // (no api-key header needed; verified live).
    // A Blob body is left EXACTLY as the live-verified video upload sent it:
    // fetch derives Content-Length from the blob, and setting the header by
    // hand is the kind of change that breaks a verified path for no gain. A
    // stream has no inherent length, so it declares one — otherwise the runtime
    // falls back to chunked encoding, which the resumable protocol does not
    // accept (this half is docs-derived; see docs/GEMINI-API.md).
    const streaming = !(body instanceof Blob);
    const upRes = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        ...(streaming ? { 'Content-Length': String(contentLength) } : {}),
      },
      body: body as BodyInit,
      // Required by undici/workerd to send a ReadableStream body at all.
      ...(streaming ? { duplex: 'half' } : {}),
    } as RequestInit);
    if (!upRes.ok) {
      throw new McpToolError(
        formatApiError(upRes.status, 'POST', '/upload/v1beta/files (finalize)', await upRes.text(), { service: SERVICE }),
      );
    }
    let file = ((await upRes.json()) as { file?: GeminiFile }).file ?? {};
    // The server echoes the resource name (`files/<id>`); it is interpolated
    // into the poll path below, so reject anything that could escape the
    // `/files/` segment (same posture as the model-id guard).
    const name = file.name ?? '';
    if (!/^files\/[\w-]+$/.test(name)) {
      throw new McpToolError(`${SERVICE} upload returned an unexpected file name: ${name || '(none)'}`);
    }

    // 3. poll PROCESSING → ACTIVE. Images are normally ACTIVE on arrival; it is
    // video that spends time here.
    for (let attempt = 0; file.state === 'PROCESSING'; attempt++) {
      if (attempt >= FILE_POLL_MAX_ATTEMPTS) {
        throw new McpToolError(`${SERVICE} file ${name} is still processing after ${(FILE_POLL_INTERVAL_MS * FILE_POLL_MAX_ATTEMPTS) / 60_000} minutes`, {
          hint: 'Very long videos can take a while to process — retry later by passing the file uri as video_url / images_file_uris.',
        });
      }
      await this.sleep(FILE_POLL_INTERVAL_MS);
      file = await this.call<GeminiFile>('GET', `/${name}`);
    }
    if (file.state !== 'ACTIVE') {
      throw new McpToolError(
        `${SERVICE} file processing failed (state ${file.state ?? 'unknown'})${file.error?.message ? `: ${file.error.message}` : ''}`,
        { hint: 'Check the file is a supported format/codec and under 2 GB.' },
      );
    }
    if (!file.uri) {
      throw new McpToolError(`${SERVICE} did not return a uri for uploaded file ${name}`);
    }
    return {
      name,
      uri: file.uri,
      mimeType: file.mimeType ?? mimeType,
      expirationTime: file.expirationTime,
      sizeBytes: file.sizeBytes,
      displayName: file.displayName,
    };
  }

  /**
   * List the files this API key currently has in the Files API. Retention is
   * ~48h, so the list is naturally short-lived — an empty list after a day is
   * expiry, not a bug.
   */
  async listFiles(pageSize = 100): Promise<ListedFile[]> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const data = await this.call<{ files?: GeminiFile[] }>('GET', `/files?pageSize=${size}`);
    return (data.files ?? [])
      .filter((f): f is GeminiFile & { name: string; uri: string } => !!f.name && !!f.uri)
      .map((f) => ({
        name: f.name,
        uri: f.uri,
        mimeType: f.mimeType ?? 'application/octet-stream',
        state: f.state,
        createTime: f.createTime,
        expirationTime: f.expirationTime,
        sizeBytes: f.sizeBytes,
        displayName: f.displayName,
      }));
  }

  /**
   * Fetch one file's metadata. Used to resolve a caller-supplied
   * `images_file_uris` entry to its real MIME type — and, as a side effect, to
   * fail fast with a clear "that file is gone" instead of the Interactions
   * API's generic 404 after a billable request was already built.
   */
  async getFile(ref: string): Promise<UploadedFile> {
    const resource = normalizeFileName(ref);
    const file = await this.call<GeminiFile>('GET', `/${resource}`);
    if (!file.uri) {
      throw new McpToolError(`${SERVICE} returned no uri for ${resource}`, {
        hint: 'Files expire ~48h after upload — re-upload with gemini_upload_file (or POST /upload) and use the new uri.',
      });
    }
    if (file.state && file.state !== 'ACTIVE') {
      throw new McpToolError(`${SERVICE} file ${resource} is not usable yet (state ${file.state}).`, {
        hint: 'Wait for the upload to finish processing, then retry.',
      });
    }
    return {
      name: file.name ?? resource,
      uri: file.uri,
      mimeType: file.mimeType ?? 'application/octet-stream',
      expirationTime: file.expirationTime,
      sizeBytes: file.sizeBytes,
      displayName: file.displayName,
    };
  }

  /**
   * Delete one uploaded file. `name` is interpolated into the URL path, so it
   * is validated to a bare `files/<id>` for the same reason the model id is
   * (see {@link uploadToFilesApi}); a full `https://…/v1beta/files/<id>` uri is
   * accepted and reduced to that form, since that is what every result echoes.
   */
  async deleteFile(name: string): Promise<void> {
    const resource = normalizeFileName(name);
    await this.call<unknown>('DELETE', `/${resource}`);
  }

  async listModels(): Promise<GeminiModel[]> {
    const data = await this.call<{ models?: RawModel[] }>('GET', '/models?pageSize=200');
    return filterImageModels(data.models ?? []);
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const model = resolveModel(opts.model, readEnvVar('GEMINI_IMAGE_MODEL'));
    const parts: unknown[] = [{ text: opts.prompt }];
    for (const img of opts.images ?? []) parts.push(generatePart(img));
    if (opts.videoUrl) {
      parts.push({ file_data: { file_uri: opts.videoUrl, mime_type: opts.videoMimeType ?? 'video/mp4' } });
    }
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    if (opts.aspectRatio || opts.imageSize) {
      const imageConfig: Record<string, string> = {};
      if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
      if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
      generationConfig.imageConfig = imageConfig;
    }
    if (opts.seed !== undefined) generationConfig.seed = opts.seed;
    if (opts.thinkingLevel !== undefined) generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
    const requestBody: Record<string, unknown> = { contents: [{ parts }], generationConfig };
    if (opts.googleSearch) requestBody.tools = [{ google_search: {} }];
    const data = await this.call<{ candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; groundingMetadata?: GroundingMeta }> }>(
      'POST',
      `/models/${model}:generateContent`,
      requestBody,
      resolveTimeoutMs(opts.timeoutMs, opts.imageSize),
    );
    const images: GeneratedImage[] = [];
    const textParts: string[] = [];
    let groundingMeta: GroundingMeta | undefined;
    for (const cand of data.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        const inline = (part.inline_data ?? part.inlineData) as { data?: string; mime_type?: string; mimeType?: string } | undefined;
        if (inline?.data) {
          images.push({ base64: inline.data, mimeType: inline.mime_type ?? inline.mimeType ?? 'image/jpeg' });
        } else if (typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text);
        }
      }
      if (cand.groundingMetadata) groundingMeta = cand.groundingMetadata;
    }
    if (images.length === 0) {
      throw new McpToolError(`${SERVICE} returned no image`, {
        hint: 'The request may have been blocked by safety filters — try rephrasing the prompt.',
      });
    }
    const text = textParts.join('\n') || undefined;

    // Parse grounding metadata if present
    let grounding: GroundingResult | undefined;
    if (groundingMeta) {
      const queries = (groundingMeta.webSearchQueries ?? []).filter(Boolean);
      const sources = (groundingMeta.groundingChunks ?? []).map((c) => c.web).filter((w): w is GroundingSource => !!w);
      if (queries.length > 0 || sources.length > 0) {
        grounding = {};
        if (queries.length > 0) grounding.queries = queries;
        if (sources.length > 0) grounding.sources = sources;
      }
    }

    return { images, text, grounding };
  }

  async interact(opts: InteractOpts): Promise<InteractResult> {
    const model = resolveModel(opts.model, readEnvVar('GEMINI_IMAGE_MODEL'));

    const inputParts: unknown[] = [{ type: 'text', text: opts.input }];
    for (const img of opts.images ?? []) inputParts.push(interactPart(img));
    if (opts.videoUrl) {
      inputParts.push({ type: 'video', uri: opts.videoUrl, mime_type: opts.videoMimeType ?? 'video/mp4' });
    }

    const responseFormat: Record<string, unknown> = { type: 'image', mime_type: 'image/jpeg' };
    if (opts.aspectRatio) responseFormat.aspect_ratio = opts.aspectRatio;
    if (opts.imageSize) responseFormat.image_size = opts.imageSize;

    const body: Record<string, unknown> = { model, input: inputParts, response_format: responseFormat };
    if (opts.thinkingLevel !== undefined) body.generation_config = { thinking_level: opts.thinkingLevel };
    if (opts.previousInteractionId !== undefined) body.previous_interaction_id = opts.previousInteractionId;
    if (opts.googleSearch || opts.searchTypes?.length) {
      const searchTool: Record<string, unknown> = { type: 'google_search' };
      if (opts.searchTypes?.length) searchTool.search_types = opts.searchTypes;
      body.tools = [searchTool];
    }

    const data = await this.postInteraction(body, opts);
    const { images, text, grounding } = this.extractInteraction(data, opts.searchTypes);
    if (images.length === 0) {
      throw new McpToolError('Gemini returned no image', {
        hint: 'The request may have been blocked by safety filters — try rephrasing the prompt.',
      });
    }
    return { id: data.id, images, text, grounding };
  }

  /**
   * Generate video via the omni model (Interactions API, inline delivery). Same
   * plumbing as {@link interact} — text/image input parts, a `video`
   * response_format, optional `video_config.task`, and `previous_interaction_id`
   * for edits. Preview model: shapes are docs-derived; parsing stays tolerant.
   */
  async generateVideo(opts: VideoOpts): Promise<VideoResult> {
    const model = opts.model ?? DEFAULT_VIDEO_MODEL;
    const inputParts: unknown[] = [{ type: 'text', text: opts.input }];
    for (const img of opts.images ?? []) inputParts.push(interactPart(img));

    const responseFormat: Record<string, unknown> = { type: 'video', delivery: 'inline' };
    if (opts.aspectRatio) responseFormat.aspect_ratio = opts.aspectRatio;

    const body: Record<string, unknown> = { model, input: inputParts, response_format: responseFormat };
    if (opts.task) body.generation_config = { video_config: { task: opts.task } };
    if (opts.previousInteractionId !== undefined) body.previous_interaction_id = opts.previousInteractionId;

    const data = await this.postInteraction(body, opts);
    const { videos, text } = this.extractInteraction(data);
    if (videos.length === 0) {
      throw new McpToolError('Gemini returned no video', {
        hint: 'The request may have been blocked by a safety filter, or the clip exceeded the ~4MB inline limit — try a shorter/simpler prompt or a different aspect ratio.',
      });
    }
    return { id: data.id, videos, text };
  }

  /**
   * Generate music via a Lyria model (Interactions API, inline audio). Reuses
   * the interact plumbing with an `audio` response_format. Preview model.
   */
  async generateMusic(opts: MusicOpts): Promise<MusicResult> {
    const model = opts.model ?? DEFAULT_MUSIC_MODEL;
    const inputParts: unknown[] = [{ type: 'text', text: opts.input }];
    for (const img of opts.images ?? []) inputParts.push(interactPart(img));

    const responseFormat: Record<string, unknown> = { type: 'audio' };
    if (opts.audioFormat) responseFormat.audio_format = opts.audioFormat;

    const body: Record<string, unknown> = { model, input: inputParts, response_format: responseFormat };
    if (opts.previousInteractionId !== undefined) body.previous_interaction_id = opts.previousInteractionId;

    const data = await this.postInteraction(body, opts);
    const { audios, text } = this.extractInteraction(data);
    if (audios.length === 0) {
      throw new McpToolError('Gemini returned no audio', {
        hint: 'The request may have been blocked by a safety filter — try rephrasing the prompt.',
      });
    }
    return { id: data.id, audios, text };
  }

  /** POST `/interactions` with the chained-404 retry. Shared by all media. */
  private async postInteraction(
    body: Record<string, unknown>,
    opts: { timeoutMs?: number; imageSize?: string; previousInteractionId?: string },
  ): Promise<{ id: string; steps?: Step[] }> {
    const { interactionsApi } = this.apisFor(resolveTimeoutMs(opts.timeoutMs, opts.imageSize));
    const budgetMs = resolveChainRetryBudgetMs();
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await interactionsApi.fetchJson<{ id: string; steps?: Step[] }>('POST', '/interactions', { body });
      } catch (err) {
        // A 404 on a chained call is worth retrying: the interactions store is
        // eventually consistent, so a freshly returned id can 404 briefly.
        //
        // What it is NOT is a diagnosis. We only know the status; the body is
        // generic ("Requested entity was not found.") and covers a bad model id
        // and an expired files/… uri just as well as a dead interaction. So the
        // error carries the upstream text and says what it doesn't know — the
        // caller (tools/interact.ts) probes to find out which it was.
        if (!(opts.previousInteractionId && err instanceof ApiError && err.status === 404)) throw err;
        // Exponential backoff until the budget is spent. Sized against the
        // observed lag (minutes), not against how long a human likes to wait —
        // the alternative is telling the caller their chain is dead while the
        // API is seconds from serving it.
        const delay = Math.min(CHAIN_404_RETRY_BASE_MS * 2 ** attempt, CHAIN_404_RETRY_MAX_SLEEP_MS);
        if (waitedMs + delay <= budgetMs) {
          waitedMs += delay;
          await this.sleep(delay);
          continue;
        }
        throw new ChainedRequest404Error(opts.previousInteractionId, err.message, { attempts: attempt, waitedMs }, {
          hint: 'Re-issue the request WITHOUT previous_interaction_id (re-attaching the prior output image if you were editing). If that also 404s, the interaction id is not the cause — check the model id and any files/… uri (they expire ~48h). gemini_interact does this probe automatically.',
          cause: err,
        });
      }
    }
  }

  /**
   * Collect `model_output` media (image/video/audio) + text + grounding from an
   * interactions response. Only the `model_output` step is surfaced — `thought`
   * steps (internal reasoning / draft images) are dropped on purpose so they
   * can't leak into text or pollute the outputs. Tolerant of snake/camel MIME.
   */
  private extractInteraction(data: { steps?: Step[] }, searchTypes?: SearchType[]): ExtractedInteraction {
    const images: GeneratedMedia[] = [];
    const videos: GeneratedMedia[] = [];
    const audios: GeneratedMedia[] = [];
    const textParts: string[] = [];
    const searchQueries: string[] = [];
    const searchSuggestions = new Set<string>();
    for (const step of data.steps ?? []) {
      // Grounding queries live on the `google_search_call` step's arguments.
      if (step.type === 'google_search_call') {
        for (const q of step.arguments?.queries ?? []) if (q?.trim()) searchQueries.push(q);
        continue;
      }
      // ToS: image_search results' `search_suggestions` chips MUST be displayed
      // by the caller — surface them (deduped) only when image_search was asked.
      if (step.type === 'google_search_result') {
        if (searchTypes?.includes('image_search')) {
          for (const r of step.result ?? []) if (r.search_suggestions?.trim()) searchSuggestions.add(r.search_suggestions);
        }
        continue;
      }
      if (step.type !== 'model_output') continue;
      for (const parts of [step.content ?? [], step.summary ?? []]) {
        for (const part of parts) {
          const mime = part.mime_type ?? part.mimeType;
          if (part.data) {
            if (part.type === 'image') images.push({ base64: part.data, mimeType: mime ?? 'image/jpeg' });
            else if (part.type === 'video') videos.push({ base64: part.data, mimeType: mime ?? 'video/mp4' });
            else if (part.type === 'audio') audios.push({ base64: part.data, mimeType: mime ?? 'audio/mpeg' });
          } else if (part.type === 'text' && part.text?.trim()) {
            textParts.push(part.text);
          }
        }
      }
    }
    let grounding: GroundingResult | undefined;
    if (searchQueries.length > 0 || searchSuggestions.size > 0) {
      grounding = {};
      if (searchQueries.length > 0) grounding.queries = searchQueries;
      if (searchSuggestions.size > 0) grounding.search_suggestions = [...searchSuggestions];
    }
    return { images, videos, audios, text: textParts.join('\n') || undefined, grounding };
  }
}

/** Module-level singleton shared by every tool module (deferred-config-error). */
export const client = new GeminiClient();
