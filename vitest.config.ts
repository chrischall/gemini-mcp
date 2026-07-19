import { defineConfig, configDefaults } from 'vitest/config';

// The NODE suite. Worker files import 'cloudflare:workers' / 'agents', which
// only resolve inside workerd — they run under vitest.workers.config.ts
// (`npm run worker:test`) instead, and are excluded here (and from coverage).
export default defineConfig({
  test: {
    // Spread `configDefaults.exclude` rather than hand-listing node_modules/dist:
    // setting `exclude` REPLACES the defaults wholesale, so an explicit list
    // quietly drops the rest of them.
    //
    // `**/.claude/**` covers agent worktrees (`.claude/worktrees/<name>/` is a
    // full checkout of this repo, tests and all). Without it, every worktree's
    // copy of the suite is collected alongside the real one: one stale worktree
    // turned `316 tests` into `613`, and four into `1963` with spurious failures
    // from half-finished branches. It still passes, so nothing flags it — you
    // just stop being able to trust the number.
    exclude: [...configDefaults.exclude, '**/.claude/**', 'tests/worker*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/worker.ts', 'src/gemini-auth.ts'],
    },
  },
});
