import { describe, it, expect } from 'vitest';
import { loadLocalEnv } from '../src/client.js';

// Regression guard for the Cloudflare Worker startup trap (wrangler code 10021):
// in a deployed Worker `import.meta.url` is undefined, so `fileURLToPath(undefined)`
// throws during startup validation and the deploy fails. Neither
// `wrangler deploy --dry-run` nor the Miniflare test pool reproduces it, so this
// unit test is the only gate we get.
describe('loadLocalEnv', () => {
  it('does not throw when the module url is unavailable (Worker runtime)', async () => {
    await expect(loadLocalEnv(undefined)).resolves.toBe(false);
  });

  it('does not throw on a non-file module url', async () => {
    await expect(loadLocalEnv('https://example.com/worker.js')).resolves.toBe(false);
  });

  it('loads .env when given a real file module url', async () => {
    // No .env is required to exist — loadDotenvSafely swallows a missing file —
    // what matters is that the Node path resolves and returns a boolean.
    await expect(loadLocalEnv(import.meta.url)).resolves.toEqual(expect.any(Boolean));
  });
});
