import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../vitest.config.js';

/**
 * Guards the worktree exclusion. Agent worktrees live at
 * `.claude/worktrees/<name>/` — a complete checkout of this repo — so without an
 * explicit exclude, vitest collects each copy's tests as if they were ours. That
 * failure is silent and actively misleading: the suite still passes, the count
 * just quietly multiplies, and any failure in a half-finished branch shows up as
 * a failure "here".
 */
describe('vitest config', () => {
  const exclude = (config as { test?: { exclude?: string[] } }).test?.exclude ?? [];

  it('excludes agent worktrees from test collection', () => {
    expect(exclude).toContain('**/.claude/**');
  });

  it('keeps vitest\'s default excludes rather than replacing them', () => {
    // `exclude` overrides the defaults wholesale — dropping them would pull
    // node_modules and dist back into collection.
    for (const def of configDefaults.exclude) expect(exclude).toContain(def);
  });
});
