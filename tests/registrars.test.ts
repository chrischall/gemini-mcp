import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { registerModelTools } from '../src/tools/models.js';
import type { GeminiClient } from '../src/client.js';

/**
 * The roster is WIRED for error reporting, not merely capable of it.
 *
 * `tests/errors.test.ts` proves `surfaceToolErrors` works when applied.
 * Nothing proved it was applied: deleting `.map(reporting)` left the suite
 * green while quietly restoring the failure this whole change exists to end —
 * a hosted throw arriving as an unattributed "Error occurred during tool
 * execution". Caught in review of PR #147, and the reason the roster moved out
 * of `index.ts` (an entry point that boots a server on import) and into
 * `src/registrars.ts`, where a test can reach it.
 */

/** A client whose first upstream call dies the way workerd's receiver check does. */
function exploding(): GeminiClient {
  return {
    listModels: async () => { throw new TypeError('Illegal invocation'); },
    defaultModel: () => 'gemini-3.1-flash-image',
  } as unknown as GeminiClient;
}

describe('TOOL_REGISTRARS', () => {
  it('surfaces the tool name and the real error class through the wired roster', async () => {
    // Position 0 is registerModelTools; asserted below so this cannot silently
    // start testing a different tool.
    const h = await createTestHarness((s) => TOOL_REGISTRARS[0]!(s, exploding()));
    const res = await h.callTool('gemini_list_models', {});
    await h.close();

    expect(res.isError).toBe(true);
    expect(String((res.content as Array<{ text: string }>)[0]!.text)).toBe(
      'gemini_list_models failed: TypeError: Illegal invocation',
    );
  });

  it('is the same registrar, just wrapped — an unwrapped one loses the attribution', async () => {
    // The control: this is exactly what the roster looked like before, and
    // exactly what a future `.map(reporting)` deletion would restore.
    const h = await createTestHarness((s) => registerModelTools(s, exploding()));
    const res = await h.callTool('gemini_list_models', {});
    await h.close();

    expect(String((res.content as Array<{ text: string }>)[0]!.text)).not.toContain('gemini_list_models failed');
  });

  it('wraps every registrar, not just the first', async () => {
    const raw = [
      'registerModelTools', 'registerGenerateTools', 'registerSetTools', 'registerInteractTools',
      'registerVideoTools', 'registerMusicTools', 'registerJobTools', 'registerFileTools',
      'registerUploadUrlTools', 'registerLibraryTools',
    ];
    expect(TOOL_REGISTRARS).toHaveLength(raw.length);
    // A wrapped registrar is an anonymous arrow, never the named import — so a
    // roster with one entry left unwrapped fails here.
    expect(TOOL_REGISTRARS.map((r) => r.name).filter((n) => raw.includes(n))).toEqual([]);
  });

  it('is what index.ts actually passes to runMcp', () => {
    // The roster can only defend the entry point if the entry point uses it.
    const source = readFileSync('src/index.ts', 'utf8');
    expect(source).toContain('tools: TOOL_REGISTRARS');
    expect(source).not.toMatch(/tools:\s*\[/);
  });
});
