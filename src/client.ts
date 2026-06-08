import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely, readEnvVar, McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';
import { resolveModel, filterImageModels, type GeminiModel, type RawModel } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'; // v1 lacks gemini-3-pro-image; confirmed via Task 5
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const SERVICE = 'Gemini';

export interface GeneratedImage { base64: string; mimeType: string; }

/** A single grounding source. Both fields optional — defensive against a beta
 * API omitting one (the doc shows `{uri, title}` always present). */
export interface GroundingSource { uri?: string; title?: string }
export interface GroundingResult {
  queries?: string[];
  sources?: GroundingSource[];
}
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
  videoUrl?: string;
}

export interface InteractResult { id: string; images: GeneratedImage[]; text?: string; }

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
}

export class GeminiClient {
  private readonly apiKey: string | null;
  private readonly configError: Error | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
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
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    const key = this.requireKey();
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpToolError(`${SERVICE} API ${res.status}: ${truncateErrorMessage(text)}`);
    }
    return (await res.json()) as T;
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
      parts.push({ file_data: { file_uri: opts.videoUrl, mime_type: 'video/mp4' } });
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
    const key = this.requireKey();
    const model = resolveModel(opts.model, readEnvVar('GEMINI_IMAGE_MODEL'));

    const inputParts: unknown[] = [{ type: 'text', text: opts.input }];
    for (const img of opts.images ?? []) {
      inputParts.push({ type: 'image', mime_type: img.mimeType, data: img.base64 });
    }
    if (opts.videoUrl) {
      inputParts.push({ type: 'video', uri: opts.videoUrl, mime_type: 'video/mp4' });
    }

    const responseFormat: Record<string, unknown> = { type: 'image', mime_type: 'image/jpeg' };
    if (opts.aspectRatio) responseFormat.aspect_ratio = opts.aspectRatio;
    if (opts.imageSize) responseFormat.image_size = opts.imageSize;

    const body: Record<string, unknown> = { model, input: inputParts, response_format: responseFormat };
    if (opts.thinkingLevel !== undefined) body.generation_config = { thinking_level: opts.thinkingLevel };
    if (opts.previousInteractionId !== undefined) body.previous_interaction_id = opts.previousInteractionId;
    if (opts.googleSearch) body.tools = [{ type: 'google_search' }];

    const res = await this.fetchImpl(INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json',
        'Api-Revision': '2026-05-20',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch { /* use raw text */ }
      throw new McpToolError(`Gemini Interactions API ${res.status}: ${truncateErrorMessage(message)}`);
    }

    type StepPart = { type: string; mime_type?: string; data?: string; text?: string };
    type Step = { type: string; content?: StepPart[]; summary?: StepPart[] };
    const data = await res.json() as { id: string; steps?: Step[] };

    // Only surface the `model_output` step — that's the caller-facing result.
    // `thought` steps hold internal reasoning (and, with includeThoughts, draft
    // "thinking" images); collecting those would leak reasoning into `text` and
    // pollute the returned images. The verified contract puts the output image
    // in `model_output`.
    const images: GeneratedImage[] = [];
    const textParts: string[] = [];
    for (const step of data.steps ?? []) {
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
    return { id: data.id, images, text: resultText };
  }
}

/** Module-level singleton shared by every tool module (deferred-config-error). */
export const client = new GeminiClient();
