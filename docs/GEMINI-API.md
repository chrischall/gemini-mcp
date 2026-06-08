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
