import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely, readEnvVar, McpToolError, ApiError, createApiClient, formatApiError, fileBlob, type ApiClient } from '@chrischall/mcp-utils';
import { resolveModel, filterImageModels, type GeminiModel, type RawModel } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'; // v1 lacks gemini-3-pro-image; confirmed via Task 5
const SERVICE = 'Gemini';
const INTERACTIONS_SERVICE = 'Gemini Interactions';
// Per-request abort budget. Image generation routinely runs 30s+ on the Pro
// model, so this is deliberately 60s (NOT the fleet's usual 15–30s).
const REQUEST_TIMEOUT_MS = 60_000;

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
// 404 for a short window right after its turn completes (observed live
// 2026-07-06 — an id that 404'd on an immediate chain resolved fine minutes
// later). A chained 404 generated nothing (no cost), so retry before giving up:
// attempts wait 2s then 4s (~6s total).
const CHAIN_404_RETRIES = 2;
const CHAIN_404_RETRY_MS = 2_000;

export interface GeneratedImage { base64: string; mimeType: string; }

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
  images?: { base64: string; mimeType: string }[];
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
}

/** A video uploaded to the Gemini Files API, ready to reference by `uri`. */
export interface UploadedVideo {
  /** Resource name, `files/<id>`. */
  name: string;
  /** Full URI to pass as the generate `file_uri` / interact `uri`. */
  uri: string;
  mimeType: string;
  /** When the file is deleted server-side (~48h after upload). */
  expirationTime?: string;
}

/** Raw File resource (finalize wraps it in `{file:}`; the GET poll does not). */
interface GeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  expirationTime?: string;
  error?: { message?: string };
}

export interface InteractResult { id: string; images: GeneratedImage[]; text?: string; grounding?: GroundingResult; }

export interface GenerateOpts {
  prompt: string;
  images?: { base64: string; mimeType: string }[];
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  seed?: number;
  thinkingLevel?: 'minimal' | 'high';
  googleSearch?: boolean;
  videoUrl?: string;
  /** MIME type for the video reference (default `video/mp4` — the YouTube path). */
  videoMimeType?: string;
}

export class GeminiClient {
  private readonly apiKey: string | null;
  private readonly configError: Error | null;
  private readonly api: ApiClient;
  private readonly interactionsApi: ApiClient;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    const key = readEnvVar('GEMINI_API_KEY');
    if (!key) {
      this.apiKey = null;
      this.configError = new McpToolError('GEMINI_API_KEY environment variable is required', {
        hint: 'Create a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY in your MCP host env or .env',
      });
    } else {
      this.apiKey = key;
      this.configError = null;
    }
    // Both paths share: the key in the `x-goog-api-key` header (Gemini does not
    // use `Authorization: Bearer`), a 60s abort budget, and the default 429
    // retry (once after 2s — the free tier rate-limits aggressively).
    // `getToken` calls requireKey() so key resolution stays at REQUEST time:
    // the server boots without a key and the actionable config error (with its
    // aistudio hint) surfaces on the first tool call, not at startup.
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const shared = {
      tokenHeader: 'x-goog-api-key',
      getToken: () => this.requireKey(),
      timeout: REQUEST_TIMEOUT_MS,
      fetchImpl: this.fetchImpl,
    };
    this.api = createApiClient({ baseUrl: BASE_URL, serviceName: SERVICE, ...shared });
    // Separate client for the Interactions API so errors name the right API.
    // The beta-era Api-Revision header is gone: the API went GA and requests
    // succeed without it (verified live 2026-07-06; see docs/GEMINI-API.md).
    // Don't re-add a pinned revision — it would freeze us on old semantics.
    this.interactionsApi = createApiClient({
      baseUrl: BASE_URL,
      serviceName: INTERACTIONS_SERVICE,
      ...shared,
    });
  }

  private requireKey(): string {
    if (this.configError) throw this.configError;
    return this.apiKey!;
  }

  /** The default model after env override (no per-call arg). */
  defaultModel(): string {
    return resolveModel(undefined, readEnvVar('GEMINI_IMAGE_MODEL'));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.api.fetchJson<T>(method, path, body !== undefined ? { body } : {});
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
  async uploadVideo(path: string, mimeType: string): Promise<UploadedVideo> {
    const key = this.requireKey();
    const blob = await fileBlob(path, { type: mimeType, maxBytes: FILE_MAX_BYTES, label: 'Video' });

    // 1. start — establish the resumable upload session
    const startPath = '/files';
    const startRes = await this.fetchImpl(`${UPLOAD_BASE_URL}${startPath}`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: basename(path) } }),
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
    const upRes = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: blob,
    });
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

    // 3. poll PROCESSING → ACTIVE
    for (let attempt = 0; file.state === 'PROCESSING'; attempt++) {
      if (attempt >= FILE_POLL_MAX_ATTEMPTS) {
        throw new McpToolError(`${SERVICE} video file ${name} is still processing after ${(FILE_POLL_INTERVAL_MS * FILE_POLL_MAX_ATTEMPTS) / 60_000} minutes`, {
          hint: 'Very long videos can take a while to process — retry later by passing the file uri as video_url.',
        });
      }
      await this.sleep(FILE_POLL_INTERVAL_MS);
      file = await this.call<GeminiFile>('GET', `/${name}`);
    }
    if (file.state !== 'ACTIVE') {
      throw new McpToolError(
        `${SERVICE} video file processing failed (state ${file.state ?? 'unknown'})${file.error?.message ? `: ${file.error.message}` : ''}`,
        { hint: 'Check the video is a supported format/codec and under 2 GB.' },
      );
    }
    if (!file.uri) {
      throw new McpToolError(`${SERVICE} did not return a uri for uploaded file ${name}`);
    }
    return { name, uri: file.uri, mimeType: file.mimeType ?? mimeType, expirationTime: file.expirationTime };
  }

  async listModels(): Promise<GeminiModel[]> {
    const data = await this.call<{ models?: RawModel[] }>('GET', '/models?pageSize=200');
    return filterImageModels(data.models ?? []);
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const model = resolveModel(opts.model, readEnvVar('GEMINI_IMAGE_MODEL'));
    const parts: unknown[] = [{ text: opts.prompt }];
    for (const img of opts.images ?? []) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }
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
    for (const img of opts.images ?? []) {
      inputParts.push({ type: 'image', mime_type: img.mimeType, data: img.base64 });
    }
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

    type StepPart = { type: string; mime_type?: string; data?: string; text?: string };
    type Step = {
      type: string;
      content?: StepPart[];
      summary?: StepPart[];
      // `arguments` is null on some google_search_call steps (verified 2026-07-06).
      arguments?: { queries?: string[] } | null;
      result?: Array<{ search_suggestions?: string }>;
    };
    let data!: { id: string; steps?: Step[] };
    for (let attempt = 0; ; attempt++) {
      try {
        data = await this.interactionsApi.fetchJson<{ id: string; steps?: Step[] }>('POST', '/interactions', {
          body,
        });
        break;
      } catch (err) {
        // A 404 on a chained call means the referenced interaction wasn't
        // found. Two causes: (a) store lag right after the id was created —
        // retry with backoff; (b) genuinely gone — interactions are retained
        // 55 days (paid tier) / 1 day (free tier) and are scoped to the API
        // key's project. The chain is recoverable from the last output file,
        // so the exhausted-retries error says how.
        if (!(opts.previousInteractionId && err instanceof ApiError && err.status === 404)) throw err;
        if (attempt < CHAIN_404_RETRIES) {
          await this.sleep(CHAIN_404_RETRY_MS * (attempt + 1));
          continue;
        }
        throw new McpToolError(
          `Previous interaction "${opts.previousInteractionId}" was not found (retried ${CHAIN_404_RETRIES}× — the interactions store can lag briefly after a turn completes). If the id is old: interactions are retained 55 days on the paid tier (1 day on the free tier) and are scoped to the API key that created them.`,
          {
            hint: 'Retry once more in a few seconds; if it keeps failing, start a new chain: call gemini_interact again with the last output image passed via `images` (or `images_base64`) plus the same instruction, then chain the NEW interaction id.',
            cause: err,
          },
        );
      }
    }

    // Only surface the `model_output` step — that's the caller-facing result.
    // `thought` steps hold internal reasoning (and, with includeThoughts, draft
    // "thinking" images); collecting those would leak reasoning into `text` and
    // pollute the returned images. The verified contract puts the output image
    // in `model_output`.
    const images: GeneratedImage[] = [];
    const textParts: string[] = [];
    const searchQueries: string[] = [];
    const searchSuggestions = new Set<string>();
    for (const step of data.steps ?? []) {
      // Grounding queries live on the `google_search_call` step's arguments.
      // (The `google_search_result` step only carries HTML `search_suggestions`
      // chips — no clean source uri/title list like generateContent's
      // groundingChunks — so interact surfaces queries, plus the suggestion
      // chips when image_search was requested, ToS below.)
      if (step.type === 'google_search_call') {
        for (const q of step.arguments?.queries ?? []) if (q?.trim()) searchQueries.push(q);
        continue;
      }
      // ToS: image_search results' `search_suggestions` chips MUST be displayed
      // by the caller, so surface them (deduped — the chips repeat) only when
      // image_search grounding was requested; web-only grounding keeps the
      // lean queries-only meta.
      if (step.type === 'google_search_result') {
        if (opts.searchTypes?.includes('image_search')) {
          for (const r of step.result ?? []) if (r.search_suggestions?.trim()) searchSuggestions.add(r.search_suggestions);
        }
        continue;
      }
      if (step.type !== 'model_output') continue;
      for (const parts of [step.content ?? [], step.summary ?? []]) {
        for (const part of parts) {
          if (part.type === 'image' && part.data) {
            images.push({ base64: part.data, mimeType: part.mime_type ?? 'image/jpeg' });
          } else if (part.type === 'text' && part.text?.trim()) {
            textParts.push(part.text);
          }
        }
      }
    }

    if (images.length === 0) {
      throw new McpToolError('Gemini returned no image', {
        hint: 'The request may have been blocked by safety filters — try rephrasing the prompt.',
      });
    }

    const resultText = textParts.join('\n') || undefined;
    let grounding: GroundingResult | undefined;
    if (searchQueries.length > 0 || searchSuggestions.size > 0) {
      grounding = {};
      if (searchQueries.length > 0) grounding.queries = searchQueries;
      if (searchSuggestions.size > 0) grounding.search_suggestions = [...searchSuggestions];
    }
    return { id: data.id, images, text: resultText, grounding };
  }
}

/** Module-level singleton shared by every tool module (deferred-config-error). */
export const client = new GeminiClient();
