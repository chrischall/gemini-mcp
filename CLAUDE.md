# CLAUDE.md — gemini-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.6.0: Google **Gemini** image-generation MCP server. Wraps the Generative
Language REST API (`https://generativelanguage.googleapis.com/v1beta`) and
exposes 8 tools to Claude over stdio: text→image and image→image generation,
multi-turn conversational editing, consistent image *sets*, **video generation**
(omni, `gemini_video_generate`), **music generation** (Lyria clips/pro,
`gemini_music_generate`), and model listing (Nano Banana / Nano Banana Pro
family). Inputs can come from file paths, raw base64 / data URIs, a public YouTube
URL (video→image), or the macOS clipboard. Video and music ride the **same
Interactions endpoint** as `gemini_interact` — the tool naming is media-first
(`gemini_<media>_<action>`). Realtime Lyria (WebSocket) is intentionally
**not** implemented (see the video/music design spec).

Auth is a Google **API key** (`GEMINI_API_KEY`) sent in the `x-goog-api-key`
header — Gemini does **not** use `Authorization: Bearer`. Because the model is
baked into the URL path (`/models/{model}:generateContent`) rather than the body,
this is the bearer/direct-API archetype with a custom twist: a thin `call()`
wrapper over the fleet-shared `createApiClient` (configured with a non-Bearer
`tokenHeader`), not a hand-rolled fetch and not a stock Bearer client.

## Environment

```
GEMINI_API_KEY=<key>        # Required. Create at https://aistudio.google.com/apikey
GEMINI_IMAGE_MODEL=<id>     # Optional. Default model override (bare id, e.g. gemini-3.1-flash-image)
GEMINI_OUTPUT_DIR=<dir>     # Optional. Where generated images are written (default: cwd)
GEMINI_INPUT_DIR=<dir>      # Optional. Base dir searched for relative input image paths
GEMINI_TIMEOUT_MS=<ms>      # Optional. Upstream timeout (default 60000; 120000 for 4K; per-call timeout_ms wins)
GEMINI_HEARTBEAT_MS=<ms>    # Optional. notifications/progress cadence during generation (default 10000; 0 disables)
GEMINI_DEBUG=<any>          # Optional. When set, emit heartbeat diagnostics to stderr (see Quirks). Off by default.
```

Loaded via `loadDotenvSafely` from `.env` next to `dist/` (failure swallowed —
mcpb bundles omit `dotenv`; the host provides env). `readEnvVar` (from
`@chrischall/mcp-utils`) treats blank, `"undefined"`, `"null"`, and unsubstituted
`${FOO}` placeholders as unset. All but `GEMINI_HEARTBEAT_MS` and `GEMINI_DEBUG`
map to `manifest.json`'s `user_config` (`gemini_api_key`, `gemini_image_model`,
`gemini_input_dir`, `gemini_output_dir`, `gemini_timeout_ms`).

## Architecture

```
src/
  index.ts        # entry — runMcp({ name, version, banner, tools: [register*Tools…] })
                  #   from @chrischall/mcp-utils; connects stdio transport
  version.ts      # VERSION const (// x-release-please-version)
  client.ts       # GeminiClient — module-level singleton `client`; builds two
                  #   createApiClient instances (generateContent + Interactions);
                  #   exposes call(), listModels(), generate(), interact(),
                  #   generateVideo(), generateMusic() — the last three share
                  #   postInteraction() (POST + 404-retry) + extractInteraction()
                  #   (steps→image/video/audio media)
  models.ts       # DEFAULT_IMAGE_MODEL, resolveModel() (per-call → env → default),
                  #   filterImageModels() (keep *image* models, drop imagen-*)
  images.ts       # input loading (paths/base64/data-URI, MIME sniff, clipboard
                  #   aggregation) + output writing (slugify, uniquePath, writeImage,
                  #   resolveOutputDir, resolveImagePath)
  clipboard.ts    # readClipboardImage() — macOS-only osascript+sips clipboard grab
  sidecar.ts      # readSidecars()/findInteractionImages()/latestInteractionId() —
                  #   reads the <image>.json sidecars as an on-disk chain index;
                  #   backs both chain recoveries in tools/interact.ts. Never throws
                  #   (missing dir / malformed JSON are skipped) — recovery is
                  #   best-effort and must not fail a recoverable call
  jobs.ts         # in-memory per-process job registry: dispatch() dedups
                  #   in-flight/keyed identical generation calls (idempotency #53)
                  #   and backs async job handles (#52); fingerprintRequest(),
                  #   getJobResult(), __resetJobRegistry() (test-only)
  tools/
    models.ts     # gemini_list_models                       (registerModelTools)
    generate.ts   # gemini_image_generate, gemini_image_edit (registerGenerateTools)
    set.ts        # gemini_image_set                       (registerSetTools)
    interact.ts   # gemini_interact                           (registerInteractTools)
    video.ts      # gemini_video_generate (omni, Interactions) (registerVideoTools)
    music.ts      # gemini_music_generate (Lyria, Interactions) (registerMusicTools)
    jobs.ts       # gemini_get_result (async poll)            (registerJobTools)
    shared.ts     # ASPECT_RATIOS, IMAGE_SIZES, sharedImageSchema, pickSeed,
                  #   buildMeta, and emit() (inline-vs-write-to-disk result wrapper)

tests/            # vitest, 1:1-ish mirror of src/ + tools/. fetch is mocked
                  #   (fetchImpl injected into GeminiClient); clipboard uses an
                  #   injectable Runner so tests never shell out. server-boot.test.ts
                  #   asserts the server boots without GEMINI_API_KEY;
                  #   version-sync.test.ts asserts all version files agree.
```

Each `tools/*.ts` exports a `register<Name>Tools(server)` function that calls
`server.registerTool(name, { description, annotations, inputSchema }, handler)`
(high-level `McpServer` API with zod schemas). The tool handlers import the
shared `client` singleton directly — `index.ts` only wires the `register*` list
into `runMcp`.

### The custom `call()` client

`GeminiClient` constructs **two** `createApiClient` instances sharing
`{ tokenHeader: 'x-goog-api-key', getToken, timeout: 60_000, fetchImpl }`:

- `this.api` — plain client for `:generateContent` and `GET /models`.
- `this.interactionsApi` — same base URL/config; exists so errors name the
  Interactions API. (The beta-era `Api-Revision` header was dropped when the
  API went GA — verified 2026-07-06.)

`call<T>(method, path, body?)` is the thin wrapper: it just forwards to
`this.api.fetchJson(...)`. The model id is interpolated into `path`
(`/models/${model}:generateContent`), which is why it isn't `createApiClient`'s
default Bearer flow on its own — but the auth/timeout/retry plumbing is still the
shared util, configured non-Bearer.

## Tool surface

| Tool | File | Endpoint / model | Kind |
| --- | --- | --- | --- |
| `gemini_list_models` | `tools/models.ts` | `GET /v1beta/models?pageSize=200` (filtered to image models) | read |
| `gemini_image_generate` | `tools/generate.ts` | `POST /v1beta/models/{model}:generateContent` (×`count`) | write (binary-out) |
| `gemini_image_edit` | `tools/generate.ts` | `POST /v1beta/models/{model}:generateContent` (input images required) | write (binary-out) |
| `gemini_image_set` | `tools/set.ts` | `POST …:generateContent` ×N (master + scenes; `master`/`chain` ref mode) | write (binary-out) |
| `gemini_interact` | `tools/interact.ts` | `POST /v1beta/interactions` (GA since 2026-07) | write (binary-out) |
| `gemini_video_generate` | `tools/video.ts` | `POST /v1beta/interactions` (omni, `response_format: video`, preview) | write (binary-out, MP4→disk) |
| `gemini_music_generate` | `tools/music.ts` | `POST /v1beta/interactions` (Lyria, `response_format: audio`, preview) | write (binary-out, MP3/WAV) |
| `gemini_get_result` | `tools/jobs.ts` | none (reads the in-memory job registry) | read |

**Video & music reuse the interact plumbing.** `gemini_video_generate` (omni) and
`gemini_music_generate` (Lyria) ride the **same `/v1beta/interactions` endpoint**
as `gemini_interact`. `client.generateVideo()` / `generateMusic()` build their own
`response_format` (`video` / `audio`) but share `postInteraction()` (POST +
chained-404 retry) and `extractInteraction()` (steps → image/video/audio media,
snake/camel-tolerant). Output goes through `emitMedia()` (in `tools/shared.ts`) →
`writeMedia()` (MIME→extension); **video is disk-only** (MCP has no video content
block, so an `inline` request is downgraded + noted), audio supports inline
(`type:'audio'`). Both models are **preview** (funded account required) and their
shapes are docs-derived, not live-verified — hence the tolerant parsing. Realtime
Lyria (WebSocket) is intentionally out (see `docs/superpowers/specs/…-video-music-tools-design.md`).

**Binary output.** The image generation tools return images either written to disk
(default) or inline base64. `emit()` (in `tools/shared.ts`) decides: with
`inline: true` it returns `{ type: 'image', data, mimeType }` content blocks;
otherwise it `writeImage()`s each to `resolveOutputDir(output_dir)` (per-call
`output_dir` → `$GEMINI_OUTPUT_DIR` → cwd), de-duplicating with `uniquePath`
(`name.png`, `name-2.png`, …), and returns the absolute paths plus a metadata
object (`model`, `seed`, a `hint` steering iterative refinement to
`gemini_interact`, optional `text`, `grounding`, `interaction_id`,
`previous_interaction_id`, and — on timeout-prone configs (Pro model / 4K /
multi-image) — a `timeout_risk` note pointing at Flash / disk recovery, from
`timeoutRiskHint`; plus `reused: true` + `reused_job_id` when the call was served
from an existing job instead of billing a fresh generation — see Idempotency).
`gemini_interact` also accepts `continue_last: true`
to chain from the server process's most recent interaction id (in-memory;
explicit `previous_interaction_id` wins), and in disk mode writes an
`<image>.json` sidecar carrying the result meta so the interaction id survives
a host-side timeout (see Quirks).

**Chain recovery is automatic (both directions).** Sidecars are an on-disk index
of the chain (`sidecar.ts`), and `gemini_interact` recovers from them rather than
telling the caller to redo the turn: `continue_last` with no in-memory id falls
back to the newest sidecar (`continued_from_sidecar: true`) — a server restart
doesn't end a chain that's alive upstream; and a `ChainNotFoundError` (the
exhausted-retries 404, now its own class in `client.ts` so it's discriminable by
type, carrying `previousInteractionId`) is caught in the tool, which looks up
*that id's* sidecar, re-attaches the image it produced, and re-issues un-chained
(`chain_recovered: { expired_interaction_id, reanchored_on }`). Match by id only
— never "the newest image"; re-anchoring on the wrong picture silently corrupts
the edit, so no matching sidecar means rethrow, not guess. The 404'd attempt
generates nothing, so recovery costs one generation, not two. Video/music still
surface the error for manual recovery (they don't write sidecars). On a *chained* interact call, `images`
entries that resolve to files this server itself generated are dropped and
echoed as `dropped_previous_output` — the interaction state already contains
the prior output, and re-attaching it anchors the model against the edit.
(Un-chained calls pass such paths through: starting a new interaction from an
old output is legitimate.)

**Idempotency** (`jobs.ts`, issue #53). Every generation tool routes its handler
body (after the confirm-gate) through `dispatch()`, which keys an in-memory
per-process job registry by `fingerprintRequest()` (sha256 of the request
identity — resolved model, prompt, image params, input digests — **excluding**
the server-picked seed and output path) and an optional `idempotency_key`. Two
levels of dedup, chosen to never break intentional same-prompt *variations*:
**in-flight** — a second identical request while the first is still running
attaches to it (a host-timeout retry race, never a deliberate variation); and
**recently-completed** — only unlocked by an explicit `idempotency_key`, returns
the recorded result for `JOB_TTL_MS` (10 min). Either way the reused result is
annotated `reused: true` + `reused_job_id`, and no second upstream (billable)
call is made. Failed jobs are not reused. Registry is bounded (TTL + `JOB_MAX`);
`__resetJobRegistry()` clears it between tests.

**Async job handle** (`jobs.ts`, issue #52). The same registry backs an async
escape hatch for hosts whose tools/call timeout can't be tamed (Claude Desktop).
Any generation tool called with `async: true` returns a `{ job_id, status:
'running' }` handle *immediately* — no upstream wait, so no `-32001` — and the
work continues in the background. The caller polls **`gemini_get_result`**
(`registerJobTools`) with the `job_id`: `running` → status handle; `done` → the
recorded result payload (image paths / inline + meta); `failed` → the recorded
error; unknown/expired → an actionable error pointing at the output dir /
sidecar. `async` composes with idempotency (an `async` call that dedups returns
the matching job's id). `dispatch()` (in `jobs.ts`) is the one seam that owns
sync-vs-async and all dedup.

**Image inputs** (`gatherImageInputs`) come from `images` (file paths),
`images_base64` (raw base64 or `data:` URIs, MIME sniffed from bytes), and
`from_clipboard` (macOS only — see Quirks, issue #13). `gemini_image_edit`
requires at least one input source.

**Video inputs** (`gemini_image_generate` / `gemini_interact`): `video_url`
(public YouTube URL, or a previously uploaded `files/…` uri) or `video_path`
(local file). A `video_path` goes through `resolveVideoInput` (`tools/shared.ts`):
resolve the path, `client.uploadVideo()` to the Files API (resumable protocol,
streamed from disk via `fileBlob`/`fs.openAsBlob` — never buffered), poll
`PROCESSING`→`ACTIVE`, then reference the returned uri. The uploaded file
(uri/name/expiry, ~48h TTL, 2 GB cap) is echoed as `video_file` in the result
meta so callers can reuse the uri. Both video params together is an error.

**`google_search`** grounds generation in live Google Search; surfaced sources
(`generateContent`) or queries (`interact`) are echoed in the result metadata.
`gemini_interact` additionally accepts `search_types: ["web_search","image_search"]`
(implies google_search; `image_search` is 3.1-Flash-only and pulls web images as
visual references). When `image_search` is requested, the result's
`grounding.search_suggestions` HTML chips are surfaced — Google ToS require the
caller to display them. `search_types` is Interactions-only; don't add it to
`generateContent`'s `{google_search:{}}` without live-verifying.

## Conventions

- All tools prefixed `gemini_*`.
- **TDD.** Write a failing test before implementation. `fetch` is mocked by
  injecting `fetchImpl` into `GeminiClient`; clipboard via an injectable `Runner`.
  No real API calls and no real shell-outs in tests.
- **Errors.** Throw `McpToolError` (from `@chrischall/mcp-utils`) with an
  actionable `hint` (e.g. missing key → aistudio link; no image returned → "try
  rephrasing, safety filter"). HTTP error *bodies* are redacted and truncated for
  you — `createApiClient.fetchJson` runs `truncateErrorMessage` (Bearer/JWT
  redaction THEN length cap) on the response text before throwing. Don't hand-roll
  body trimming.
- **Result wrapper.** Use `emit()` / `textResult()`; don't hand-roll `content`
  arrays. `emit()` owns the inline-vs-disk branch.
- **Binary-output-to-disk is NOT confirm-gated.** Writing a generated image is a
  *local* file write, not a remote mutation, so there's no confirmation token /
  `readOnlyHint`-style gate. (Generation tools set `readOnlyHint: false` only
  because they call a paid remote API, not because they touch remote state.)
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- **stdio transport**: logs/banner go to **stderr** only — stdout is reserved for
  JSON-RPC. `runMcp` handles this.

## Quirks

- **Non-Bearer auth.** The key rides the `x-goog-api-key` header, configured via
  `createApiClient`'s `tokenHeader`. Do not switch to `Authorization: Bearer` —
  Gemini ignores it and the request 401s.
- **Model in the URL path.** `…/models/${model}:generateContent`. The `model`
  input is regex-validated (`/^[\w.-]+$/`, bare id only) precisely so a crafted
  value with slashes/colons/queries can't escape the path segment. Keep that guard.
- **v1beta, not v1.** `BASE_URL` is pinned to `/v1beta` because `v1` lacks
  `gemini-3-pro-image` (confirmed in source). Don't "upgrade" it to `/v1`.
- **Two APIs, two request shapes.**
  - `generateContent` (generate/edit/set): snake_case request parts
    (`inline_data.mime_type`, `file_data.file_uri`, `tools: [{ google_search: {} }]`)
    but a `generationConfig` in camelCase (`responseModalities`, `imageConfig`,
    `thinkingConfig`).
  - `interactions` (interact): a different body entirely — `input` parts typed
    `{ type: 'text' | 'image' | 'video' }`, `response_format`,
    `previous_interaction_id`, and a `steps[]` response. Only the `model_output`
    step is surfaced; `thought` steps (internal reasoning / draft images) are
    dropped on purpose.
- **Response casing is defensive.** `generateContent` responses are read tolerant
  of both `inline_data`/`mime_type` (snake) and `inlineData`/`mimeType` (camel) —
  the beta has shipped both. Preserve the `part.inline_data ?? part.inlineData`
  fallbacks.
- **`Api-Revision` header is gone.** The beta Interactions API required
  `Api-Revision: 2026-05-20`; the GA API works without it (verified live
  2026-07-06; see `docs/GEMINI-API.md`). Don't re-add a pinned revision — it
  would freeze the client on old semantics.
- **Premium endpoints need a funded account.** `gemini-3-pro-image` and the
  Interactions API are paid; a free-tier key gets HTTP 429 with `limit: 0` (a
  quota-of-zero, not real throttling). Verify response shapes against a funded key
  before trusting them.
- **60s timeout (not the fleet 15–30s), configurable.** Pro-model image
  generation routinely runs 30s+, so the default is 60s — and 4K output
  routinely runs past 60s, so its default is 120s. `resolveTimeoutMs()`
  (client.ts) resolves per-call `timeout_ms` → `$GEMINI_TIMEOUT_MS` → those
  defaults at request time; `apisFor()` memoizes a `createApiClient` pair per
  distinct timeout. The shared client retries 429 once after 2s (mcp-utils
  default) — the free tier rate-limits aggressively.
- **The host's timeout is not ours: heartbeat + sidecar recovery.** MCP hosts
  enforce their own `tools/call` timeout (`-32001 Request timed out`) but reset
  it on `notifications/progress` — so every generation tool emits a heartbeat
  (`withProgressHeartbeat`, `tools/shared.ts`, every `$GEMINI_HEARTBEAT_MS`,
  default 10s) while the upstream call is in flight, when the caller sent a
  `progressToken`. If the host still gives up, the handler keeps running (it
  ignores the cancellation signal): the image is written, `lastInteractionId`
  updates (so `continue_last: true` survives the timeout), and `gemini_interact`
  writes an `<image>.json` sidecar with the interaction id — the multi-turn
  chain is recoverable from disk even though the MCP response was lost.
  - **The heartbeat only works if the host cooperates.** It fires solely when the
    caller sent a `progressToken`, and even then it only *extends* the host's
    timeout if the host resets its clock on `notifications/progress`
    (`resetTimeoutOnProgress`). **Claude Desktop does neither reliably** and
    exposes no per-server timeout knob (unlike Claude Code's `MCP_TOOL_TIMEOUT`
    env), so under Desktop a long generation hits Desktop's fixed ~30s ceiling
    regardless of heartbeats — sidecar recovery (above) is the mitigation there,
    not the heartbeat. Set **`GEMINI_DEBUG=1`** to emit stderr diagnostics
    (`[gemini-mcp] heartbeat active|inactive: …`, surfaced in
    `~/Library/Logs/Claude/mcp-server-*.log`) that reveal whether the host sent a
    `progressToken` at all — the root-cause signal. Don't add a leading/faster
    heartbeat to "fix" a host that ignores progress: if it ignores progress, more
    progress changes nothing.
- **`from_clipboard` is macOS-only (issue #13).** `readClipboardImage` shells out
  to `osascript` (clipboard PNG → temp file) then `sips` (downscale ≤2048px →
  JPEG); non-darwin throws an actionable `McpToolError`. The clipboard module is
  dynamically imported only when `from_clipboard` is set, keeping `child_process`
  off the default path.
- **The Files API upload is raw `fetch`, not `createApiClient`.** The resumable
  upload's start step returns the session URL in a *response header*
  (`x-goog-upload-url`, empty body) and the finalize step posts a binary Blob —
  neither fits `fetchJson`. The finalize response wraps the File in `{file:…}`;
  the GET poll returns it **unwrapped** (verified; see `docs/GEMINI-API.md`).
  The session URL is self-authorizing (no api-key header on finalize). The
  PROCESSING→ACTIVE poll goes through the shared client.
- **`imagen-*` excluded.** `filterImageModels` keeps Gemini image models but drops
  `imagen-*` — those use a different `:predict` API this server doesn't implement.

## Versioning

`VERSION` lives in `src/version.ts` (`// x-release-please-version`). release-please
owns the bump and keeps these in sync via `extra-files` in
`release-please-config.json`:

1. `package.json` → `"version"` (release-type `node`)
2. `package-lock.json` → kept in sync by release-please's node handler
3. `src/version.ts` → `VERSION` const
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[*].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[*].version`

`.release-please-manifest.json` tracks the last released version. `tests/version-sync.test.ts`
fails CI if any of the files above drift apart.

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`,
authed with `RELEASE_PAT` so the release PR triggers downstream CI) opens/updates a
release PR as Conventional-Commit messages (`feat:`, `fix:`, …) accumulate. Merging
that PR creates the `v<VERSION>` tag + GitHub Release; the `publish` job then builds,
packs a `.skill` zip + `.mcpb` bundle, `npm publish --provenance` (idempotent — skips
if the version is already on npm), and publishes to the MCP Registry via
`mcp-publisher` (OIDC).

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks.
release-please owns versioning.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
caps `server.json`'s `description` at **100 characters**. Over that fails
`mcp-publisher publish` with HTTP 422. The other description fields
(`manifest.json`, `.claude-plugin/*`) have no published length cap. Sanity-check
before changing it:

```bash
jq -r '.description | length' server.json
```

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

## What not to do

- **Don't env-configure your way around billing.** Premium models / the
  Interactions API require a funded Google account; a free key returns 429
  `limit: 0`. Don't paper over that with retries or fallbacks — surface the
  actionable error.
- **Don't trust premium endpoint shapes you haven't seen.** Verify
  `gemini-3-pro-image` and Interactions response shapes against a funded account
  before relying on new fields; the beta casing has changed before (hence the
  snake/camel fallbacks).
- **Don't switch to `Authorization: Bearer`** — Gemini ignores it and requests
  401. (The Interactions `Api-Revision` header is history: required in beta,
  dropped at GA.)
- **Don't "upgrade" `BASE_URL` to `/v1`** — it lacks the Pro image model.
- **Don't register tools that can't be tested against a mocked `fetchImpl`** (and a
  mocked clipboard `Runner`). All network/shell access must be injectable.
- **Don't bump versions speculatively.** release-please owns that.
