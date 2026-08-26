# CLAUDE.md — gemini-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.6.0: Google **Gemini** image-generation MCP server. Wraps the Generative
Language REST API (`https://generativelanguage.googleapis.com/v1beta`) and
exposes 11 tools to Claude over stdio: text→image and image→image generation,
multi-turn conversational editing, consistent image *sets*, **video generation**
(omni, `gemini_video_generate`), **music generation** (Lyria clips/pro,
`gemini_music_generate`), model listing (Nano Banana / Nano Banana Pro
family), and **Files API** upload/list/delete. Reference images can come from an
https URL the *server* fetches (`images_url`), a Files API reference
(`images_file_uris`), local file paths, raw base64 / data URIs, or the macOS
clipboard; video from a public YouTube URL or a local upload. Video and music ride the **same
Interactions endpoint** as `gemini_interact` — the tool naming is media-first
(`gemini_<media>_<action>`). Realtime Lyria (WebSocket) is intentionally
**not** implemented (see the video/music design spec).

A hosted deployment additionally serves: `gemini_get_upload_url` (signed PUT
upload URLs — zero-auth-header uploads from a shell), a persistent per-account
character/style library (`gemini_save/list/delete_character`/`_style`, applied
via `characters`/`style` params on the generation tools), `images_r2_keys`
inputs, `max_wait_ms` wait-then-hand-off on generation tools, and a `bundle_url`
zip on multi-image `gemini_image_set` results.

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
GEMINI_CHAIN_RETRY_MS=<ms>  # Optional. How long to wait out interactions-store lag on a chained 404 (default 120000; 0 disables retrying)
GEMINI_DEBUG=<any>          # Optional. When set, emit heartbeat diagnostics to stderr (see Quirks). Off by default.
```

Loaded via `loadDotenvSafely` from `.env` next to `dist/` (failure swallowed —
mcpb bundles omit `dotenv`; the host provides env). `readEnvVar` (from
`@chrischall/mcp-utils`) treats blank, `"undefined"`, `"null"`, and unsubstituted
`${FOO}` placeholders as unset. All but `GEMINI_HEARTBEAT_MS`, `GEMINI_DEBUG` and
`GEMINI_CHAIN_RETRY_MS` map to `manifest.json`'s `user_config` (`gemini_api_key`,
`gemini_image_model`, `gemini_input_dir`, `gemini_output_dir`,
`gemini_timeout_ms`).

## Architecture

```
src/
  index.ts        # stdio entry — loadStdioDotenv(), then runMcp({ name, version,
                  #   banner, tools: [register*Tools…] }) from @chrischall/mcp-utils
  dotenv.ts       # loadStdioDotenv() — the `.env` bootstrap. Imported ONLY by
                  #   index.ts: it uses import.meta.url + async I/O, which crash
                  #   some runtimes at startup (see Quirks)
  version.ts      # VERSION const (// x-release-please-version)
  client.ts       # GeminiClient — module-level singleton `client`; builds two
                  #   createApiClient instances (generateContent + Interactions);
                  #   exposes call(), listModels(), generate(), interact(),
                  #   generateVideo(), generateMusic(), getInteraction() — the
                  #   media three share postInteraction() (POST + 404-retry +
                  #   diagnosis + background poll) + extractInteraction()
                  #   (steps→image/video/audio media, inline OR Files-API uri)
  models.ts       # DEFAULT_IMAGE_MODEL, resolveModel() (per-call → env → default),
                  #   filterImageModels() (keep *image* models, drop imagen-*)
  images.ts       # disk I/O + decoding primitives: readImageAsInline,
                  #   decodeImageInput (MIME sniff), writeMedia/writeImage,
                  #   slugify, uniquePath, resolveOutputDir, resolveImagePath.
                  #   NOT an input funnel — inputs.ts is (see below)
  bytes.ts        # base64 <-> Uint8Array + MB formatting. atob/btoa, never
                  #   Buffer, which is not everywhere; bytesToBase64
                  #   CHUNKS (String.fromCharCode(...bytes) blows the argument
                  #   limit on the first real photo)
  inputs.ts       # resolveImageInputs() — THE funnel: paths / base64 / images_url /
                  #   images_file_uris / clipboard → one ImageInput[]. Owns the
                  #   fetch-once-per-call dedup, the >6MB → Files API promotion, and
                  #   the stdio "referenced twice → upload once" cache
  fetch-image.ts  # fetchRemoteImage() — server-side URL fetch for images_url.
                  #   https-only, private/loopback/link-local refused, EVERY redirect
                  #   hop revalidated, streamed byte cap. Pure; no module-scope I/O
  clipboard.ts    # readClipboardImage() — macOS-only osascript+sips clipboard grab
  storage/media.ts# MediaSink — where generated media goes. createDiskSink()
                  #   (stdio: resolveOutputDir + writeMedia, unchanged) and
                  #   createR2Sink() (hosted: object put → signed URL). `persistsFiles`
                  #   is the capability flag every disk-only feature gates on
  signed-url.ts   # THE shape of a link into the object store — signedObjectUrl()
                  #   + signedLinks(base) binding media GET and upload PUT to ONE
                  #   base. buildMediaUrl/buildUploadUrl both delegate here; the
                  #   blob store hands the same `links` object to the sink and
                  #   the minter, so a re-host can't move one and not the other
  media-url.ts    # HMAC signing/verification for /media links + the zero-config
                  #   secret (MEDIA_URL_SECRET else generated once into OAUTH_KV)
  upload-url.ts   # signed PUT upload URLs: sign/verify (same secret as /media,
                  #   DIFFERENT payload shape so signatures can't cross
                  #   protocols) + createUploadUrlMinter (10-min TTL, keys
                  #   up/<tenant>/…). Backs gemini_get_upload_url. Throws at
                  #   CONSTRUCTION with no links/baseUrl — mint is pure crypto,
                  #   so a failure can never leave partial state
  errors.ts       # describeError() (flattens the cause chain MCP drops), step()
                  #   (labels the failing operation) and surfaceToolErrors()
                  #   (wraps a server so every handler throw names the tool and
                  #   the real error). index.ts applies it to every registrar
  library.ts      # per-account character/style library under lib/<tenant>/ in
                  #   R2 — records + copied image bytes, NO expiry (cleanup
                  #   skips lib/). createR2Library; gates the library tools
  zip.ts          # STORE-only zip writer (crc32) — bundles a multi-image set
                  #   into the one-curl bundle_url. Pure, runtime-agnostic
  sidecar.ts      # readSidecars()/findInteractionImages()/latestInteractionId() —
                  #   reads the <image>.json sidecars as an on-disk chain index;
                  #   backs both chain recoveries in tools/interact.ts. Never throws
                  #   (missing dir / malformed JSON are skipped) — recovery is
                  #   best-effort and must not fail a recoverable call
  job-store.ts    # DURABLE job records over the blob store (jobs/<tenant>/…) —
                  #   what makes a job survive the hosted machine stopping.
                  #   Heartbeat + executor-lost rule; best-effort, never throws.
                  #   Carries `interactionId` — the one field that buys back the
                  #   OUTPUT of a killed generation (see Recovery below)
  jobs.ts         # JobRegistry — in-memory job store, ONE PER SESSION (never a
                  #   module global): dispatch() dedups in-flight/keyed identical
                  #   generation calls (idempotency #53) and backs async job
                  #   handles (#52); getResult(); plus fingerprintRequest() (pure)
  session.ts      # SessionState — ALL per-user memory: the JobRegistry,
                  #   lastInteractionId (+ music/video), writtenOutputs. Hangs
                  #   off GeminiClient as `client.session`. src/ holds no
                  #   module-level mutable state (see Quirks)
  tools/
    models.ts     # gemini_list_models                       (registerModelTools)
    generate.ts   # gemini_image_generate, gemini_image_edit (registerGenerateTools)
    set.ts        # gemini_image_set                       (registerSetTools)
    interact.ts   # gemini_interact                           (registerInteractTools)
    video.ts      # gemini_video_generate (omni, Interactions) (registerVideoTools)
    music.ts      # gemini_music_generate (Lyria, Interactions) (registerMusicTools)
    jobs.ts       # gemini_get_result (async poll + interaction (registerJobTools)
                  #   recovery for a job whose executor was lost)
    files.ts      # gemini_upload_file / _list_files / _delete_file (registerFileTools)
    library.ts    # gemini_save/list/delete_character + _style (registerLibraryTools)
                  #   — self-gates on client.library (hosted only)
    uploads.ts    # gemini_get_upload_url                    (registerUploadUrlTools)
                  #   — self-gates on client.uploadUrls (hosted only)
    shared.ts     # ASPECT_RATIOS, IMAGE_SIZES, ORIENTATIONS +
                  #   resolveAspectRatio() (landscape/portrait/square shorthand;
                  #   an explicit aspect_ratio always wins, an orientation the
                  #   model can't produce is REFUSED not rounded),
                  #   sharedImageSchema, pickSeed, buildMeta,
                  #   reportShape() (the resolved shape, echoed into ANY meta —
                  #   shared with the hand-rolled interact/video metas), and
                  #   emit() (inline-vs-write-to-disk result wrapper)

tests/            # vitest, 1:1-ish mirror of src/ + tools/. fetch is mocked
                  #   (fetchImpl injected into GeminiClient); clipboard uses an
                  #   injectable Runner so tests never shell out. server-boot.test.ts
                  #   asserts the server boots without GEMINI_API_KEY;
                  #   version-sync.test.ts asserts all version files agree.
```

Each `tools/*.ts` exports a `register<Name>Tools(server, client)` function that
calls `server.registerTool(name, { description, annotations, inputSchema },
handler)` (high-level `McpServer` API with zod schemas).

**The registrars are transport-neutral: the client is injected, never imported.**
Every `tools/*.ts` imports only the *type* (`import type { GeminiClient }`) and
takes the client as its second argument, so a non-stdio entry point can build one
client **per authenticated user** (their own API key) instead of sharing the
env-driven process singleton. `src/index.ts` — the stdio entry point — passes the
`client` singleton via `runMcp`'s `deps`, which threads it to every registrar;
that is the only place in `src/tools/` reachable from a `client` *value* import.
Keep it that way: don't re-add `import { client }` to a tool module, and thread
the client through helpers (`resolveVideoInput` in `tools/shared.ts` takes it as
a parameter for exactly this reason).

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
| `gemini_image_set` | `tools/set.ts` | `POST …:generateContent` ×N (master + scenes; `master`/`chain` ref mode; a failed scene is reported in `failed_scenes`, never thrown — N billed successes must not be lost to one failure) | write (binary-out) |
| `gemini_interact` | `tools/interact.ts` | `POST /v1beta/interactions` (GA since 2026-07) | write (binary-out) |
| `gemini_video_generate` | `tools/video.ts` | `POST /v1beta/interactions` (omni, `response_format: video`, preview) | write (binary-out, MP4→disk) |
| `gemini_music_generate` | `tools/music.ts` | `POST /v1beta/interactions` (Lyria, `response_format: audio`, preview) | write (binary-out, MP3/WAV) |
| `gemini_get_result` | `tools/jobs.ts` | none, until a killed job needs recovering — then `GET /v1beta/interactions/{id}` + a media download | read (writes recovered media) |
| `gemini_upload_file` | `tools/files.ts` | `POST /upload/v1beta/files` (resumable) | write |
| `gemini_list_files` | `tools/files.ts` | `GET /v1beta/files?pageSize=N` | read |
| `gemini_delete_file` | `tools/files.ts` | `DELETE /v1beta/files/{id}` | write (confirm-gated) |
| `gemini_sign_media` | `tools/files.ts` | none (re-signs an R2 key via `mediaSink.resign`) — **hosted deployments only**, not registered on disk sinks | read |
| `gemini_list_recent_media` | `tools/files.ts` | none (lists `gen/<tenant>/` via `mediaSink.listRecent`) — **hosted only** | read |
| `gemini_get_upload_url` | `tools/uploads.ts` | none (mints a signed `PUT /put/<key>` URL, ~10 min TTL) — **hosted only**, gated on `client.uploadUrls` | read |
| `gemini_save_character` / `gemini_list_characters` / `gemini_delete_character` | `tools/library.ts` | R2 `lib/<tenant>/characters/…` (no expiry) — **hosted only**, gated on `client.library`; delete confirm-gated | write / read / write |
| `gemini_save_style` / `gemini_list_styles` / `gemini_delete_style` | `tools/library.ts` | R2 `lib/<tenant>/styles/…` (no expiry) — **hosted only** | write / read / write |

**The signed upload URL assumes a shell.** `gemini_get_upload_url` hands back a
curl line, which is no use to a Claude *mobile* user — and MCP has no
client→server file channel to fall back on (form elicitation is primitive-typed
only; an attached photo reaches the model as vision tokens, not bytes it can
re-emit). `docs/MOBILE-UPLOADS.md` records what was ruled out and on what
evidence, and the routes that are open. Nothing there is implemented — read it
before re-deriving it.

**Video & music reuse the interact plumbing.** `gemini_video_generate` (omni) and
`gemini_music_generate` (Lyria) ride the **same `/v1beta/interactions` endpoint**
as `gemini_interact`. `client.generateVideo()` / `generateMusic()` build their own
`response_format` (`video` / `audio`) but share `postInteraction()` (POST +
chained-404 retry) and `extractInteraction()` (steps → image/video/audio media,
snake/camel-tolerant). Output goes through `emitMedia()` (in `tools/shared.ts`) →
`writeMedia()` (MIME→extension); **video is disk-only** (MCP has no video content
block, so an `inline` request is downgraded + noted), audio supports inline
(`type:'audio'`). Both models are **preview** (funded account required). The
**video** path was verified live 2026-08-22 (omni generated a 10s MP4; the
`delivery: 'inline'` we send is a real enum value, and `uri` delivery works too);
the **music** shapes are still docs-derived — hence the tolerant parsing stays.
Realtime Lyria (WebSocket) is intentionally out (see `docs/superpowers/specs/…-video-music-tools-design.md`).

**What that probe settled, and what now ships** (details in
`docs/GEMINI-API.md`): `delivery` is schema-valid for image/audio/video but
**implemented for video only** — don't add a `delivery` param to the image or
music tools, even though the `@google/genai` type definitions declare one.
`generateVideo` therefore sends `delivery: 'uri'` by default and downloads the
bytes itself: the link needs `x-goog-api-key` (403 without), so a uri result is
NOT shareable — it only lifts the ~4MB inline ceiling. A model that rejects
`delivery` gets one free re-issue without the field (that 400 generated
nothing). `background: true` is accepted by **omni and Lyria but NOT by image
models** — and accepting it is not the same as being able to collect the
result: polling answers `403` while the work is in flight, and two of three
backgrounded video interactions then settled into a permanent `400` and were
never retrievable (billed, unreachable). So it is **opt-in and never the
default**; the poll runs **in band**, bounded by the caller's timeout — the
machine-stops rule below still forbids answering early and working on — treats
403/404 polls as "keep waiting", and **names the interaction id** if the wait
runs out, because the generation continues (and bills) upstream regardless.

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

**A chained 404 is not a diagnosis.** The only 404 body observed live is generic
(`"Requested entity was not found."`) and never names which entity — an unknown
model id and an expired `files/…` uri (~48h TTL) return the same thing. The old
code relabelled *any* 404 on a request that merely carried a
`previous_interaction_id` as "previous interaction not found", burying the
upstream text in `cause` (which MCP serialization drops). That fabricated a cause
and hid the real one. `ChainedRequest404Error` (client.ts) is named for what is
actually known — a chained request returned 404 — and carries `upstreamMessage`
in its *message*, not just a `hint`. **Don't reintroduce a confident verdict
here, and don't put remediation only in `hint`** — the host shows the message and
drops the hint. What the client *may* now assert is what it asked: once the
store-lag budget is spent, `diagnoseChain()` GETs the id and records
`chainExists` — `false` (gone, or a malformed name), `true` (alive, so the
cause is the model id or a `files/…` uri), or **`undefined` when the probe
itself failed**. Keep those three distinct: "unknown" must never be rendered as
"gone".

**Recovery doubles as the probe that settles it.** Sidecars are an on-disk index
of the chain (`sidecar.ts`), so `gemini_interact` catches the
`ChainedRequest404Error`, looks up *that id's* sidecar, re-attaches the image it
produced, and re-issues **un-chained**. Succeeds → the chain was the cause, and
the caller still gets their image (`chain_recovered: { expired_interaction_id,
reanchored_on }`). 404s again → the id was never the cause, and the error says so
and points at the model id / `files/…` uri. Match by id only — never "the newest
image"; re-anchoring on the wrong picture silently corrupts the edit, so no
matching sidecar means rethrow, not guess. Neither 404 generates anything, so a
successful recovery costs one generation, not two.

Separately, `continue_last` with no in-memory id falls back to the newest sidecar
(`continued_from_sidecar: true`) — a server restart doesn't end a chain that's
alive upstream. Video/music still surface the error for manual recovery (they
don't write sidecars, so there's nothing to re-anchor on or probe with). On a *chained* interact call, `images`
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
the recorded result for `JOB_TTL_MS` (10 min) in memory, or
`DURABLE_JOB_REUSE_MS` (24h) from the durable store. Either way the reused
result is annotated `reused: true` + `reused_job_id`, and no second upstream
(billable) call is made. Failed jobs are not reused. Registry is bounded
(TTL + `JOB_MAX`); `client.session.reset()` clears it between tests.

**A durable replay is gated on the FINGERPRINT, not just the key.** The two
windows differ because they are bounded by different things — the in-memory one
by a process that no longer exists, the durable one only by storage retention
(~30 days). An `idempotency_key` is a habit as often as a promise (`"1"`,
`"test"`, `"retry"`), so replaying on the key alone would hand back a *different
prompt's* image weeks later and label it a cache hit. `durableByKey` therefore
requires `record.fingerprint === fingerprint` and an age inside
`DURABLE_JOB_REUSE_MS`; anything else is a genuinely new generation.

**The registry is per SESSION, not per process** — it lives at
`client.session.jobs` (`src/session.ts`). Hosted, one
isolate serves many authenticated sessions, so a module-level registry let user
B replay user A's result via a colliding `idempotency_key` ("1", "test") and
attach to A's in-flight billable job via `fingerprintRequest`. See Quirks.

**Recovery: durability buys the record, and now the OUTPUT — never the
execution.** A generation started with `background: true` (video/music only,
opt-in) reports its interaction id through `JobContext.reportInteraction` the
moment the API returns it — *not* when the job settles, because on a machine
that stops mid-generation the settle never happens. `JobRegistry.dispatch`
folds that id into the job's FIRST durable write (a report arriving
synchronously, before the entry exists, is held and merged rather than
dropped — that ordering was a real bug, caught by a test). When
`gemini_get_result` then finds a job whose executor was lost, it fetches that
interaction (`client.fetchInteractionMedia`) and re-hosts the media through
`emitMedia`, annotated `recovered_from_interaction`. Nothing is re-run and
nothing is re-billed. Two rules hold the honesty: a job with no id never
attempts recovery, and an interaction that cannot be read keeps the accurate
"was lost" error with the probe's failure appended — recovery must never turn
a real loss into a false success.

**Async job handle** (`jobs.ts`, issue #52). The same registry backs an async
escape hatch for hosts whose tools/call timeout can't be tamed (Claude Desktop).
Any generation tool called with `async: true` returns a `{ job_id, status:
'running' }` handle *immediately* — no upstream wait, so no `-32001` — and the
work continues in the background. The caller polls **`gemini_get_result`**
(`registerJobTools`) with the `job_id`: `running` → status handle; `done` → the
recorded result payload (image paths / inline + meta); `failed` → the recorded
error; unknown/expired → an actionable error pointing at the output dir /
sidecar. `async` composes with idempotency (an `async` call that dedups returns
the matching job's id). `JobRegistry.dispatch()` (in `jobs.ts`) is the one seam
that owns sync-vs-async and all dedup. A `job_id` from another session is simply
absent from this session's registry, so polling it takes the unknown-id path.

**Hosted on mcp-host.** The same stdio server runs as a child there; mcp-host
proxies MCP over streamable HTTP to claude.ai and wraps it in per-MCP OAuth, so
this repo has no Worker, no `createConnector`, and no HTTP surface of its own.

What the host DOES offer is a shared blob store — signed `PUT`/`GET`/`DELETE`
and a listing under `MCP_BLOB_BASE_URL`, authenticated by
`MCP_BLOB_SIGNING_KEY` (this registration's own derived key). `src/blob-store.ts`
adapts it to the structural bucket `createR2Sink` and `createR2Library` already
take, so neither learns storage moved. `hostedStorage()` in `client.ts` wires
the three things that need somewhere to put bytes — media sink, character/style
library, signed upload URLs — and returns nothing at all when the variables are
absent, which is how a local install falls back to the disk sink with those
tools unregistered.

Two things to keep right:

- **Signatures cover the FULL key** (`<account>/<slug>/<key>`), while this repo
  thinks in relative keys. `blob-store.ts` is the only place that knows the
  difference.
- **One base URL builds both link shapes.** `blobStoreFromEnv` exposes `links`
  (`src/signed-url.ts`), and `hostedStorage()` hands that same object to the
  media sink and the upload-URL minter. Take `links`, never a base-URL string:
  the re-host to mcp-host moved the media builder onto `/b/<registrationId>/`
  and left the upload builder holding its own base, which is a class of bug the
  shared object makes unrepresentable. `tests/upload-flow.test.ts` runs the whole
  mint → PUT → r2_key → generation loop against a signature-verifying fake
  gateway, and fails on exactly that split.
- **The gateway's PUT answers a bare 2xx.** The retired Worker's `/put` returned
  `201 { r2_key, size_bytes, … }`; the blob gateway does not. The `r2_key` a
  caller keeps is the one `gemini_get_upload_url` minted, and the content type
  is authenticated from the request **header** (`?ct=` is ours, and the gateway
  ignores it) — so a PUT without the exact `Content-Type` is a 403.
- **The machine stops whenever no request is in flight, and that is a
  correctness constraint, not a cost note.** The runner is a Fly machine with
  `auto_stop_machines = "stop"` / `min_machines_running = 0`; mcp-host's own
  docs put it as *"an open connection is exactly what stops the machine
  stopping"*. So an open request is what keeps this server ALIVE, and anything
  that answers immediately and keeps working in the background is racing a
  shutdown it will lose. This is why `async: true` is served here as a bounded
  in-band wait (`asyncWaitFallbackMs`, 4 min) rather than an immediate hand-off,
  and why `max_wait_ms` is the advice in every hint. Don't "optimise" a
  generation into a fire-and-forget background task.
- **Job records therefore live in the blob store, not just memory**
  (`src/job-store.ts`). A `running` record is heartbeated every 60s; a record
  whose stamp is older than 3 beats is read as `failed: executor lost`, decided
  at READ time so a machine that never comes back still resolves its jobs.
  Durability buys the RECORD, never the EXECUTION — nothing resumes a killed
  generation, because re-running it would re-bill it. What a dead job DID write
  is still in `gen/`, which is what `gemini_list_recent_media` is for.
- **The four payload shapes must match mcp-host's `blob-key.ts` byte for byte.**
  `tests/blob-store.test.ts` restates them independently so a drift fails here
  rather than as a 403 in production. They are also the shapes the retired
  Worker used, which is why links minted before the move still resolve.

## Conventions

- All tools prefixed `gemini_*`.
- **TDD.** Write a failing test before implementation. `fetch` is mocked by
  injecting `fetchImpl` into `GeminiClient`; clipboard via an injectable `Runner`.
  No real API calls and no real shell-outs in tests.
- **`npm test` is the whole CI gate.** `.github/workflows/ci.yml` delegates to the
  shared reusable workflow with `test-command: npm test`, so anything not
  reachable from that script does not run in CI *at all*. It therefore chains:
  node typecheck (`tsconfig.test.json`, which covers `tests/` — `tsconfig.json`
  scopes `include` to `src` for the build, so tests are otherwise unchecked) →
  `vitest run` (node pool). There is no workers-pool stage any more: the
  Cloudflare Worker connector was retired when this MCP moved to mcp-host, and
  `src/worker.ts` / `src/gemini-auth.ts` no longer exist. **Add new gates here,
  not to the workflow file** — a PR that edits `.github/workflows/*` can't be auto-reviewed (the
  Claude App validates the workflow against the default branch, so the review
  emits no verdict and the PR never arms), which turns a one-line CI change into
  a manual merge. `tests/ci-gates.test.ts` guards the chain.
- **Errors.** Throw `McpToolError` (from `@chrischall/mcp-utils`) with an
  actionable `hint` (e.g. missing key → aistudio link; no image returned → "try
  rephrasing, safety filter"). HTTP error *bodies* are redacted and truncated for
  you — `createApiClient.fetchJson` runs `truncateErrorMessage` (Bearer/JWT
  redaction THEN length cap) on the response text before throwing. Don't hand-roll
  body trimming. Put remediation in the **message**, not only `hint` — the host
  shows the message and drops the hint (and drops `cause` too, which is why
  `describeError` flattens the chain into the text). Wrap a distinct operation in
  `step('what it was doing', …)` so a failure names it; `surfaceToolErrors`
  (applied to every registrar in `index.ts`) adds the tool name and the flattened
  chain on top, so nothing escapes as an unattributed throw.
- **Result wrapper.** Use `emit()` / `textResult()`; don't hand-roll `content`
  arrays. `emit()` owns the inline-vs-disk branch.
- **Orientation is a shorthand, never a second source of truth.** Every
  generation tool takes `aspect_ratio`; `orientation`
  (`landscape`/`portrait`/`square` → `16:9`/`9:16`/`1:1`) exists because a
  14-value enum described as "Output aspect ratio" was unreachable from the
  words people use — the capability was there and nobody could ask for it.
  ONE mapping is shared by images and video so "portrait" means the same shape
  everywhere (omni offers only 16:9/9:16, which is why that pair was chosen
  over a photo ratio). `resolveAspectRatio` settles the two: an explicit
  `aspect_ratio` wins, and an orientation outside the calling tool's enum
  throws — never silently rounds, since a substituted shape is invisible to the
  caller. Resolve BEFORE `fingerprintRequest` so `orientation: 'portrait'` and
  `aspect_ratio: '9:16'` dedup to one billable job. And every picture-producing
  tool ECHOES the resolved shape: a word that becomes a ratio the caller never
  typed has to be visible in the result. `reportShape()` writes those two fields
  — `buildMeta` calls it, and so do the two hand-rolled metas
  (`gemini_interact`, `gemini_video_generate`) that are built around
  `interaction_id` rather than a seed and so cannot use `buildMeta`.
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
  PROCESSING→ACTIVE poll goes through the shared client. One private
  `uploadToFilesApi(body, mime, name, length)` now serves all three entry points
  — `uploadVideo` (a file-backed Blob), `uploadBytes` (in-memory, the only form
  usable on a Worker) and `uploadStream` (the `/upload` endpoint's request body).
  Images normally arrive `ACTIVE`; it is video that spends time `PROCESSING`.
- **A `files/<id>` reference is only usable by the key that created it, and only
  for ~48h.** Both facts leak into behaviour: the session upload cache is
  per-session (never module-scope) because sharing it across tenants
  would hand out references the other user cannot read, and an expired uri comes
  back as the *same generic 404* as an unknown model id (see
  `ChainedRequest404Error`) — hence `getFile()` resolving a caller-supplied
  `images_file_uris` entry up front, so "that file is gone" is said plainly
  before a billable request is built.
- **Nothing in `client.ts`'s module graph may touch module scope.** No I/O, no
  top-level await, no `import.meta.url` — some bundlers leave it undefined, and
  a module-scope `fileURLToPath(import.meta.url)` there is a startup crash
  rather than a request error. The stdio `.env` bootstrap lives in
  `src/dotenv.ts`, called from `index.ts`, for exactly this reason.
- **Never invoke a stored native function through a property
  (`this.fetchImpl(...)`).** workerd's WebIDL receiver check rejects native
  `fetch` called with any receiver other than the global scope — `Illegal
  invocation: function called with incorrect 'this' reference` — while Node's
  fetch doesn't care, so every node-pool test stays green and the crash is
  production-only. It shipped once: `uploadToFilesApi` called
  `this.fetchImpl(...)`, and every hosted generation whose reference image
  took the >6MB Files-API promotion (r2_key uploads, saved characters, large
  `images_url`) died on it, while text-only generation and library writes
  worked — a baffling split until you know the receiver rule. The constructor
  wraps the DEFAULT fetch in an arrow; call sites alias to a local first
  (`const doFetch = this.fetchImpl`); an INJECTED impl is stored raw so tests
  can emulate workerd's receiver check. Guarded by
  `tests/tools/hosted-reference-forms.test.ts` — keep new `fetchImpl` call
  sites receiver-free, and note the workers-pool suite CANNOT catch this
  (vitest wraps workerd's global fetch in plain JS, which hides the check).
- **No module-level mutable state in `src/` — it leaks across tenants.**
  one process can serve several sessions, so
  a module-level `Map`/`let` is shared by every authenticated claude.ai session
  in that isolate. The per-session `GeminiClient` isolates the API key and
  nothing else. When the job registry and `lastInteractionId` lived at module
  scope, a colliding `idempotency_key` handed user B user A's recorded result
  verbatim (A's media refs, A's interaction id), an identical prompt attached B
  to A's in-flight *billable* job (`fingerprintRequest` excludes the seed, the
  output path AND the key), and `continue_last: true` resumed A's interaction
  under B's key. All such memory now lives in `SessionState` (`src/session.ts`)
  reached as `client.session`. Anything to remember across calls goes there —
  never a module global. Guarded by `tests/session-isolation.test.ts`.
- **The API key resolves at REQUEST time, not in the constructor.**
  `requireKey()` reads `$GEMINI_API_KEY` per request (an explicitly-injected key
  — a hosted per-session key — wins). That keeps the config error
  deferred to the first tool call *and* makes module-evaluation order
  irrelevant: `index.ts` loads `.env` after importing the `client` singleton,
  and latching the key in the constructor would silently read "unset". Don't
  "optimize" it back into the constructor.
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
  snake/camel fallbacks). **Currently unverified and flagged as such in
  `docs/GEMINI-API.md`:** image upload to the Files API, `GET /v1beta/files`,
  `DELETE /v1beta/files/<id>`, and — the weakest claim of the lot — the
  Interactions `{ type: 'image', uri, mime_type }` input part, which is inferred
  from the *verified* `{type:'video', uri}` part rather than observed. If a
  chained interact call carrying `images_file_uris` 400s/404s, start there.
- **Don't switch to `Authorization: Bearer`** — Gemini ignores it and requests
  401. (The Interactions `Api-Revision` header is history: required in beta,
  dropped at GA.)
- **Don't "upgrade" `BASE_URL` to `/v1`** — it lacks the Pro image model.
- **Don't register tools that can't be tested against a mocked `fetchImpl`** (and a
  mocked clipboard `Runner`). All network/shell access must be injectable.
- **Don't bump versions speculatively.** release-please owns that.
- **Don't add module-scope mutable state to `src/`.** One hosted child serves
  every session of this registration at once, so a module-level `Map`/`let` is
  shared by all of them. Put it in `SessionState` instead. (The `import.meta.url`
  / top-level-`await` half of this rule was about the retired Worker; `client.ts`
  still avoids them, but the failure mode is historical.) See Quirks.
- **Don't reach for Cloudflare primitives in `src/`.** There is no Worker, no KV,
  no Durable Object and no Queue in reach — the hosted child's environment is
  allowlist-only. The only durable store it can address is mcp-host's blob store
  (`src/blob-store.ts`), which is what `src/job-store.ts` uses.
