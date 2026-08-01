import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No source or test file may contain a literal NUL byte.
 *
 * A single literal NUL makes git classify the whole file as binary: no diff on
 * GitHub, no review, and ripgrep skips it. That is precisely how the signed
 * upload-URL module — the security-critical one — once shipped with no
 * reviewable diff at all (auto-review of PR #126 caught it). The convention is
 * documented at fingerprintRequest (src/jobs.ts): write the escape, never the
 * byte. This test makes the convention load-bearing.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|js|json|md)$/.test(name)) out.push(path);
  }
  return out;
}

describe('source hygiene', () => {
  it('no src/ or tests/ file contains a literal NUL byte', () => {
    const offenders = [...walk('src'), ...walk('tests')].filter((path) => readFileSync(path).includes(0));
    expect(offenders).toEqual([]);
  });
});
