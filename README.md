# gemini-mcp

[![CI](https://github.com/chrischall/gemini-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/gemini-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/gemini-mcp)](https://www.npmjs.com/package/@chrischall/gemini-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/gemini-mcp)](LICENSE)

MCP server for Google Gemini media generation. Exposes eleven tools to Claude over stdio: list available models, generate/edit/compose images, generate a consistent set of images from a master prompt, multi-turn image refinement (Interactions API), **video** generation (omni), **music** generation (Lyria), an async result poll for long generations, and Files API upload/list/delete for reusable image references. Output is written to disk by default (path returned) or returned inline as base64. Built on the Gemini v1beta API (`generativelanguage.googleapis.com`) using the Nano Banana / Nano Banana Pro (images), omni (video), and Lyria (music) model families.

Developed and maintained by AI (Claude Code).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Your Google Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) |
| `GEMINI_IMAGE_MODEL` | No | Override the default image model (default: `gemini-3.1-flash-image`) |
| `GEMINI_OUTPUT_DIR` | No | Default directory for generated images (default: current working directory) |
| `GEMINI_INPUT_DIR` | No | Directory to resolve bare input-image filenames against (so `images: ["foo.jpg"]` works) |
| `GEMINI_TIMEOUT_MS` | No | Upstream request timeout in ms (default: `60000`, or `120000` for `image_size: "4K"`); each generation tool also takes a per-call `timeout_ms` |
| `GEMINI_HEARTBEAT_MS` | No | Progress-notification cadence in ms while a generation runs (default: `10000`; `0` disables) — keeps MCP hosts that reset their timeout on progress from timing out long generations |
| `GEMINI_CHAIN_RETRY_MS` | No | How long to wait out interactions-store lag when a chained call 404s (default: `120000`; `0` disables retrying) |

### Long generations and client timeouts

4K / Pro-model generations can outrun an MCP host's own `tools/call` timeout (error `-32001`).
The server sends `notifications/progress` heartbeats so hosts that reset their timeout on
progress wait it out. If the host still gives up, the server-side generation usually completes
anyway: the image is written to the output dir, `gemini_interact` also writes an
`<image>.json` sidecar recording the `interaction_id`, and `continue_last: true` resumes the
interaction the lost response belonged to.

### When a chained call 404s

A 404 on a request carrying `previous_interaction_id` is **not** proof the chain expired. The
only 404 body observed live is generic — `"Requested entity was not found."` — and never names
*which* entity. An unknown or renamed **model id**, and an expired Files API **`files/…` uri**
(~48h TTL), return exactly the same thing. So the server no longer asserts a cause it can't
establish: the upstream text is surfaced verbatim, and `gemini_interact` runs an experiment to
find out which it was.

Most often the id isn't missing at all — it just isn't *visible* yet. The interactions store is
eventually consistent, and a freshly created id can 404 while the same id resolves fine minutes
later; heavy turns (4K, Pro, `thinking_level: high`) are the likeliest to hit it, which is
exactly the turn you most want to chain from. So a chained 404 is retried with exponential
backoff for up to **120s** (`GEMINI_CHAIN_RETRY_MS`) before anything is declared broken. The
404 generates nothing and isn't billed, so the wait costs only time.

After that budget is spent, the tool looks up that id's sidecar, re-attaches the image it
produced, and re-issues the request **without** the chain:

- **The re-issue succeeds** → the chain really was the problem, and you get your image anyway,
  reported as `chain_recovered: { expired_interaction_id, reanchored_on }`. The 404'd attempt
  generates nothing, so this costs the one generation you'd have paid for re-anchoring manually.
- **The re-issue 404s too** → the interaction id was never the cause. You get told exactly that,
  with the upstream text, and pointed at the model id and any `files/…` uri instead of being
  sent to chase an interaction that was fine all along.
- **No sidecar matches the dead id** → the original error, rather than a guess. Re-anchoring on
  the wrong picture would silently corrupt the edit.

Separately, `continue_last` no longer dies with the server process: with no in-memory id it
resumes from the newest `<image>.json` sidecar in the output dir and reports
`continued_from_sidecar: true`. That case was never an expired chain at all — the interaction
was alive upstream the whole time; only our memory of its id was gone.

For hosts whose timeout can't be tamed (e.g. Claude Desktop, a fixed ~30s cap that ignores
progress), two guards make re-issuing safe and unnecessary:

- **`async: true`** returns a `job_id` immediately instead of the image, so the call can't
  time out at all; poll `gemini_get_result` with the `job_id` until it's `done`.
- **`idempotency_key`** makes a repeat call idempotent — a retry with the same key returns the
  recorded result (`reused: true`) instead of billing a second generation. (Even without a key,
  two identical in-flight calls are deduplicated automatically.)

## Tools

| Tool | Description |
|------|-------------|
| `gemini_list_models` | List available Gemini image models and the current default |
| `gemini_image_generate` | Generate image(s) from a text prompt |
| `gemini_image_edit` | One-off edits or multi-image composition with a text instruction (for a series of edits, use `gemini_interact`) |
| `gemini_image_set` | Generate a master image plus N consistent images referencing it |
| `gemini_interact` | Preferred tool for iterative refinement: multi-turn generation/editing via the Interactions API — chain the returned `interaction_id` via `previous_interaction_id` (or `continue_last: true`) |
| `gemini_video_generate` | Generate a short video (text→video, image→video, or `edit`) via the Gemini omni model (preview); written to disk as MP4 |
| `gemini_music_generate` | Generate music from a text prompt via a Lyria model — `lyria-3-clip-preview` (~30s, default) or `lyria-3-pro-preview` (longer, WAV-capable); written to disk as MP3/WAV (preview) |
| `gemini_get_result` | Fetch an async generation started with `async: true` by its `job_id` (status `running` → `done` result). Lets a long generation outlive a host's `tools/call` timeout |
| `gemini_upload_file` | Upload an image (or video/audio) to the Gemini Files API once — from a `url`, `data_base64`, or a local `path` — and get a reusable `files/<id>` reference |
| `gemini_list_files` | List the files currently uploaded under this API key, with MIME types and expiry times |
| `gemini_delete_file` | Delete an uploaded file before its ~48h expiry (confirm-gated) |

## Sending reference images without burning context

Every image tool (`gemini_image_generate`, `gemini_image_edit`, `gemini_image_set`,
`gemini_interact`) takes reference images four ways. Only one of them costs model context:

| Parameter | Where the bytes travel | Context cost |
|---|---|---|
| `images_url` (`master_images_url`) | the **server** downloads the https URL | none |
| `images_file_uris` (`master_images_file_uris`) | a `files/<id>` reference, already uploaded | none |
| `images` | read off local disk (stdio builds only) | none |
| `images_base64` | **through the tool-call JSON** | **~14k tokens per JPEG** |

`images_base64` is the fallback of last resort. It costs roughly 14k tokens per modest photo,
and it is silently corrupted whenever the file read that produced it was truncated — the
payload still looks like base64, so the failure surfaces as a bad generation rather than an
error. Prefer any of the other three.

### `images_url` — the server fetches it

```jsonc
{ "prompt": "make it look like winter", "images_url": ["https://example.com/photo.jpg"] }
```

Fetches are restricted to public `https://` URLs — private, loopback and link-local hosts are
refused (IPv6 literals are parsed, so `[::ffff:7f00:1]` is caught as loopback), every redirect
hop is revalidated, and each hop is bounded by a timeout. The response must be
`Content-Type: image/*` and is capped at **15MB**, enforced while streaming rather than trusted
from `Content-Length`. A failure names the offending URL. Anything over 6MB is uploaded to the
Files API and referenced by uri instead of inlined, since `generateContent` caps a whole
request near 20MB.

### `images_file_uris` — upload once, reference many times

```jsonc
// 1. upload
{ "tool": "gemini_upload_file", "url": "https://example.com/photo.jpg" }
// → { "file_uri": "files/abc123", "mime_type": "image/jpeg", "expires": "..." }

// 2. reference it, as many times as you like
{ "prompt": "make it winter",  "images_file_uris": ["files/abc123"] }
{ "prompt": "make it sunrise", "images_file_uris": ["files/abc123"] }
```

Uploads are retained **~48h**; after that the reference stops resolving (as a generic 404 —
see the chained-404 section above). `gemini_image_set` fetches or resolves such a reference
**once** and passes it to the master and every scene call.

On stdio builds, a local `images` path that gets referenced **more than once in a session** is
uploaded to the Files API automatically (keyed on path + mtime + size), so repeated edits of
the same photo stop re-sending the bytes. Editing the file invalidates the cached upload.

### `POST /upload` — raw bytes, no base64 at all (hosted connector)

The hosted connector exposes an HTTP upload endpoint behind the **same OAuth token as
`/mcp`**. This is the intended path for an agent with a shell: disk file → curl → `file_uri` →
tool call, with the image never entering the conversation.

```bash
curl -X POST https://connector.gemini.nullnet.app/upload \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
# → {"file_uri":"files/abc123","mime_type":"image/jpeg","expires":"...","...":"..."}
```

Then pass `"images_file_uris": ["files/abc123"]` to any image tool. The body is streamed
straight to the Files API (nothing is buffered), so `Content-Length` is required — curl sets it
automatically with `--data-binary @file`. Accepted content types are `image/*`, `video/*` and
`audio/*`; an optional `?name=` or `X-Filename` header sets the display name.

## Quick Start

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "@chrischall/gemini-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

See [SKILL.md](./skills/gemini-mcp/SKILL.md) for full usage documentation.
