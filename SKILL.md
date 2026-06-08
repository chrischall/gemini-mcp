---
name: gemini-mcp
description: Generate and edit images with Google Gemini image models via MCP. Use when the user asks to generate, create, or edit images using Gemini or Nano Banana models, wants to produce a consistent set of images from a prompt, or needs to compose/blend multiple images. Triggers on phrases like "generate an image of", "edit this image with Gemini", "create a set of consistent images", "use Nano Banana to make", or any request to produce images via the Gemini image API. Requires the @chrischall/gemini-mcp package installed and the gemini server registered (see Setup below).
---

# gemini-mcp

MCP server for Google Gemini image generation and editing — natural-language image creation via the Gemini API (Nano Banana / Nano Banana Pro models).

- **npm:** [npmjs.com/package/@chrischall/gemini-mcp](https://www.npmjs.com/package/@chrischall/gemini-mcp)
- **Source:** [github.com/chrischall/gemini-mcp](https://github.com/chrischall/gemini-mcp)

## Setup

### Option A — npx (recommended)

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

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

### Option B — from source

```bash
git clone https://github.com/chrischall/gemini-mcp
cd gemini-mcp
npm install && npm run build
```

Then add to `.mcp.json`:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/path/to/gemini-mcp/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or use a `.env` file in the project directory with `GEMINI_API_KEY=<value>`.

### Getting your API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create an API key (requires a Google account)
3. Copy the key and set it as `GEMINI_API_KEY`

Note: Image generation requires a billing-enabled Google Cloud project.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Your Google Gemini API key |
| `GEMINI_IMAGE_MODEL` | No | Override the default image model (default: `gemini-3-pro-image`) |
| `GEMINI_OUTPUT_DIR` | No | Default directory for saved images (default: current working directory) |

## Tools

### Models
| Tool | Description |
|------|-------------|
| `gemini_list_models` | List available Gemini image models and the current default |

### Image Generation
| Tool | Description |
|------|-------------|
| `gemini_generate_image(prompt, count?, images?, images_base64?, seed?, filename?, model?, aspect_ratio?, image_size?, output_dir?, inline?)` | Generate image(s) from a text prompt (optionally image-conditioned via `images`/`images_base64`) |
| `gemini_edit_image(prompt, images?, images_base64?, seed?, filename?, model?, aspect_ratio?, image_size?, output_dir?, inline?)` | Edit or compose input image(s) — by **path** (`images`) or **value** (`images_base64`: data URI or raw base64) — with a text instruction. Requires ≥1 input |
| `gemini_generate_set(master_prompt, scenes? \| count?, reference_mode?, master_images?, master_images_base64?, seed?, basename?, model?, ...)` | Master image (optionally seeded from a reference photo) plus N consistent images referencing it |

## Workflows

**Generate a single image:**
```
gemini_generate_image(prompt: "a red maple leaf on white background, studio photo")
→ returns path to saved PNG
```

**Generate multiple variations:**
```
gemini_generate_image(prompt: "a cartoon fox", count: 4, output_dir: "/tmp/foxes")
→ returns paths to 4 PNG files
```

**Edit an existing image:**
```
gemini_edit_image(prompt: "make the background blue", images: ["/path/to/image.png"])
→ returns path to edited PNG
```

**Generate a consistent set (master + scenes):**
```
gemini_generate_set(
  master_prompt: "a cartoon fox named Rusty, orange fur, blue scarf",
  scenes: ["Rusty waving hello", "Rusty eating an apple", "Rusty sleeping"]
)
→ returns paths to master + 3 scene images, all consistent
```

**Generate variations of a concept:**
```
gemini_generate_set(
  master_prompt: "minimalist logo for a coffee shop",
  count: 5
)
→ returns master + 5 variations
```

**Use a reference photo by value (no file needed):**
```
gemini_edit_image(
  prompt: "place this house on a vintage travel-poster background",
  images_base64: ["data:image/jpeg;base64,/9j/4AAQ..."]   // or raw base64
)
→ returns path to the edited image
```
Pasted/attached images aren't written to disk by the host, so pass their bytes via `images_base64` (a `data:` URI or raw base64) instead of a path.

## Notes

- **Input images** accept either file **paths** (`images` / `master_images`) or **base64/data-URI values** (`images_base64` / `master_images_base64`).
- **`seed`** makes a result reproducible; it's echoed in the result metadata (a random one is chosen + echoed when omitted). `count>1` uses `seed, seed+1, …` so the images differ. Determinism isn't fully guaranteed by the model.
- **`filename`/`basename`** set the output name (extension stripped); names never overwrite (a `-2`, `-3` suffix is added). The result echoes the absolute path(s), `model`, `seed`, and aspect/size.
- **No edit-strength control.** Gemini exposes no denoise/strength knob, and Nano Banana over-preserves the input — big structural edits ("move/remove/shrink", add a mat border) are often ignored. Workarounds: reroll with a different `seed`, use forceful wording, or do layout changes (padding/borders) with an external tool.
- `output_dir` per-call overrides `$GEMINI_OUTPUT_DIR` overrides cwd. `inline: true` returns bytes (with a metadata text block) instead of writing.
- `count` and `scenes` are mutually exclusive in `gemini_generate_set`; `reference_mode: "chain"` references the previous image instead of the master.
- Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`, … · Image sizes: `1K`, `2K`, `4K` (Pro). `4K` is the max native output — true 18×24 in @ 300 DPI (5400×7200) needs an external upscale step.
- The model can mis-render text/Roman numerals (e.g. years) — verify any text in the output; it's a model limitation, not a tool setting.
- Server logs to stderr only — stdout is reserved for JSON-RPC.
