import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { GeminiClient } from '../src/client.js';

/**
 * The tool surface is a standing token cost.
 *
 * Every request a host makes carries the whole `tools/list` payload — 13 tools
 * of descriptions and JSON Schema — before the conversation has said anything.
 * At roughly four bytes to the token it was ~11.9k tokens before the trim that
 * introduced this test, which is real money on every single call and context
 * that the actual work does not get to use.
 *
 * So it gets a budget. This is not a style rule: a new parameter is welcome,
 * and raising the ceiling deliberately is a one-line change. What it stops is
 * the surface drifting upward a paragraph at a time, which is exactly how it
 * got there — nobody adds 12k tokens on purpose.
 *
 * When this fails, the question to ask is which of the two: has a param earned
 * its place (raise the number, in its own commit), or has a description grown
 * a rationale that belongs in a doc comment where it costs nothing?
 */

/**
 * Bytes of `tools/list` JSON, at roughly four bytes to the token.
 *
 * 47,542 before the trim (~11.9k tokens), 43,456 after (~10.9k). The ceiling
 * sits above the second figure with room for a parameter or two, and well
 * below the first.
 */
const BUDGET_BYTES = 44_000;

/** No single tool should dominate — the largest today is ~7.5KB. */
const PER_TOOL_BUDGET_BYTES = 9_000;

async function toolSurface(): Promise<{ name: string; bytes: number }[]> {
  // No blob store, so this is the stdio surface: the hosted-only registrars
  // self-gate off. It is the floor every install pays.
  const client = new GeminiClient({ apiKey: 'k' });
  const h = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools.map((t) => ({ name: t.name, bytes: JSON.stringify(t).length }));
}

describe('tool surface size', () => {
  it('fits the whole stdio tool list in the budget', async () => {
    const tools = await toolSurface();
    const total = tools.reduce((n, t) => n + t.bytes, 0);
    expect(total, `tools/list is ${total} bytes (~${Math.round(total / 4)} tokens)`).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it('keeps any one tool from dominating the surface', async () => {
    const tools = await toolSurface();
    const worst = tools.reduce((a, b) => (a.bytes > b.bytes ? a : b));
    expect(worst.bytes, `${worst.name} is ${worst.bytes} bytes`).toBeLessThanOrEqual(PER_TOOL_BUDGET_BYTES);
  });
});
