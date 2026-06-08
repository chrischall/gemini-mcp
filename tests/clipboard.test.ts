import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- types for the injected runner ---
type Runner = (cmd: string, args: string[]) => Promise<void>;

// Dynamically import so we can control platform
async function importClipboard() {
  return import('../src/clipboard.js');
}

// A minimal 1×1 JPEG (FF D8 FF)
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const JPEG_B64 = JPEG_BYTES.toString('base64');

let tempDir: string;
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
  vi.restoreAllMocks();
});

describe('readClipboardImage (darwin)', () => {
  it('calls osascript then sips and returns base64 JPEG', async () => {
    if (process.platform !== 'darwin') return; // skip non-mac CI

    const calls: Array<{ cmd: string; args: string[] }> = [];

    // Fake runner: osascript writes PNG bytes to the temp path, sips writes JPEG to out path
    const fakeRunner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'osascript') {
        // Find the PNG path in args: `-e` `set f to (open for access POSIX file "<path>" …)`
        const setPart = args.find((a) => a.startsWith('set f to'));
        const match = setPart?.match(/POSIX file "([^"]+)"/);
        if (match) {
          // Write fake PNG bytes so the file exists (sips step will convert it)
          writeFileSync(match[1], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
      } else if (cmd === 'sips') {
        // sips: args = ['-Z', '2048', '-s', 'format', 'jpeg', <png>, '--out', <jpg>]
        const outIdx = args.indexOf('--out');
        if (outIdx !== -1) {
          writeFileSync(args[outIdx + 1], JPEG_BYTES);
        }
      }
    };

    const { readClipboardImage } = await importClipboard();
    const result = await readClipboardImage(fakeRunner);

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.base64).toBe(JPEG_B64);

    // osascript call
    const osaCall = calls.find((c) => c.cmd === 'osascript');
    expect(osaCall).toBeDefined();
    expect(osaCall!.args[0]).toBe('-e');

    // sips call
    const sipsCall = calls.find((c) => c.cmd === 'sips');
    expect(sipsCall).toBeDefined();
    expect(sipsCall!.args).toContain('-Z');
    expect(sipsCall!.args).toContain('2048');
    expect(sipsCall!.args).toContain('jpeg');
  });

  it('throws "No image found on the clipboard" when osascript rejects', async () => {
    if (process.platform !== 'darwin') return;

    const failRunner: Runner = async (cmd) => {
      if (cmd === 'osascript') throw new Error('clipboard empty');
    };

    const { readClipboardImage } = await importClipboard();
    await expect(readClipboardImage(failRunner)).rejects.toThrow(/No image found on the clipboard/);
  });

  it('cleans up temp files even when sips fails', async () => {
    if (process.platform !== 'darwin') return;

    let pngPath = '';
    const failRunner: Runner = async (cmd, args) => {
      if (cmd === 'osascript') {
        const setPart = args.find((a) => a.startsWith('set f to'));
        const match = setPart?.match(/POSIX file "([^"]+)"/);
        if (match) {
          pngPath = match[1];
          writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
      } else if (cmd === 'sips') {
        throw new Error('sips failed');
      }
    };

    const { readClipboardImage } = await importClipboard();
    await expect(readClipboardImage(failRunner)).rejects.toThrow();
    // PNG temp file should be cleaned up
    if (pngPath) {
      const { existsSync } = await import('node:fs');
      expect(existsSync(pngPath)).toBe(false);
    }
  });
});

describe('readClipboardImage (non-darwin guard)', () => {
  it('throws McpToolError on non-darwin platforms', async () => {
    // Temporarily override process.platform
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const { readClipboardImage } = await importClipboard();
      await expect(readClipboardImage()).rejects.toThrow(/macOS/);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });
});
