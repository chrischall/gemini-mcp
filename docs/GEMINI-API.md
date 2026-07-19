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
| `gemini-3-pro-image` | Nano Banana Pro. **Default.** Paid tier only. Returns JPEG. |
| `gemini-3-pro-image-preview` | preview alias of the above |
| `gemini-3.1-flash-image` | fast |
| `gemini-2.5-flash-image` | fast/cheap |
| `nano-banana-pro-preview` | alias of gemini-3-pro-image |

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
