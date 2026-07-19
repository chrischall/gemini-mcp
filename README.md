# gemini-mcp

[![CI](https://github.com/chrischall/gemini-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/gemini-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/gemini-mcp)](https://www.npmjs.com/package/@chrischall/gemini-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/gemini-mcp)](LICENSE)

MCP server for Google Gemini media generation. Exposes eight tools to Claude over stdio: list available models, generate/edit/compose images, generate a consistent set of images from a master prompt, multi-turn image refinement (Interactions API), **video** generation (omni), **music** generation (Lyria), and an async result poll for long generations. Output is written to disk by default (path returned) or returned inline as base64. Built on the Gemini v1beta API (`generativelanguage.googleapis.com`) using the Nano Banana / Nano Banana Pro (images), omni (video), and Lyria (music) model families.

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

After the store-lag retries are exhausted, the tool looks up that id's sidecar, re-attaches the
image it produced, and re-issues the request **without** the chain:

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
