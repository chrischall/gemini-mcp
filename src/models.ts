/** Latest top-end image model; overridable per-call and via GEMINI_IMAGE_MODEL. */
export const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image';

/** A trimmed image-model entry surfaced by `gemini_list_models`. */
export interface GeminiModel {
  /** Bare id without the `models/` prefix, e.g. `gemini-3-pro-image`. */
  id: string;
  displayName: string;
  description: string;
}

/** Raw model object shape from `GET /v1/models`. */
export interface RawModel {
  name?: string;
  displayName?: string;
  description?: string;
}

/** Per-call → env override → hardcoded default. Blank/whitespace counts as unset. */
export function resolveModel(perCall: string | undefined, envOverride: string | undefined): string {
  return perCall?.trim() || envOverride?.trim() || DEFAULT_IMAGE_MODEL;
}

/** Keep only image-capable models (id contains "image"), strip the `models/` prefix. */
export function filterImageModels(raw: RawModel[]): GeminiModel[] {
  return raw
    .filter((m) => /image/i.test(m.name ?? ''))
    .map((m) => ({
      id: (m.name ?? '').replace(/^models\//, ''),
      displayName: m.displayName ?? '',
      description: m.description ?? '',
    }));
}
