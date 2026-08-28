import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { GeminiClient } from '../src/client.js';

/**
 * Invariant: `manifest.json`'s `tools` array is the tool surface a stdio
 * install actually exposes.
 *
 * This exists because it drifted the first time a tool was added.
 * `gemini_token_usage` shipped without a manifest entry, without a README row,
 * and with CLAUDE.md still claiming "11 tools" — nothing was internally
 * inconsistent enough for a person to notice, which is exactly the failure
 * mode skylight-mcp's docs-sync test was written for after its README fell
 * seven tools behind.
 *
 * The comparison is against the tools a server REGISTERS, not against a grep
 * for `gemini_*` string literals — prose and doc comments match that pattern
 * too. A client with no blob store registers the stdio surface and nothing
 * else: the hosted-only registrars (upload URLs, the character/style library)
 * self-gate on storage the local install does not have, which is what makes
 * this the right list to compare.
 */
describe('manifest.json tools', () => {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');

  it('lists exactly the tools a stdio install registers', async () => {
    const client = new GeminiClient({ apiKey: 'k' });
    const h = await createTestHarness((server) => {
      for (const register of TOOL_REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();

    const registered = tools.map((t) => t.name).sort();
    const declared = (JSON.parse(readFileSync(manifestPath, 'utf8')).tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();

    // Named diffs rather than a bare length mismatch: the failure should say
    // WHICH tool to add or drop, since that is the whole job when it fires.
    expect(registered.filter((n) => !declared.includes(n))).toEqual([]);
    expect(declared.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('agrees with the headline count in CLAUDE.md', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const declared = (JSON.parse(readFileSync(manifestPath, 'utf8')).tools as unknown[]).length;
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    const claimed = /exposes (\d+) tools/.exec(claude);
    expect(claimed, 'CLAUDE.md should state the tool count').not.toBeNull();
    expect(Number(claimed![1])).toBe(declared);
  });

  it('gives every declared tool a description, since the bundle shows them', () => {
    const tools = JSON.parse(readFileSync(manifestPath, 'utf8')).tools as Array<{ name: string; description?: string }>;
    expect(tools.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });
});
