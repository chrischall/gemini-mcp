/**
 * The generalist workhorse (Nano Banana 2) — overridable per-call and via
 * GEMINI_IMAGE_MODEL. The premium gemini-3-pro-image is a deliberate opt-in:
 * it costs more and needs a funded account, so callers reach for it via the
 * `model` param when the task warrants it (see MODEL_CHOICE_GUIDE).
 */
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';

/**
 * Default video model (omni, Interactions API) — overridable per-call.
 *
 * GA since 2026-08-27. Its predecessor `gemini-omni-flash-preview` shuts down
 * 2026-09-30, so this is a migration and not a preference; the GA model bills
 * at the same rate and adds `resolution` and the `extend` task.
 */
export const DEFAULT_VIDEO_MODEL = 'gemini-omni-1.1-flash';
/**
 * Default music model (Lyria clips, Interactions API) — 30s, MP3, the cheapest
 * of the three at $0.04 a song. `lyria-3.5` (minutes-long, vocals) and
 * `lyria-3-pro-preview` are the opt-ins at twice the price, so neither is the
 * default. All need a funded account.
 */
export const DEFAULT_MUSIC_MODEL = 'lyria-3-clip-preview';

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

/**
 * Keep only Gemini image-generation models (the Nano Banana family) and strip
 * the `models/` prefix. Excludes `imagen-*` — those contain the substring
 * "image" but use a different `:predict` API this server doesn't implement.
 */
export function filterImageModels(raw: RawModel[]): GeminiModel[] {
  return raw
    .filter((m) => /image/i.test(m.name ?? '') && !/imagen/i.test(m.name ?? ''))
    .map((m) => ({
      id: (m.name ?? '').replace(/^models\//, ''),
      displayName: m.displayName ?? '',
      description: m.description ?? '',
    }));
}
