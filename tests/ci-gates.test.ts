import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

/**
 * CI runs exactly one command — `npm test` (see `.github/workflows/ci.yml`,
 * which delegates to the shared reusable workflow with `test-command: npm test`).
 * Anything not reachable from that script does not run in CI at all.
 *
 * A suite `npm test` does not reach is easy to leave stranded: nothing fails
 * when it is missing, coverage just quietly stops. These gates assert the
 * wiring instead of trusting it.
 *
 * They live in `npm test` rather than in the workflow file on purpose: a
 * PR that edits `.github/workflows/*` cannot be auto-reviewed (the App validates
 * the workflow against the default branch), so keeping the wiring in
 * package.json keeps this repo on the normal review path.
 */
describe('CI gates', () => {
    it('still runs the node typecheck and suite', () => {
    expect(pkg.scripts.test).toContain('typecheck');
    expect(pkg.scripts.test).toContain('vitest run');
  });
});
