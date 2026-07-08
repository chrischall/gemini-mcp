# Video + music generation, media-first tool taxonomy — design

Date: 2026-07-08. Adds Gemini video (omni) and Lyria music generation, and renames
the image tools to a media-first scheme. Realtime Lyria is **deferred** (see below).

## Motivation

Extend the server beyond images to **video** (`gemini-omni-flash-preview`) and
**music** (`lyria-3-clip-preview`, `lyria-3-pro-preview`). Both ride the **same
`POST /v1beta/interactions` endpoint** as `gemini_interact` — same `input` /
`response_format` / `previous_interaction_id` request skeleton and same
`steps[] → model_output → content[]` response — so the addition is mostly
"existing machinery, different output MIME + file extension."

## Deferred: realtime Lyria (`models/lyria-realtime-exp`)

WebSocket-only, persistent bidirectional interactive streaming (send weighted
prompts + bpm/density live, receive continuous 48 kHz PCM). Incompatible with two
core constraints: everything network is an injectable `fetch` (a WS session
isn't), and an MCP tool call is request/response (can't expose live steering). The
clip model already covers "music from a prompt" over clean REST. **Not built now.**

## Tool taxonomy (after this work)

| Tool | Status | Endpoint |
| --- | --- | --- |
| `gemini_image_generate` | renamed from `gemini_generate_image` | generateContent |
| `gemini_image_edit` | renamed from `gemini_edit_image` | generateContent |
| `gemini_image_set` | renamed from `gemini_generate_set` | generateContent |
| `gemini_interact` | unchanged (Interactions is inherently cross-media) | interactions |
| `gemini_video_generate` | **new** | interactions |
| `gemini_music_generate` | **new** | interactions |
| `gemini_list_models`, `gemini_get_result` | unchanged (cross-media) | — |

Clean break — **no back-compat aliases** for the old image names.

## Reuse (the mandate: reuse as much as possible)

New tools lean on already-shipped code: `client.interact()` plumbing, steps
extraction, `previous_interaction_id`/`continue_last` chaining, the job registry
(`dispatch` → `idempotency_key` + `async` + `gemini_get_result`),
`timeoutRiskHint`, sidecar recovery, `resolveOutputDir`/`uniquePath`/`slugify`,
`gatherImageInputs` (image→video), and the Files-API poll loop (`uri` delivery).

## Generalized plumbing (the only substantive new shared code)

- **`client.interact()`** returns typed media instead of only images:
  `{ id, videos, audios, images, text, grounding }`, and accepts a
  `responseFormat` (`{ type: 'image' | 'video' | 'audio', … }`). The steps parser
  is unchanged in spirit — it just collects `video` / `audio` content blocks
  alongside `image`, tolerant of snake/camel casing (existing defensive pattern).
  Image tools keep reading `.images`; video reads `.videos`; music `.audios`.
- **`writeImage()` → `writeMedia(dir, base, data, mimeType, ext)`** (image/video/
  audio are all bytes + extension). `emit()` disk mode returns paths for every
  media type. Inline: audio → MCP `type:'audio'` block; **video has no MCP
  content-block type**, so `gemini_video_generate` is **disk-only** (an `inline`
  request is ignored with a note in meta).

## `gemini_video_generate`

Params: `prompt`; `aspect_ratio` ∈ {`9:16`,`16:9`} (**omni's own enum — not the
image `ASPECT_RATIOS`**); `task` ∈ {`text_to_video`,`image_to_video`,
`reference_to_video`,`edit`}; image inputs (`images`/`images_base64`/
`from_clipboard`); `previous_interaction_id`/`continue_last` (for `edit`);
`delivery` ∈ {`inline`(≤~4 MB),`uri`}; shared `idempotency_key`/`async`/
`timeout_ms`. Output `video/mp4` → `.mp4` on disk. `uri` delivery reuses the
existing `PROCESSING`→`ACTIVE` Files-API poll.

## `gemini_music_generate`

Params: `prompt` (text; lyrics/structure inline); `model` (default
`lyria-3-clip-preview`; `lyria-3-pro-preview`); optional `audio_format`
(`mp3` default; `wav` **pro-only** → validated, else actionable error); optional
image references; shared `idempotency_key`/`async`/`timeout_ms`. No aspect ratio.
Output audio → `.mp3`/`.wav` on disk, or inline `type:'audio'`. Clip is fixed
~30 s; Pro is longer.

## Testing

All mock-testable (Interactions rides injectable `fetchImpl`): video/music via a
mocked `client.interact` returning video/audio content; disk-write assertions;
idempotency/async parity through `dispatch`; music `wav`-on-clip rejection;
rename call-site updates; `server-boot` asserts the two new tools register.

## Preview-shape caveat

`gemini-omni-flash-preview` and `lyria-3-*-preview` are **preview** models whose
response shapes have been read from docs only, not a live funded response
(CLAUDE.md: don't trust unverified preview shapes). Parsing is **tolerant**
(snake/camel fallbacks, defensive extraction, actionable errors); no fields are
invented beyond the docs. Shapes must be live-verified against a funded key before
new fields are trusted.

## PR sequencing

1. **PR-A — rename** (`gemini_image_generate/edit/set`) + this spec. Mechanical,
   isolated, merges first.
2. **PR-B — media plumbing + `gemini_video_generate` + `gemini_music_generate`.**
   Video and music were consolidated into one PR: both ride the identical
   `interact()`/`emit()` generalization (`postInteraction`/`extractInteraction`/
   `emitMedia`), so splitting them would have left the shared `generateMusic`
   client method as dead code in a video-only PR — and one PR halves the
   auto-merge/rebase surface.

## Non-goals

- Realtime Lyria (deferred — WebSocket, non-testable, non-request/response).
- Back-compat aliases for old image tool names.
- Trusting preview response fields not shown in the docs without live verification.
