import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * AGENTS.md is CLAUDE.md for a different audience. Keeping two copies by hand
 * is how this repo came to tell readers to look in `.Codex-plugin/` — a
 * directory that has never existed — along with a nonexistent
 * `~/Library/Logs/Codex/` path, a `Codex.ai` domain, and `MCP_TOOL_TIMEOUT`
 * attributed to the wrong tool. A Claude -> Codex find/replace had rewritten
 * facts, not just branding, and nothing here referenced AGENTS.md at all, so
 * nothing noticed for months.
 *
 * These are the ONLY legitimate differences. Anything else is drift.
 * `mcp-utils/scripts/sync-agents-md.mjs` applies the same list.
 */
const SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^# CLAUDE\.md/m, '# AGENTS.md'],
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  [/^Guidance for Claude working in this repo\./m, 'Guidance for coding agents working in this repo.'],
];

describe('AGENTS.md stays in sync with CLAUDE.md', () => {
  it('is CLAUDE.md with only the documented substitutions', () => {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const expected = SUBSTITUTIONS.reduce((s, [from, to]) => s.replace(from, to), claude);

    // Compared line by line: a whole-file mismatch prints two 800-line blobs
    // and tells you nothing about WHICH line drifted.
    const want = expected.split('\n');
    const have = agents.split('\n');
    const drifted = want
      .map((line, i) => (have[i] === line ? null : { line: i + 1, want: line, have: have[i] }))
      .filter(Boolean);

    expect(drifted, 'run `node ../mcp-utils/scripts/sync-agents-md.mjs .` to regenerate').toEqual([]);
    expect(have).toHaveLength(want.length);
  });

  it('never calls a Claude artifact a Codex one', () => {
    // The specific corruption class: paths and product names that name
    // CLAUDE things. `~/.codex/AGENTS.md` is the one legitimate Codex path.
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const offenders = [...agents.matchAll(/^.*\bCodex\b.*$/gm)]
      .map((m) => m[0].trim())
      .filter((l) => !l.includes('~/.codex/AGENTS.md'));
    expect(offenders).toEqual([]);
  });
});
