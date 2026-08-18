/**
 * Making a failure say what actually failed.
 *
 * A hosted `gemini_get_upload_url` call came back to the client as
 * `{"error": "Error occurred during tool execution", "request_id": "req_…"}` —
 * no message, no failing step, no stack. That outer wrapper is the client's and
 * not ours to change, but it is only ever reached when what we hand back is
 * itself uninformative, and two of this repo's habits make that likely:
 *
 *  - a thrown non-`McpToolError` surfaces as bare `err.message`, which for a
 *    runtime fault (`Illegal invocation`, `fetch failed`) names neither the
 *    tool nor the operation that was in flight; and
 *  - `cause` is dropped by MCP serialization, so a wrapped error arrives with
 *    its actual root cause deleted — the trap `ChainedRequest404Error` in
 *    client.ts already documents for `hint`, which the host drops too.
 *
 * So: {@link describeError} flattens the whole chain into the message,
 * {@link step} labels the operation, and {@link surfaceToolErrors} wraps a
 * server so EVERY registered handler gets both without each registrar
 * remembering to. `index.ts` applies it to every registrar in the list.
 */

import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** How far down a `cause` chain to walk before assuming it is pathological. */
const MAX_CAUSE_DEPTH = 5;

/**
 * One flat, self-describing line for anything throwable — including the
 * `cause` chain, which MCP serialization deletes.
 *
 * The error's class name is prefixed only when it carries information: a bare
 * `Error` says nothing a reader does not already know, while `TypeError:
 * Illegal invocation` is the entire diagnosis of the workerd receiver bug (see
 * the fetchImpl note in CLAUDE.md).
 */
export function describeError(err: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (!(value instanceof Error)) {
      if (typeof value === 'string') return value;
      try {
        return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
      } catch {
        return String(value);
      }
    }
    // A generic `Error` name is noise; anything else is the diagnosis.
    const named = value.name && value.name !== 'Error' && value.name !== 'McpToolError'
      ? `${value.name}: ${value.message}`
      : value.message;
    const hint = value instanceof McpToolError && value.hint && !value.message.includes(value.hint)
      ? ` ${value.hint}`
      : '';
    const cause = (value as { cause?: unknown }).cause;
    // Self-referential and over-deep chains are real (a retry wrapper that
    // re-wraps its own error); walking one forever is not an option.
    if (cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH || seen.has(cause)) {
      return `${named}${hint}`;
    }
    seen.add(cause);
    return `${named}${hint} [caused by: ${describe(cause, depth + 1)}]`;
  };
  seen.add(err);
  return describe(err, 0);
}

/**
 * Run one named operation, and on failure say which one it was.
 *
 * Only the INNERMOST step labels: an already-labelled failure passes straight
 * through, so a nested `step` reports `signing the upload URL: …` rather than
 * `minting: signing the upload URL: …`. The label is what the caller needs;
 * the call stack above it is not.
 */
export async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError(`${label}: ${describeError(err)}`, err);
  }
}

/** An `McpToolError` that has already been attributed to a step. */
class StepError extends McpToolError {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'McpToolError';
  }
}

/**
 * Wrap a server so every tool registered through it reports failures fully.
 *
 * A `Proxy` rather than a spread: `McpServer` methods are bound to real private
 * state, and registrars reach for more than `registerTool` (`server.server`,
 * `registerResource`). Everything but `registerTool` passes through untouched,
 * and a successful result is returned byte-identically — this only ever changes
 * what an exception looks like.
 */
export function surfaceToolErrors(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
        (value as (...a: unknown[]) => unknown).call(target, name, config, async (...args: unknown[]) => {
          try {
            return await handler(...args);
          } catch (err) {
            // Named for the tool AND the underlying error. When the client
            // still shows its own generic wrapper, this text is what a
            // maintainer has to work from — so it carries everything.
            throw new McpToolError(`${name} failed: ${describeError(err)}`, { cause: err });
          }
        });
    },
  });
}
