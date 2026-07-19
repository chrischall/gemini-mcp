import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's default excludes cover node_modules/dist but NOT `.claude/`, which
    // is where git worktrees are created (`.claude/worktrees/<name>/` — a full
    // checkout of this repo, tests and all). Without this, every worktree's copy
    // of the suite is collected alongside the real one: a single stale worktree
    // silently turned `316 tests` into `613`, and four of them into `1963` with
    // spurious failures from half-finished branches. The count looks healthy, so
    // nothing flags it — you just stop being able to trust the number.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});
