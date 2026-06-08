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
(Files API uploads for non-YouTube video are a separate upload flow — out of scope.)

## Interactions API — BETA (verified 2026-06-08)

The forward-looking multi-turn API. **Beta + "breaking changes (May 2026)" flagged;
Google says use `generateContent` for stable production.** We expose it as an
explicit, separate tool.

- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- **Headers:** `x-goog-api-key`, `content-type: application/json`, and
  **`Api-Revision: 2026-05-20`** (required).
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
  `type` field (vs generateContent's `{"google_search":{}}`). 200 + image.
- **Video input** (verified): an `input` entry `{"type":"video","uri":"https://www.youtube.com/watch?v=…","mime_type":"video/mp4"}` (alongside the text part). 200 + image on `gemini-3.1-flash-image`.
- MCP mapping: a `gemini_interact` tool returns the `id` so a follow-up call can
  pass `previous_interaction_id` — stateless MCP, stateful conversation.
