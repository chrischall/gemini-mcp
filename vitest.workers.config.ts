import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Worker tests run in workerd, not Node: src/worker.ts imports
// 'cloudflare:workers' and 'agents', which cannot load under the Node pool.
// The Node suite (vitest.config.ts) excludes these files for the same reason.
export default defineWorkersConfig({
  test: {
    include: ['tests/worker*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
