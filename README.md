# gemini-image-mcp

MCP server for Google Gemini image generation and editing. Exposes four tools to Claude over stdio: list available models, generate images from text prompts, edit or compose images with text instructions, and generate a consistent set of images from a master prompt. Images are written to disk by default (path returned) or returned inline as base64. Built on the Gemini v1beta API (`generativelanguage.googleapis.com`) using the Nano Banana / Nano Banana Pro model family.

Developed and maintained by AI (Claude Code).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Your Google Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) |
| `GEMINI_IMAGE_MODEL` | No | Override the default image model (default: `gemini-3-pro-image`) |
| `GEMINI_OUTPUT_DIR` | No | Default directory for generated images (default: current working directory) |

## Tools

| Tool | Description |
|------|-------------|
| `gemini_list_models` | List available Gemini image models and the current default |
| `gemini_generate_image` | Generate image(s) from a text prompt |
| `gemini_edit_image` | Edit or compose one or more input images with a text instruction |
| `gemini_generate_set` | Generate a master image plus N consistent images referencing it |

## Quick Start

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

See [SKILL.md](./SKILL.md) for full usage documentation.
