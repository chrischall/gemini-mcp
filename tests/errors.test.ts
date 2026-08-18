import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpToolError, textResult } from '@chrischall/mcp-utils';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { describeError, surfaceToolErrors, step } from '../src/errors.js';

/**
 * The bug this defends against is a debugging one, and it cost a round trip:
 * a hosted `gemini_get_upload_url` failure came back as
 * `{"error": "Error occurred during tool execution", "request_id": "…"}` with
 * no message, no failing step and no stack — enough to know something broke
 * and nothing else.
 *
 * We do not own that outer wrapper (it is the client's), so the only lever is
 * to make sure the text WE hand back is never the thing that is empty: every
 * escaping throw becomes a message naming the tool, the step, the error class,
 * and the whole `cause` chain — which MCP serialization drops on the floor.
 */

function fail(err: unknown) {
  return async () => { throw err; };
}

describe('describeError', () => {
  it('names the error class alongside the message', () => {
    expect(describeError(new TypeError('Illegal invocation'))).toBe('TypeError: Illegal invocation');
  });

  it('does not prefix a plain Error, whose class name carries no information', () => {
    expect(describeError(new Error('blob put failed (403)'))).toBe('blob put failed (403)');
  });

  it('walks the cause chain, which MCP serialization drops', () => {
    const root = new TypeError('fetch failed');
    const mid = new Error('blob put failed (500)', { cause: root });
    const top = new McpToolError('could not store the upload', { cause: mid });
    expect(describeError(top)).toBe(
      'could not store the upload [caused by: blob put failed (500) [caused by: TypeError: fetch failed]]',
    );
  });

  it('survives a thrown non-Error', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError({ status: 403 })).toContain('403');
  });

  it('stops walking a self-referential cause instead of hanging', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(describeError(err)).toBe('loop');
  });
});

describe('step', () => {
  it('labels the failing step and keeps the original as the cause', async () => {
    const err = await step('signing the upload URL', fail(new TypeError('Illegal invocation'))).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toBe('signing the upload URL: TypeError: Illegal invocation');
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('passes a success straight through', async () => {
    await expect(step('minting', async () => 'ok')).resolves.toBe('ok');
  });

  it('does not re-label a step that already failed deeper in', async () => {
    const inner = step('signing', fail(new Error('no key')));
    const err = await step('minting', () => inner).catch((e) => e);
    expect(err.message).toBe('signing: no key');
  });
});

describe('surfaceToolErrors', () => {
  async function harness(handler: () => Promise<unknown>) {
    return createTestHarness((s) => {
      surfaceToolErrors(s).registerTool(
        'gemini_demo',
        { description: 'demo', inputSchema: { a: z.string().optional() } },
        handler as never,
      );
    });
  }

  it('turns an escaping throw into a message naming the tool and the real error', async () => {
    const h = await harness(fail(new TypeError('Illegal invocation')));
    const res = await h.callTool('gemini_demo', {});
    await h.close();
    expect(res.isError).toBe(true);
    const text = String((res.content as Array<{ text: string }>)[0]!.text);
    expect(text).toContain('gemini_demo failed');
    expect(text).toContain('TypeError: Illegal invocation');
  });

  it('keeps the hint in the MESSAGE, since the host shows the message and drops the hint', async () => {
    const h = await harness(fail(new McpToolError('no signing key', { hint: 'set MCP_BLOB_SIGNING_KEY' })));
    const res = await h.callTool('gemini_demo', {});
    await h.close();
    const text = String((res.content as Array<{ text: string }>)[0]!.text);
    expect(text).toContain('no signing key');
    expect(text).toContain('set MCP_BLOB_SIGNING_KEY');
  });

  it('leaves a successful result completely untouched', async () => {
    const h = await harness(async () => textResult({ ok: true }));
    const res = await h.callTool('gemini_demo', {});
    await h.close();
    expect(res.isError).toBeFalsy();
    expect(String((res.content as Array<{ text: string }>)[0]!.text)).toContain('"ok": true');
  });

  it('forwards every other server method, so registrars see a normal McpServer', async () => {
    const h = await createTestHarness((s) => {
      const wrapped = surfaceToolErrors(s);
      expect(typeof wrapped.registerResource).toBe('function');
      expect(wrapped.server).toBe(s.server);
      wrapped.registerTool('gemini_demo', { description: 'd', inputSchema: {} }, (async () => textResult({})) as never);
    });
    expect((await h.listTools!()).map((t: { name: string }) => t.name)).toEqual(['gemini_demo']);
    await h.close();
  });
});
