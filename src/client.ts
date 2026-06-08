import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely, readEnvVar, McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';
import { resolveModel, filterImageModels, type GeminiModel, type RawModel } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'; // v1 lacks gemini-3-pro-image; confirmed via Task 5
const SERVICE = 'Gemini';

export interface GeneratedImage { base64: string; mimeType: string; }

export interface GenerateResult { images: GeneratedImage[]; text?: string; }

export interface GenerateOpts {
  prompt: string;
  images?: { base64: string; mimeType: string }[];
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  seed?: number;
  thinkingLevel?: 'minimal' | 'high';
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
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    if (opts.aspectRatio || opts.imageSize) {
      const imageConfig: Record<string, string> = {};
      if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
      if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
      generationConfig.imageConfig = imageConfig;
    }
    if (opts.seed !== undefined) generationConfig.seed = opts.seed;
    if (opts.thinkingLevel !== undefined) generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
    const data = await this.call<{ candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }>(
      'POST',
      `/models/${model}:generateContent`,
      { contents: [{ parts }], generationConfig },
    );
    const images: GeneratedImage[] = [];
    const textParts: string[] = [];
    for (const cand of data.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        const inline = (part.inline_data ?? part.inlineData) as { data?: string; mime_type?: string; mimeType?: string } | undefined;
        if (inline?.data) {
          images.push({ base64: inline.data, mimeType: inline.mime_type ?? inline.mimeType ?? 'image/jpeg' });
        } else if (typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text);
        }
      }
    }
    if (images.length === 0) {
      throw new McpToolError(`${SERVICE} returned no image`, {
        hint: 'The request may have been blocked by safety filters — try rephrasing the prompt.',
      });
    }
    const text = textParts.join('\n') || undefined;
    return { images, text };
  }
}

/** Module-level singleton shared by every tool module (deferred-config-error). */
export const client = new GeminiClient();
