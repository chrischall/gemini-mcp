# Gemini image API — verified request/response shapes

Captured 2026-06-07 against a **paid-tier** key via real `curl` calls. No secrets
in this file or the fixtures (a models list and a redacted 1×1 image).

## Endpoint & auth

- **Base URL:** `https://generativelanguage.googleapis.com/v1beta`
  (⚠️ `/v1` does NOT expose `gemini-3-pro-image` — must use `v1beta`.)
- **Generate:** `POST /v1beta/models/{model}:generateContent`
- **List:** `GET /v1beta/models?pageSize=200`
- **Auth header:** `x-goog-api-key: $GEMINI_API_KEY` (not `Authorization: Bearer`).
- **Content-Type:** `application/json`.

## Models (generateContent image models on v1beta)

| id | notes |
|---|---|
| `gemini-3-pro-image` | Nano Banana Pro. Paid tier only. Returns JPEG. Deliberate opt-in — NOT the default (see `src/models.ts`). |
| `gemini-3-pro-image-preview` | preview alias of the above |
| `gemini-3.1-flash-image` | fast. **The server's default** (`DEFAULT_IMAGE_MODEL`). |
| `gemini-2.5-flash-image` | fast/cheap. ⚠️ Shutdown 2026-10-02 per the deprecations page (replacement: `gemini-3.1-flash-image-preview`). |
| `nano-banana-pro-preview` | alias of gemini-3-pro-image |

**Model currency check (2026-08-22, changelog/deprecations pages — docs-derived,
not live-verified):** everything this server defaults to or recommends is alive
with no announced shutdown (`gemini-3.1-flash-image`, `gemini-3-pro-image`,
`gemini-omni-flash-preview`, `lyria-3-clip-preview`, `lyria-3-pro-preview`).
`imagen-4.0-*` shut down 2026-08-17 — already excluded by `filterImageModels`.
`gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) went GA 2026-06-30 and shows
up in the filtered list automatically. `gemini-3.7-flash` went GA 2026-08-13 —
a text model, not our surface. Sampling params (`temperature`, `top_p`,
`top_k`) were deprecated across the latest models on 2026-07-21; this server
sends none of them.

⚠️ **Correction to the 2026-07-30 entry:** it claimed "the Files API gained
pre-signed-URL sources and a 100MB per-file limit on 2026-07-08". Both halves
are wrong. The current docs show no pre-signed-URL source at all, and the
limits are unchanged at **2 GB per file / 20 GB per project / 48h TTL** — the
100 MB figure is the *total request size* above which you must use the Files
API rather than inline bytes (50 MB for PDFs). Nothing about our upload caps
changes; the note itself was the error.

`imagen-4.0-*` also appear in the list but use a **different `:predict` API** — NOT
generateContent — so `filterImageModels` excludes anything matching `/imagen/i`.

**Billing:** image generation is **paid-only**. A free-tier key returns
`429 … generate_content_free_tier_requests, limit: 0` for every image model.

## Generate request (CONFIRMED — `imageConfig`, returns 200)

```jsonc
{
  "contents": [
    {
      "parts": [
        { "text": "<prompt>" },
        // 0..M input images (edit/compose/set). snake_case ACCEPTED on request:
        { "inline_data": { "mime_type": "image/jpeg", "data": "<BASE64>" } }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "aspectRatio": "1:1", "imageSize": "1K" }  // both optional
  }
}
```

- The aspect/size container is **`generationConfig.imageConfig`** (the
  `responseFormat.image` variant from the docs scrape was NOT needed; `imageConfig`
  returns 200).
- `aspectRatio` values: `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9 1:4 4:1 1:8 8:1`.
- `imageSize` values: `1K 2K 4K` (`512` Flash-only).
- Request field casing: snake_case (`inline_data`/`mime_type`) is accepted; camelCase also works.

## Generate response (CONFIRMED — camelCase)

```jsonc
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "inlineData": { "mimeType": "image/jpeg", "data": "<BASE64 IMAGE>" },
            "thoughtSignature": "<opaque, ignore>"   // Gemini-3 thinking; sibling key, ignore
          }
        ]
      },
      "finishReason": "STOP"
    }
  ],
  "modelVersion": "gemini-3-pro-image"
}
```

- Image bytes live at `candidates[*].content.parts[*].inlineData.data`
  (response is **camelCase**: `inlineData` / `mimeType` — no snake_case).
- `gemini-3-pro-image` returns **`image/jpeg`**.
- A part may carry `thoughtSignature` alongside `inlineData`; ignore it. The
  client reads both `inlineData`/`inline_data` and `mimeType`/`mime_type` defensively.

Both text→image and image+text→image (edit) were verified end-to-end (200, real
decodable JPEG written to disk).

## Additional generateContent knobs (verified 2026-06-08)

- **`imageConfig.imageSize: "512"`** (0.5K) — accepted on `gemini-3.1-flash-image`
  (Flash only; not Pro). 200 + image. Add to the size enum.
- **`generationConfig.thinkingConfig.thinkingLevel`** = `"minimal"` | `"high"`
  (plus `includeThoughts: bool`) — accepted on Flash (200 + image). Pro's headline
  "Thinking" feature uses the same field. Real quality/cost lever.
- **`responseModalities: ["TEXT","IMAGE"]`** — accepted; the model MAY return a
  `{text}` part alongside the `inlineData` part (common on Pro for captions/
  explanations; Flash often returns image only — verified: flash returned image,
  no text). Collect text parts and surface them; still require ≥1 image.
- SynthID watermark on ALL outputs.
- Composition cap: up to ~14 reference images (model-dependent: Pro 6 objects +
  5 characters; 3.1 Flash 10 objects + 4 characters).

### Google Search grounding (verified 2026-06-08)
Top-level `tools` array (sibling of `contents`/`generationConfig`):
```jsonc
{ "contents":[...], "generationConfig":{"responseModalities":["IMAGE"]},
  "tools":[{ "google_search": {} }] }   // 200 + image; grounds on live web data
```
Response adds `candidates[0].groundingMetadata`:
`{ webSearchQueries: string[], groundingChunks: [{ web: { uri, title } }], searchEntryPoint }`.
Surface `webSearchQueries` (queries) + `groundingChunks[].web` (sources: `{uri,title}`).

### Video-to-image (verified 2026-06-08)
A `contents[].parts` entry referencing a public YouTube URL (Flash models; verified
on `gemini-3.1-flash-image`):
```jsonc
{ "parts":[ {"text":"<prompt>"},
            {"file_data":{"file_uri":"https://www.youtube.com/watch?v=…","mime_type":"video/mp4"}} ] }
```
For **local (non-YouTube) video**, upload the bytes to the Files API first and use
the returned `files/…` URI — see the next section.

### Files API — local video upload (verified 2026-06-12)

Resumable upload protocol, captured live with `curl` against a real key (2s/5KB
test mp4). Three steps:

**1. Start** — `POST https://generativelanguage.googleapis.com/upload/v1beta/files`
(note the `/upload/v1beta` prefix — NOT under the normal `/v1beta` base):

```
x-goog-api-key: $GEMINI_API_KEY
X-Goog-Upload-Protocol: resumable
X-Goog-Upload-Command: start
X-Goog-Upload-Header-Content-Length: <total bytes>
X-Goog-Upload-Header-Content-Type: video/mp4
Content-Type: application/json

{"file": {"display_name": "<name>"}}
```

Response: `200` with an **empty body**; the upload session URL is in the
**`x-goog-upload-url` response header** (same host, `?upload_id=…&upload_protocol=resumable`).
Also returned: `x-goog-upload-status: active` and
`x-goog-upload-chunk-granularity: 8388608` (8 MiB — only matters for chunked
multi-request uploads; a single-shot `upload, finalize` of any size is fine).

**2. Upload + finalize** — `POST <x-goog-upload-url>` with the raw video bytes
as the body (no api-key header needed — the session URL is self-authorizing;
verified: finalize succeeded without it):

```
Content-Length: <total bytes>
X-Goog-Upload-Offset: 0
X-Goog-Upload-Command: upload, finalize
```

Response: `200`, `x-goog-upload-status: final`, body **wraps the File in `{file:}`**:

```jsonc
{
  "file": {
    "name": "files/3c04ao1lzudw",          // resource name: files/<id>
    "displayName": "gemini-8-test",
    "mimeType": "video/mp4",
    "sizeBytes": "5101",                    // string, not number
    "createTime": "2026-06-12T15:26:39Z",
    "expirationTime": "2026-06-14T15:26:39Z", // createTime + 48h TTL (verified)
    "sha256Hash": "<base64>",
    "uri": "https://generativelanguage.googleapis.com/v1beta/files/3c04ao1lzudw",
    "state": "PROCESSING",                  // videos start PROCESSING
    "source": "UPLOADED"
  }
}
```

**3. Poll until ACTIVE** — `GET /v1beta/files/<id>` (normal base URL,
`x-goog-api-key` header). ⚠️ The poll response is the File object **unwrapped**
(no `{file:}` wrapper — unlike finalize). For the tiny test clip, the first poll
~1s later was already `ACTIVE`, with `videoMetadata: { videoDuration: "2s" }`
added. Documented states: `PROCESSING` → `ACTIVE` | `FAILED` (a `FAILED` file
carries an `error` field).

**Using the file** (both verified live, 200 + image, `gemini-3.1-flash-image`):
- `generateContent`: `{"file_data":{"file_uri":"<file.uri>","mime_type":"video/mp4"}}`
  — same part shape as the YouTube path, with the `files/…` URI.
- Interactions: `{"type":"video","uri":"<file.uri>","mime_type":"video/mp4"}`.

**Limits (documented, not load-tested):** 2 GB max per file, 20 GB per project,
48h TTL (the TTL is verified above — `expirationTime` = `createTime` + 48h).
Supported video MIME types: `video/mp4`, `video/mpeg`, `video/mov`, `video/avi`,
`video/x-flv`, `video/mpg`, `video/webm`, `video/wmv`, `video/3gpp`.

## Interactions API — GA (verified 2026-06-08; re-verified GA 2026-07-06)

The multi-turn API. **Now generally available** (docs: "The Interactions API is
now generally available"); the beta-era "breaking changes (May 2026)" warning is
gone and Google's docs recommend it over `generateContent` for image work.

- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- **Headers:** `x-goog-api-key`, `content-type: application/json`.
  ⚠️ The beta-required **`Api-Revision: 2026-05-20`** header is **no longer
  needed** (verified live 2026-07-06: requests succeed both with and without it;
  the current docs no longer mention it). The client no longer sends it — don't
  re-add a pinned revision.
- **Request** (snake_case — NOT the generateContent shape):
  ```jsonc
  {
    "model": "gemini-3.1-flash-image",
    "input": [
      { "type": "text", "text": "<prompt>" },
      { "type": "image", "mime_type": "image/png", "data": "<BASE64>" } // 0..N inputs
    ],
    "response_format": {
      "type": "image",
      "mime_type": "image/jpeg",   // ⚠️ ONLY image/jpeg accepted (png 400s)
      "aspect_ratio": "1:1",
      "image_size": "1K"
    },
    "generation_config": { "thinking_level": "minimal" },   // optional
    "previous_interaction_id": "<prior .id>"                 // optional — multi-turn
  }
  ```
- **Response:** `{ id, status, model, object, created, updated, usage, steps: [...] }`.
  `steps[]` entries are `{type:"thought"|"model_output", content?:[parts], summary?:[parts]}`.
  Image parts are `{ type:"image", mime_type:"image/jpeg", data:"<BASE64>" }`; text
  parts are `{type:"text", text}`. The **output image** is the image part in the
  `model_output` step. Collect image+text parts across `content`/`summary`.
- **Multi-turn:** pass the prior response's `id` as `previous_interaction_id`;
  returns a NEW `id` + the edited image (verified: turn 2 edited turn 1's leaf).
  Server is NOT auto-stateful — the caller threads the id.
- **Errors:** `{ "error": { "message": "...", "code": "invalid_request" } }`
  (string `code`, unlike generateContent's numeric status).
- **Grounding** (verified): top-level `"tools":[{"type":"google_search"}]` — note the
  `type` field (vs generateContent's `{"google_search":{}}`). 200 + image. The response
  adds two steps: `google_search_call` (`{arguments:{queries:[…]}, search_type}`) and
  `google_search_result` (`result[].search_suggestions` = HTML chips, NOT clean source
  URIs). So surface the **queries** (`google_search_call.arguments.queries`) only — no
  `{uri,title}` source list like generateContent's `groundingChunks`.
- **Video input** (verified): an `input` entry `{"type":"video","uri":"https://www.youtube.com/watch?v=…","mime_type":"video/mp4"}` (alongside the text part). 200 + image on `gemini-3.1-flash-image`.
- MCP mapping: a `gemini_interact` tool returns the `id` so a follow-up call can
  pass `previous_interaction_id` — stateless MCP, stateful conversation.

### GA re-verification (2026-07-06, live against a paid key)

- **Multi-turn works without `Api-Revision`**: turn 1 (red circle) → turn 2
  chained via `previous_interaction_id` ("make the circle blue") returned a new
  `id` and a correct 512×512 blue-circle JPEG. Response shape unchanged
  (`{id, status, steps:[{type:"thought"|…|"model_output", content, summary}]}`).
- **The interactions store is eventually consistent** (observed 2026-07-06): a
  chained call referencing a *freshly created* id intermittently 404s
  (`{"error":{"message":"Requested entity was not found.","code":"not_found"}}`)
  while the same id + key resolves fine minutes later (GET and chained POST both
  succeed; verified against a real failing id from a live session — same key
  fingerprint, id created moments before the failure). An immediate 3-turn
  rapid-chain repro went 3/3 OK, so the lag is intermittent/load-dependent.
  The client retries a chained 404 with exponential backoff (2s, 4s, 8s, 16s,
  then 30s steps) until a **120s** budget is spent (`$GEMINI_CHAIN_RETRY_MS`)
  before surfacing an actionable error. A 404'd call generated nothing, so the
  retry is free. **The budget must stay minutes-scale**: it was 2 fixed retries
  (~6s) against the minutes-long lag measured right here, so every rapid
  iteration surfaced as an "expired chain" while the id was merely not yet
  visible. Don't shrink it back to something that feels responsive.
- **Retention** (per the Interactions API docs): interactions are stored 55
  days on the paid tier, 1 day on the free tier (`store=true` default), and are
  scoped to the creating API key's project. `store=false` disables
  `previous_interaction_id` chaining entirely.
- **Enums re-confirmed from live 400 errors** (the API enumerates supported
  values when given a bogus one — a free way to re-check):
  - `response_format.image_size`: `'512', '1K', '2K', '4K'` — literal `512`,
    NOT `512px` (the docs page's "512px (0.5K)" is prose, not the literal).
  - `response_format.aspect_ratio`: all 14 — `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16
    16:9 21:9 1:8 8:1 1:4 4:1` (the docs page lists only 10; the banner shapes
    are still accepted).
- **Model lineup** now also includes `gemini-3.1-flash-lite-image` (Nano Banana
  2 Lite — fastest/cheapest, 1K only, no search grounding) and
  `gemini-3.1-flash-image-preview`.
- Docs also show an optional `search_types: ["web_search", "image_search"]`
  field on the `google_search` tool — implemented; see next section.

### `search_types` grounding (verified live 2026-07-06)

Request: `"tools": [{"type": "google_search", "search_types": ["web_search", "image_search"]}]`
(`image_search` is documented for `gemini-3.1-flash-image` only; it uses Google
Image Search results as visual references for the generation. Docs show
`search_types` only for the Interactions API — do NOT assume generateContent's
`{"google_search":{}}` accepts an equivalent without verifying.)

Verified response behavior (butterfly prompt, both types):

- One `google_search_call` + `google_search_result` **pair per search type**;
  the call step carries `search_type: "web_search" | "image_search"`.
- ⚠️ A call step's `arguments` can be **`null`** (the web_search call had no
  `arguments`; the image_search call had `arguments.queries`). Parse defensively.
- `google_search_result`: `{ call_id, type, result: [{search_suggestions:
  "<style>…"}], is_error }` — each `result[]` entry's `search_suggestions` is a
  self-contained HTML chip (they repeat; dedup). **ToS: when image_search is
  used, these chips MUST be displayed to the user** — the client surfaces them
  as `grounding.search_suggestions` only when `image_search` was requested.
- `model_output` can appear **more than once** (e.g. image first, then an empty
  text step) — aggregate across all of them.
- The docs also mention `url_citation` annotations on text content blocks for
  grounded responses — not parsed yet (no text-annotation surface in our meta).

### Delivery modes — `inline` vs `uri` (verified live 2026-08-22)

`response_format.delivery` is **schema-valid for image, audio and video** and
**implemented for video only**. Sending a bogus value makes the API enumerate
the schema enum for any of the three:

```
"The value 'bogus' is not supported for 'response_format.delivery'.
 Supported values: 'inline', 'uri'."
```

…but a *valid* value on the wrong media type is rejected by the model layer:

| `response_format.type` | `delivery: "inline"` | `delivery: "uri"` |
|---|---|---|
| `image` | 400 `Image delivery mode is not supported.` | 400 (same) |
| `audio` | 400 `Audio delivery mode is not supported.` | 400 (same) |
| `video` | ✅ accepted (what `generateVideo` sends) | ✅ accepted, verified end-to-end |

Two consequences worth keeping straight:

1. **`delivery: 'inline'` in `client.ts` is correct.** It is a real enum value,
   not a guess that happens to be tolerated. Do not "fix" it to `base64` — the
   prose docs describe the default as base64 bytes but never name that as a
   value, and `base64` is not in the enum.
2. **Do not add a `delivery` param to the image or music tools.** The SDK's
   type definitions declare `delivery` on `ImageResponseFormat` and
   `AudioResponseFormat`, so the types promise a capability the API refuses.
   The types are a superset of the Gemini API (they also serve Vertex) — see
   the `.d.ts` section below.

**Video `uri` delivery, verified end-to-end** (`gemini-omni-flash-preview`,
default aspect/resolution, 31s wall clock):

```jsonc
// request
{ "model": "gemini-omni-flash-preview",
  "input": [{ "type": "text", "text": "…" }],
  "response_format": { "type": "video", "delivery": "uri" } }

// model_output step content — note NO `data` key at all
{ "type": "video", "mime_type": "video/mp4",
  "uri": "https://generativelanguage.googleapis.com/v1beta/files/<id>:download?alt=media" }
```

The uri is a **Files API object**, and everything that implies is load-bearing:

- `GET /v1beta/files/<id>` showed `state: "ACTIVE"` on the first poll (no
  `PROCESSING` wait was needed for a 10s/2.6MB clip), `source: "GENERATED"` (a
  new value — uploads report `UPLOADED`), `videoMetadata.videoDuration: "10s"`,
  and the usual **48h** `expirationTime`.
- **The download requires `x-goog-api-key`.** Fetching the uri without the
  header returns **403**. So a uri-delivered video is *not* a link that can be
  handed to a user or embedded — the server must download the bytes and
  re-host them (disk sink / R2) exactly as it does for inline delivery. `uri`
  buys us the >4MB ceiling, not a shareable link.

### Video `response_format` — fields we don't send (verified live 2026-08-22)

Confirmed against `gemini-omni-flash-preview` by the bogus-enum trick, paired
with a model-invalid `thinking_level` so the request fails validation *before*
billing a generation:

- **`resolution`** — `'360p'`, `'720p'`, `'1080p'`, `'4k'` (enumerated by the
  API; defaults to 720p). Schema-accepted by omni. Whether omni honours 1080p/4k
  in the output is NOT verified — that needs a real generation.
- **`duration`** — a duration string (`"6s"`, `"12s"` accepted; `"bogus"` →
  `Invalid input at 'response_format'`). Schema-accepted; output length not
  verified.
- **`aspect_ratio`** — `'16:9'`, `'9:16'` only, which is what
  `VIDEO_ASPECT_RATIOS` already enforces. `1:1` is rejected.
- **`gcs_uri`** — Vertex-only (required there when delivery is uri). Not ours.
- **omni's `thinking_level` has two layers.** The schema enum is
  `'minimal' | 'low' | 'medium' | 'high'`, but the model rejects two of them:
  `'minimal' is not a supported thinking level for this model. Allowed values
  are: low, high.` A schema-valid value is not a supported value.

### Background execution + the interaction lifecycle (verified live 2026-08-22)

`background: true` returns immediately with `status: "in_progress"` and an id
the caller polls — the work continues server-side. **Support is per-model, and
the split is the opposite of what our tools need most:**

| model | `background: true` |
|---|---|
| `gemini-3.1-flash-image` | ❌ 400 `Model 'gemini-3.1-flash-image' does not support background interactions.` |
| `gemini-omni-flash-preview` (video) | ✅ `200 { status: "in_progress" }` |
| `lyria-3-clip-preview` (music) | ✅ `200 { status: "in_progress" }` |

So the *image* path — the one this server spends most of its wall clock on —
cannot be handed off upstream, and `jobs.ts` / `job-store.ts` remain the only
answer there. Video and music, the two slowest tools, *can* be: a background
video interaction polled to `completed` in ~24s and its `model_output` step
carried the same uri content as a synchronous call.

⚠️ **But accepting `background: true` is not the same as being able to collect
the result, and this is where it falls down.** Polling a backgrounded omni
interaction, on a paid key, in the same session that created it:

```
poll 1: HTTP 403  permission_denied  "There was a problem processing your
                                      request. You will not be charged."
poll 2: HTTP 400  invalid_request    "Request contains an invalid argument."
poll 3-9: HTTP 400 …                 (unchanged minutes later)
```

The 403 is transient and precisely meaningful: it is what a poll of *in-flight*
work returns. Measured on one interaction — `t+20s` 403, `t+40s` `completed`
with its clip. The 400 is not transient: across **five** backgrounded video
interactions, **three completed and served their media** (one of them recovered
after the caller abandoned it) and **two settled into a permanent `400` and
were never retrievable at all** — billed, and unreachable. Nothing in the
request distinguished them.

So background execution is not dependable enough to be the default, while the
synchronous path returns the same clip in ~31s. **This repo treats `background`
as opt-in** (`VideoOpts.background`, and a `background` param on
`gemini_video_generate` / `gemini_music_generate`). What it buys when you do opt
in is real: the interaction id lands in the durable job record immediately, so a
generation whose executor is reclaimed can be recovered rather than re-paid for
(see below).

Lifecycle verbs, as observed:

- **Poll** — `GET /v1beta/interactions/{id}`. Returns the full interaction
  including a `user_input` step (a `create` response omits it). A poll of work
  still in flight answers `403` (above), so a poll loop must treat 403 — and
  404, the same store lag the chained POST waits out — as "keep waiting", and
  let the caller's timeout bound it.

  *(An earlier draft of this file reported that in-flight polls return a body
  with no `status` field. That was wrong: those were 403 error bodies read
  through `jq '.status'`, which yields `null`. The client still treats a
  status-less body with no output as unfinished, but as a defensive rule, not
  as an observed shape.)*
- **Delete** — `DELETE /v1beta/interactions/{id}` → `200 {}`. A subsequent GET
  returns **404 `Requested entity was not found.`** — byte-identical to the
  expired-chain and unknown-model 404s. More evidence for the
  `ChainedRequest404Error` rule: a 404 body never names the entity.
- **A malformed id is a 400, not a 404** — `GET …/interactions/v1_bogus` →
  `400 Invalid interaction name: interactions/v1_bogus`. Useful signal: 400
  means the id was never well-formed (a truncation/typo bug on our side), 404
  means a well-formed id is gone (expired, deleted, or another project's).
- **Cancel** — `POST /v1beta/interactions/{id}/cancel` is documented, but on
  this paid key it returned **403** with the generic
  `There was a problem processing your request. You will not be charged.`
  Not available to us today; don't build on it without re-probing.

### What this repo does with the above (implemented 2026-08-22)

- **`generateVideo` requests `delivery: 'uri'` by default** and downloads the
  bytes itself (host-checked, api-key attached) before handing them to the
  sink, so the ~4MB inline ceiling stops being a failure mode. `delivery:
  'inline'` remains available per call. If a model answers "…delivery mode is
  not supported", the client re-issues once WITHOUT the field — that 400
  generated nothing, so the recovery is free.
- **`generateVideo` / `generateMusic` accept `background: true` as an opt-in**
  (never the default — see the coin-flip above) and then poll
  `GET /interactions/{id}` in band, bounded by the caller's own `timeout_ms`,
  treating 403/404 polls as "keep waiting" and reporting the last poll error if
  the wait runs out. `interact` and `generate` never send `background` — the
  image models reject it outright.
- **A chained 404 is now diagnosed, not guessed.** After the store-lag budget
  is spent, `diagnoseChain()` GETs the id: gone → re-anchor (while still saying
  the 404 may have had another cause); alive → the chain is NOT the cause, so
  check the model id / `files/…` uri; malformed → say so. If the probe itself
  fails, `chainExists` stays `undefined` — "unknown" must not read as "gone".
- **A timed-out background generation names its interaction id**, because the
  work continues upstream and an error that drops the id throws it away.
- **A killed background job is recovered from that id.** `JobRecord` carries an
  `interactionId`, written the moment the API returns it rather than when the
  job settles — the whole point is that the settle may never happen. When
  `gemini_get_result` finds a job whose executor was lost, it fetches that
  interaction and re-hosts the media instead of reporting the work destroyed.
  Verified live: a 2.67 MB MP4 was pulled back from nothing but an interaction
  id, ~40 minutes after the request that created it. Durability buys the RECORD
  and, where an id exists, the OUTPUT — still never the EXECUTION, and an
  interaction that cannot be read keeps the honest "was lost" error rather than
  being papered over.

### The `@google/genai` `.d.ts` as a spec source

The official JS SDK (`@google/genai`, v2.18.0 at the time of writing) ships a
16k-line `dist/genai.d.ts` that is a far better reference than the prose docs —
it enumerates `response_format` variants, delivery modes, aspect ratios, sizes,
step types and the `status` enum as literal unions, and it carries the full
`interactions.create/get/delete/cancel` surface. Read it with:

```bash
npm pack @google/genai && tar xzf google-genai-*.tgz   # package/dist/genai.d.ts
```

**It is a reference, not a dependency, and not an oracle.** Three limits, all
of which bit during the 2026-08-22 pass:

1. **Every union ends in `(string & {})`** — e.g.
   `"inline" | "uri" | (string & {})`. Any string is assignable, so a
   compile-time conformance check against these types would catch nothing.
   They are documentation, not a guard.
2. **The types are a superset of the Gemini API** (they also describe Vertex
   and Managed Agents). `ImageResponseFormat.delivery` and
   `AudioResponseFormat.delivery` are typed and *rejected at runtime*;
   `gcs_uri` is Vertex-only. Type-present ≠ supported.
3. **Model-level support is invisible in the types.** `background` and
   `thinking_level` are typed uniformly across models, while the API accepts
   them for some models and rejects them for others (see the two tables above).

The deliberate decision (2026-08-22) is **not** to adopt the SDK at runtime: it
adds ~1.6 MB to the esbuild bundle (which is ~1.4 MB today) and drags in `ws`,
`protobufjs` and `google-auth-library` for an API-key REST client; and its
`HttpOptions` exposes only `baseUrl`/`headers`/`timeout`/`retryOptions` with no
injectable fetch, which is incompatible with this repo's `fetchImpl` test
discipline. None of the hard parts here — the chained-404 retry budget, sidecar
re-anchoring, the receiver-safe Files-API upload, the blob-store sink,
per-session key isolation — are things it would replace.

### Other documented capabilities not (yet) implemented

- **`response_format` as an array** — `[{type:"text"},{type:"image"}]` requests
  interleaved text+image output; a single `{type:"image"}` (what we send)
  suppresses the conversational text. Switching would change output volume.
- **Batch API** — all image generation can run as batch jobs (higher rate
  limits, up to 24h turnaround). Doesn't fit an interactive MCP tool.
- **Reference-image caps** (of 14 total): 3.1 Flash 10 objects + 4 characters +
  3 style refs; Pro 6 objects + 5 characters; 3.1 Flash Lite 14 objects, no
  character consistency. Plain `image` input parts — no role/type field; the
  split is a model capability, not an API field.
- **`DELETE /v1beta/interactions/{id}`** — verified (`200 {}`, then GET 404).
  Would back a "forget this conversation" tool against the 55-day paid-tier
  retention. The GET half of that pair *is* implemented (below).
- **`store`, `system_instruction`, `safety_settings`, `service_tier`, `labels`,
  `webhook_config`** — documented create fields we never send. `store: false`
  disables `previous_interaction_id` chaining *and* background execution.
  `webhook_config` is unusable here: the hosted child has no HTTP surface.
- **Veo 3.1** (`veo-3.1-generate-preview`, `-fast-`, `-lite-`) — native audio,
  4/6/8s, 720p/1080p/4k, first+last-frame interpolation, up to 3 reference
  images, +7s extension up to 20×. A different API (`predictLongRunning` with
  polling), so it is a new client path rather than a model-string swap.

## Files API — images, list, delete (⚠️ DOCS-DERIVED, not live-verified)

The video upload above is the only Files API flow captured live (2026-06-12).
Everything in this section was built from Google's documentation and the shapes
that flow implies, and is **not yet verified against a real key**. Treat it the
way the repo treats every unverified shape: the parsers are tolerant, and a
surprise here should be fixed by verifying, not by guessing again.

**Uploading an image** uses exactly the same three-step resumable protocol as
video (`start` → `upload, finalize` → optionally poll). The expected difference
is that an image comes back `ACTIVE` immediately rather than `PROCESSING`, so
the poll loop simply does not run. Retention is the same ~48h
(`expirationTime` = `createTime` + 48h).

**Referencing an uploaded image** in a request:

```jsonc
// generateContent — same part shape as the verified video reference
{ "file_data": { "file_uri": "https://…/v1beta/files/<id>", "mime_type": "image/jpeg" } }

// interactions — by symmetry with the verified {type:"video", uri, mime_type}
{ "type": "image", "uri": "https://…/v1beta/files/<id>", "mime_type": "image/jpeg" }
```

The `generateContent` form is a direct copy of the video part that IS verified,
so it is the safer of the two. **The interactions `{type:"image", uri}` form is
the weakest claim on this page** — it is inferred from the video part's shape,
not observed. If a chained interact call carrying `images_file_uris` 404s or
400s, this is the first thing to check.

**List** — `GET /v1beta/files?pageSize=<1-100>`:

```jsonc
{ "files": [ { "name": "files/<id>", "displayName": "…", "mimeType": "image/png",
               "sizeBytes": "1234", "createTime": "…", "expirationTime": "…",
               "uri": "https://…/v1beta/files/<id>", "state": "ACTIVE" } ],
  "nextPageToken": "…" }   // pagination not implemented — one page is plenty at ~48h retention
```

**Get** — `GET /v1beta/files/<id>` returns the File object **unwrapped** (this
part IS verified, via the video poll).

**Delete** — `DELETE /v1beta/files/<id>`, empty `{}` on success.
