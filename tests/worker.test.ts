import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Smoke test: proves `npm run worker:test` actually boots workerd against
// wrangler.jsonc and that its exit code means something. Without a test here
// the command would pass vacuously with zero suites.
describe('worker runtime smoke', () => {
  it('exposes the bindings wrangler.jsonc declares', () => {
    expect(env.OAUTH_KV).toBeTruthy();
    expect(env.MEDIA_BUCKET).toBeTruthy();
    expect(env.MCP_OBJECT).toBeTruthy();
  });

  it('answers the health probe used to verify a deploy', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, service: 'gemini-connector' });
  });

  it('404s an unknown path', async () => {
    const res = await SELF.fetch('https://example.com/nope');
    expect(res.status).toBe(404);
  });
});
