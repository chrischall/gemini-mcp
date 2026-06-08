import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpToolError } from '@chrischall/mcp-utils';

const execFileAsync = promisify(execFile);

/**
 * Injectable runner for child-process calls so tests don't shell out.
 * Default wraps execFile.
 */
export type Runner = (cmd: string, args: string[]) => Promise<void>;

const defaultRun: Runner = async (cmd, args) => {
  await execFileAsync(cmd, args);
};

/**
 * Read the macOS system clipboard image into a base64 JPEG.
 *
 * Steps:
 *  1. osascript: write clipboard PNG to a temp file.
 *  2. sips: downscale + convert to JPEG (≤2048px, avoids 16-bit/large payloads).
 *  3. Read the JPEG → base64.
 *
 * Temp files are cleaned up in a `finally` block.
 */
export async function readClipboardImage(run: Runner = defaultRun): Promise<{ base64: string; mimeType: string }> {
  if (process.platform !== 'darwin') {
    throw new McpToolError('from_clipboard is only supported on macOS', {
      hint: 'Save the image to a file and pass it via `images` instead.',
    });
  }

  // Unique temp paths under tmpdir() — OS-controlled (/var/folders/…/T or /tmp on
  // macOS), digits+alnum id, no user input. Commands run via execFile (no shell),
  // so the only string-interpolated value (the path, in the AppleScript literal)
  // can't reach a shell; a quote-bearing TMPDIR would just yield a parse error,
  // caught as "No image found" below.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const png = join(tmpdir(), `gemini-clip-${id}.png`);
  const jpg = join(tmpdir(), `gemini-clip-${id}.jpg`);

  try {
    // Step 1: write clipboard PNG to temp file via osascript
    try {
      await run('osascript', [
        '-e', `set f to (open for access POSIX file "${png}" with write permission)`,
        '-e', 'write (the clipboard as «class PNGf») to f',
        '-e', 'close access f',
      ]);
    } catch {
      throw new McpToolError('No image found on the clipboard', {
        hint: 'Copy an image (⌘C) first, or pass `images`/`images_base64`.',
      });
    }

    // Step 2: downscale + convert to JPEG via sips
    try {
      await run('sips', ['-Z', '2048', '-s', 'format', 'jpeg', png, '--out', jpg]);
    } catch {
      throw new McpToolError('Failed to convert the clipboard image', {
        hint: 'The clipboard may contain a non-standard image format.',
      });
    }

    // Step 3: read JPEG → base64
    const buf = await readFile(jpg);
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg' };
  } finally {
    // Clean up both temp files (ignore errors if they don't exist)
    await unlink(png).catch(() => undefined);
    await unlink(jpg).catch(() => undefined);
  }
}
