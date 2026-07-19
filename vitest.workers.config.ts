import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs `tests/worker*.test.ts` inside the real Workers runtime (via Miniflare),
// against `wrangler.jsonc`'s bindings (the `GeminiMcpAgent` Durable Object +
// `OAUTH_KV` + `MEDIA_BUCKET`). Kept separate from the stdio suite's
// `vitest.config.ts` / `npm test`, which runs under Node and never touches this
// file — worker sources import 'cloudflare:workers' / 'agents', which only
// resolve inside workerd.
//
// NOTE: `cloudflareTest` (a plugin), not the v3-era `defineWorkersConfig`. The
// 0.18 line (vitest 4) dropped both that symbol and the './config' subpath —
// importing it fails at config load, before a single test runs.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/worker*.test.ts'],
  },
});
