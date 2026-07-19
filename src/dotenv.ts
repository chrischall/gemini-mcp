import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely } from '@chrischall/mcp-utils';

/**
 * The stdio server's `.env` bootstrap. **Imported only by `src/index.ts`.**
 *
 * This used to run at module scope in `src/client.ts`, which put it in the
 * hosted connector's import graph (`src/worker.ts` → `./client.js`) and so ran
 * it during Worker isolate startup. Two things go wrong there:
 *
 * 1. wrangler's bundle leaves `import.meta.url` undefined, so
 *    `fileURLToPath(import.meta.url)` threw and the isolate never booted —
 *    `The Workers runtime failed to start`. Not a test failure: a deploy
 *    failure, invisible to the workers-pool suite (see
 *    `tests/connector-boot.test.ts` for why).
 * 2. Even had it resolved, it is async I/O at global scope, which Workers
 *    forbids — and there is no `.env` on a Worker regardless. Config arrives
 *    through bindings.
 *
 * Keeping this in its own module, off `client.ts`, is what makes `client.ts`
 * side-effect-free and therefore safe to import from a Worker.
 *
 * `import.meta.url` is read inside the function body, not at module scope, so
 * merely importing this file is still inert.
 */
export async function loadStdioDotenv(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(here, '..', '.env'), override: false });
}
