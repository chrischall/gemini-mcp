import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * chrischall/fleet-audit#471: src/ comments justified the session design by
 * pointing at `src/worker.ts`, `tests/connector-boot.test.ts` and
 * `media-cleanup.ts` long after all three were deleted with the Cloudflare
 * Worker. A comment that cites a file is a claim that the file exists; a
 * reader following it should find it.
 */
describe('src/ comments cite files that exist', () => {
  it('every src/… or tests/… path named in src/ exists', () => {
    const dangling: string[] = [];
    for (const file of walk('src')) {
      for (const [ref] of readFileSync(file, 'utf8').matchAll(/\b(?:src|tests)\/[\w./-]+\.ts\b/g)) {
        if (!existsSync(ref)) dangling.push(`${file}: ${ref}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('no src/ comment cites the retired media-cleanup module', () => {
    const offenders = walk('src').filter((f) => readFileSync(f, 'utf8').includes('media-cleanup'));
    expect(offenders).toEqual([]);
  });
});

/**
 * Auto-review follow-up #286: after the Worker was retired, CLAUDE.md and
 * AGENTS.md still justified per-session state with "one isolate serves many
 * authenticated sessions" / "one process can serve several sessions" — the
 * opposite of the one-user-per-process invariant src/session.ts documents.
 * The agent docs must describe the deployment that exists.
 */
describe('agent docs describe the one-user-per-process deployment', () => {
  const retired = [/isolate serves many/i, /process can serve several sessions/i, /session\s+in that isolate/i];
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    it(`${doc} does not describe a live multi-tenant isolate`, () => {
      const text = readFileSync(doc, 'utf8').replace(/\s+/g, ' ');
      expect(retired.filter((re) => re.test(text)).map(String)).toEqual([]);
    });
  }
});
