import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { GeminiClient } from '../src/client.js';
import type { GeminiClient as GeminiClientType } from '../src/client.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean };
  probe: { url?: string; elapsed_ms: number };
  error?: { kind: string; message: string };
  hint: string;
}

function stub(source: string | null, probe: () => Promise<unknown>): GeminiClientType {
  return { describeCredential: () => ({ source }), listModels: probe } as unknown as GeminiClientType;
}

async function call(client: GeminiClientType) {
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
  const res = await h.client.callTool({ name: 'gemini_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('gemini_healthcheck', () => {
  it('reports ok with the resolving source', async () => {
    const r = await call(stub('env', async () => [{ name: 'models/x' }]));
    expect(r.ok).toBe(true);
    expect(r.credential).toMatchObject({ source: 'env', resolved: true });
    expect(r.probe.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });

  it('reports no_credential without probing when no key resolved', async () => {
    let probed = false;
    const r = await call(
      stub(null, async () => {
        probed = true;
        return [];
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_credential');
    expect(probed).toBe(false);
    expect(r.hint).toMatch(/GEMINI_API_KEY/);
  });

  it('tells a rejected key apart from a Google-side failure', async () => {
    const rejected = await call(
      stub('env', async () => {
        throw Object.assign(new Error('API key not valid'), { status: 403 });
      }),
    );
    expect(rejected.error?.kind).toBe('credential_rejected');
    expect(rejected.hint).toMatch(/aistudio\.google\.com/);

    const upstream = await call(
      stub('env', async () => {
        throw Object.assign(new Error('Service unavailable'), { status: 503 });
      }),
    );
    expect(upstream.error?.kind).toBe('http');
  });

  it('never reports the key itself', async () => {
    const r = await call(stub('connector-session', async () => []));
    expect(JSON.stringify(r)).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
  });
});

// describeCredential is tested against a REAL client, not the stub above:
// its whole contract is that it mirrors requireKey()'s resolution order, and a
// stub cannot show that it does.
describe('GeminiClient.describeCredential', () => {
  const saved = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  });

  it('is null when neither an injected key nor the env var is present', () => {
    expect(new GeminiClient({}).describeCredential()).toEqual({ source: null });
  });

  it('reports env when only the env var is set', () => {
    process.env.GEMINI_API_KEY = 'AIzaTESTKEY';
    expect(new GeminiClient({}).describeCredential()).toEqual({ source: 'env' });
  });

  // Mirrors requireKey's precedence: an injected key wins over the env var.
  it('prefers an injected connector key over the env var', () => {
    process.env.GEMINI_API_KEY = 'AIzaTESTKEY';
    expect(new GeminiClient({ apiKey: 'injected' }).describeCredential()).toEqual({
      source: 'connector-session',
    });
  });

  it('returns a label, never the key', () => {
    process.env.GEMINI_API_KEY = 'AIzaSUPERSECRETVALUE';
    const out = JSON.stringify(new GeminiClient({}).describeCredential());
    expect(out).not.toContain('AIzaSUPERSECRETVALUE');
  });
});
