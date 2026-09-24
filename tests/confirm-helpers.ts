import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';

/** Phase 1 of the confirm-token flow: what a gated call returns before any write. */
export interface ConfirmationRequired {
  status: string;
  action: string;
  confirmToken: string;
  preview: Record<string, unknown>;
}

/** Call a gated tool once (phase 1) and return its parsed confirmation-required body. */
export async function phaseOne(h: TestHarness, name: string, args: Record<string, unknown>): Promise<ConfirmationRequired> {
  const res = await h.callTool(name, args);
  const body = parseToolResult<ConfirmationRequired>(res);
  if (body.status !== 'confirmation-required' || !body.confirmToken) {
    throw new Error(`expected ${name} to return confirmation-required, got ${JSON.stringify(res.content)}`);
  }
  return body;
}

/**
 * Run a gated tool through both phases the way a client without elicitation
 * does: the first call previews and hands back a token, the second repeats the
 * same arguments with it and performs the write.
 */
export async function callConfirmed(h: TestHarness, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { confirmToken } = await phaseOne(h, name, args);
  return h.callTool(name, { ...args, confirmToken });
}
