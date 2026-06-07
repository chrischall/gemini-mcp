# gemini-mcp — design

**Date:** 2026-06-07
**Status:** Approved (design)
**Archetype:** bearer / direct-API (splitwise clone). No fetchproxy.

## Purpose

An MCP server wrapping Google's Gemini image-generation models ("Nano Banana" /
"Nano Banana Pro"). Generates and edits images, and — the headline feature —
produces a *consistent set* of images from one prompt: a master image plus N
further images that reference the master so subject/style stays consistent.

## Service / API

- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1/models/{model}:generateContent`
- **Auth:** header `x-goog-api-key: $GEMINI_API_KEY` (NOT `Authorization: Bearer`).
- **Models (live as of 2026-06):** `gemini-3-pro-image` (Pro, default),
  `gemini-3.1-flash-image` (fast), `gemini-2.5-flash-image`. No literal
  "Pro 2" model string exists — `list_models` is the discovery path.
- **Model listing:** `GET https://generativelanguage.googleapis.com/v1/models`
  → filter to image-capable models for `list_models`.

### ⚠️ Pre-implementation verification (blocking, do FIRST)

The exact request field for aspect ratio / resolution is unconfirmed. A docs
scrape showed `generationConfig.responseFormat.image.{aspectRatio,imageSize}`,
but earlier API versions used `generationConfig.imageConfig.{aspectRatio,imageSize}`.

Per the fleet rule "never encode a request shape you haven't seen succeed":
**make one real `curl` against `generateContent`** (text→image with an aspect
ratio + size set), confirm the field names AND that the image bytes come back at
`candidates[0].content.parts[*].inline_data.data`, then pin the exact
request/response shape in `docs/GEMINI-API.md`. Secret-scan before committing —
**never commit the API key.** Only then write the client against the fixture.

## Request / response shape (to confirm against the real call)

Request:
```jsonc
{
  "contents": [{
    "parts": [
      { "text": "<prompt>" },
      { "inline_data": { "mime_type": "image/png", "data": "<BASE64 input image>" } } // 0..M, only for edit/compose/set scenes
    ]
  }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],            // confirm: ["TEXT","IMAGE"] may be required
    // aspect/size container name to CONFIRM (responseFormat.image vs imageConfig):
    "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" }
  }
}
```

Response (generated images are inline data on the candidate parts):
```jsonc
{ "candidates": [{ "content": { "parts": [
  { "text": "<optional caption>" },
  { "inline_data": { "mime_type": "image/png", "data": "<BASE64 image bytes>" } }
]}}]}
```

- **Aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1.
- **Image sizes:** "1K", "2K", "4K" (and "512" Flash-only).
- **Input image cap:** inline base64 only; note Gemini's ~20 MB/request limit.
  Files API is **out of scope for v1**.

## Architecture

```
src/
  index.ts        # runMcp({ name:'gemini-mcp', version, banner, deps:client, tools:[...] })
  version.ts      # export const VERSION = '...'; // x-release-please-version  (single source)
  client.ts       # GeminiClient: deferred-config-error; one private generate(); listModels()
  models.ts       # default model const + image-capable filter helper
  images.ts       # disk I/O: base64→PNG write (non-overwriting), slug/filename, path read→base64
  tools/
    models.ts     # registerModelTools  -> list_models
    generate.ts   # registerGenerateTools -> generate_image, edit_image
    set.ts        # registerSetTools -> generate_set
tests/            # vitest; mock fetch; pinned fixtures; version-sync; server-boot smoke
docs/GEMINI-API.md  # pinned real request/response capture (NO secrets)
```

`client.ts` is the only thing that talks HTTP. All four tools route through one
private `client.generate({ prompt, images?, model, config })`; `list_models`
uses `client.listModels()`. Deferred-config-error: constructor reads
`GEMINI_API_KEY` via `readEnvVar`; if absent, store `configError` and re-throw
from `requireKey()` at request time so the server still boots for the host's
install-time `tools/list` probe.

## Tools

### `list_models` (readOnly)
GET `/v1/models`, filter image-capable, return `[{ id, displayName, description }]`
with the resolved default flagged. Lets the user discover override targets.

### `generate_image` (not readOnly)
Text → image.
- `prompt` (NonEmptyString)
- `model?` (default-resolved; see Model resolution)
- `aspect_ratio?` (enum of supported ratios)
- `image_size?` (enum 1K/2K/4K)
- `count?` (PositiveInt, default 1) — number of independent images. Implemented
  as N independent calls (image-model `candidateCount` support is unverified;
  confirm during the verification curl and switch to one call if supported)
- `output_dir?` / `inline?` (see Output)

### `edit_image` (not readOnly)
1+ input images + prompt → image. Covers single-image edit AND multi-image
compose (no separate compose tool).
- `prompt` (NonEmptyString)
- `images` (string[], ≥1 file paths) — read from disk, base64 into `inline_data`
- `model?`, `aspect_ratio?`, `image_size?`, `output_dir?`/`inline?`

### `generate_set` (not readOnly) — headline feature
Master + consistent series.
- `master_prompt` (NonEmptyString)
- `scenes?` (string[]) — explicit per-image prompts
- `count?` (PositiveInt) — pure variations of `master_prompt` when `scenes` absent
  (exactly one of `scenes` / `count` provided)
- `reference_mode?` ('master' | 'chain', default 'master')
  - **master:** every scene references the master only (parallel, no drift)
  - **chain:** each image references the previous (master→1→2…; sequential)
- `model?`, `aspect_ratio?`, `image_size?`, `output_dir?`/`inline?`

Flow: generate master from `master_prompt`; then per scene/variation call
`generate([referenceImageBytes, sceneText])`. In `master` mode the scenes run
concurrently with a small cap; in `chain` mode they run sequentially. Returns the
master + N images (paths or inline).

## Output handling

- **Default:** write PNG(s); return `{ path }[]`. Destination precedence:
  per-call `output_dir` → `GEMINI_OUTPUT_DIR` env → cwd.
- **Inline:** per-call `inline: true` returns base64 via `imageResult` instead of
  writing to disk.
- **Filenames:** slug from the prompt; single = `<slug>.png` (or `<slug>-01.png`…
  for `count`>1); set = `<slug>-master.png`, `<slug>-01.png`, …. Non-overwriting
  (suffix bump on collision).
- Decode base64 → Buffer → `fs` write. Input images: `fs` read → base64.

## Config

- `GEMINI_API_KEY` — required (deferred-config-error).
- `GEMINI_IMAGE_MODEL` — optional default-model override.
- `GEMINI_OUTPUT_DIR` — optional default output directory.

**Model resolution order:** per-call `model` → `GEMINI_IMAGE_MODEL` → hardcoded
default `gemini-3-pro-image`. `list_models` shows the alternatives.

## Confirm-gating

Generation tools are **not** `confirm`-gated. The fleet confirm rule targets
tools mutating remote state; image generation creates local files and isn't
remote-state mutation. Tools are marked non-readonly (side effects: API cost +
disk write); `list_models` is readOnly. (Revisit only if a cost-confirm is wanted.)

## Errors

Typed `McpToolError` subclasses with actionable `hint`. Missing key →
config error at request time. API errors routed through
`formatApiError`/`truncateErrorMessage` (redacts the key). Bad model id / quota /
safety-block surfaced with the API's message.

## Testing (TDD)

- Mock `fetch`; pin request/response fixtures from the real capture.
- Write-tool flow: failing test → minimal client → green; assert the request
  **body shape** (parts, inline_data, generationConfig) against the pinned fixture.
- `versionSyncTest` from `@chrischall/mcp-utils/test`.
- `server-boot` smoke test: spawn built artifacts (`dist/bundle.js` with no
  node_modules; `bin` with them), run `initialize` + `tools/list`, assert
  `tools.length >= 4` (not exact).
- `images.ts` unit tests: base64→file, filename slug/collision, path read→base64.

## Packaging / repo bootstrap

Copy splitwise-mcp's `.github/`, tsconfig (rootDir `src`, `types:["node"]`),
vitest, packaging. Full bootstrap: workflows (ci, pr-auto-review, claude,
auto-merge, release-please, dependabot), labels, two branch-protection rulesets,
`allow_auto_merge=true`, release-please extra-files listing every version-bearing
file + `src/version.ts`, publish scaffold (manifest.json, server.json desc ≤100
chars, .claude-plugin/*, .mcp.json, skills/SKILL.md), `.mcpbignore`. Secrets
(`CLAUDE_CODE_OAUTH_TOKEN`, `RELEASE_PAT`, npm trusted publishing) set by the
human — agent never sets credential values.

`@chrischall/mcp-utils` via published `^x` (or `file:../mcp-utils/<tarball>`
pre-publish). zod 4. ESM/NodeNext `.js` import suffixes. Optional deps lazy.

## Out of scope (v1)

- Files API for large (>20 MB) inputs.
- Video / other modalities.
- Confirm/cost-gating.

## Open items resolved

- Repo name: `gemini-mcp`.
- `generate_set` mode: C (both `master`/`chain`, default `master`).
- No confirm-gate on generation.
