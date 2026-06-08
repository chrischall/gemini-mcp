---
name: gemini-mcp
description: Generate and edit images with Google Gemini image models via MCP. Use when the user asks to generate, create, or edit images using Gemini or Nano Banana models, wants to produce a consistent set of images from a prompt, or needs to compose/blend multiple images. Triggers on phrases like "generate an image of", "edit this image with Gemini", "create a set of consistent images", "use Nano Banana to make", or any request to produce images via the Gemini image API. Requires the gemini-image-mcp package installed and the gemini server registered (see Setup below).
---

# gemini-mcp

MCP server for Google Gemini image generation and editing — natural-language image creation via the Gemini API (Nano Banana / Nano Banana Pro models).

- **npm:** [npmjs.com/package/gemini-image-mcp](https://www.npmjs.com/package/gemini-image-mcp)
- **Source:** [github.com/chrischall/gemini-mcp](https://github.com/chrischall/gemini-mcp)

## Setup

### Option A — npx (recommended)

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "gemini-image-mcp"],
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
| `gemini_generate_image(prompt, count?, model?, aspect_ratio?, image_size?, output_dir?, inline?)` | Generate image(s) from a text prompt |
| `gemini_edit_image(prompt, images[], model?, aspect_ratio?, image_size?, output_dir?, inline?)` | Edit or compose one or more input images with a text instruction |
| `gemini_generate_set(master_prompt, scenes? \| count?, reference_mode?, model?, ...)` | Generate a master image plus N consistent images referencing it |

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

## Notes

- `output_dir` per-call overrides `$GEMINI_OUTPUT_DIR` which overrides the current working directory
- `inline: true` returns image bytes directly in the response instead of writing to disk
- `count` and `scenes` are mutually exclusive in `gemini_generate_set`
- `reference_mode: "chain"` makes each scene reference the previous image (vs. all referencing master)
- Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`, and others
- Image sizes: `1K`, `2K`, `4K`
- Server logs to stderr only — stdout is reserved for JSON-RPC
