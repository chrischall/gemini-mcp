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
 * The worker suite and the worker typecheck are the only things that cover
 * `src/worker.ts` / `src/gemini-auth.ts`, and they need the workers pool
 * (workerd) rather than the node pool — so they are easy to leave stranded,
 * exactly as they were when the connector first landed. Nothing fails when they
 * are missing; coverage just quietly stops.
 *
 * These gates live in `npm test` rather than in the workflow file on purpose: a
 * PR that edits `.github/workflows/*` cannot be auto-reviewed (the App validates
 * the workflow against the default branch), so keeping the wiring in
 * package.json keeps this repo on the normal review path.
 */
describe('CI gates', () => {
  it('runs the worker suite as part of `npm test`', () => {
    expect(pkg.scripts.test).toContain('worker:test');
  });

  it('typechecks the worker sources', () => {
    // worker:test chains worker:typecheck — that is the only thing that
    // typechecks src/worker.ts (tsconfig.json excludes it so the stdio build
    // does not emit dist/worker.js).
    expect(pkg.scripts['worker:test']).toContain('worker:typecheck');
    expect(pkg.scripts['worker:typecheck']).toContain('tsconfig.worker.json');
  });

  it('still runs the node typecheck and suite', () => {
    expect(pkg.scripts.test).toContain('typecheck');
    expect(pkg.scripts.test).toContain('vitest run');
  });
});
