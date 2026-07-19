import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end boot guard for the hosted connector — the Worker sibling of
 * `server-boot.test.ts`.
 *
 * **Why this test cannot live in the workers pool.** `tests/worker.test.ts`
 * runs under @cloudflare/vitest-pool-workers, which loads modules through
 * Vite. Vite defines `import.meta.url` for every module, so a module-scope
 * `fileURLToPath(import.meta.url)` resolves there and the whole suite stays
 * green — while the real `wrangler` bundle leaves `import.meta.url` undefined
 * and the isolate dies on startup with:
 *
 *     Uncaught TypeError: The "path" argument must be of type string or an
 *     instance of URL. Received undefined
 *         at fileURLToPath
 *
 * That is a deploy-only failure class: twelve green workers-pool tests, zero
 * booting Workers. The only thing that catches it is booting the actual
 * wrangler bundle, so this test does exactly that — `wrangler dev --local`,
 * then one unauthenticated request that the OAuth provider answers.
 *
 * Practical consequence for `src/`: **anything wrangler bundles must be free of
 * module-scope `import.meta.url`, top-level `await`, and I/O.** The stdio
 * dotenv bootstrap lives in `src/dotenv.ts`, imported only by `src/index.ts`,
 * precisely so it stays out of the Worker's import graph.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * `--port 0` lets the OS pick a free port; the real one is parsed back out of
 * wrangler's "Ready on" line. A hardcoded port makes this test fail as a port
 * collision (from a stray `wrangler dev`, or a parallel CI job) rather than as
 * the boot regression it exists to catch — a false red that teaches people to
 * ignore it.
 */
const READY = /Ready on https?:\/\/[^\s:]+:(\d+)/;

interface BootResult {
  status: number;
  doc: Record<string, unknown>;
}

/**
 * Boot `wrangler dev --local` and fetch the OAuth discovery document.
 * Rejects with wrangler's own output if the runtime fails to start, which is
 * how a global-scope crash surfaces.
 */
function bootConnector(): Promise<BootResult> {
  return new Promise<BootResult>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['wrangler', 'dev', '--local', '--port', '0', '--inspector-port', '0'],
      { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`wrangler dev never became ready; output:\n${output}`))),
      110_000,
    );

    const onData = (d: Buffer): void => {
      output += d.toString();
      // "The Workers runtime failed to start" is what a module-scope throw
      // looks like from the outside. Fail fast with the real error text
      // rather than waiting out the timeout.
      if (/Workers runtime failed to start/.test(output)) {
        finish(() => reject(new Error(`the Worker isolate did not boot:\n${output}`)));
        return;
      }
      const ready = READY.exec(output);
      if (!ready) return;
      probe(Number(ready[1])).then(
        (res) => finish(() => resolve(res)),
        (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
      );
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', () =>
      finish(() => reject(new Error(`wrangler dev exited before serving; output:\n${output}`))),
    );
  });
}

async function probe(port: number): Promise<BootResult> {
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
  return { status: res.status, doc: (await res.json()) as Record<string, unknown> };
}

describe('hosted connector boot (real wrangler bundle)', () => {
  it('boots the isolate and serves OAuth discovery', async () => {
    const { status, doc } = await bootConnector();
    expect(status).toBe(200);
    expect(doc.authorization_endpoint).toMatch(/\/authorize$/);
    expect(doc.token_endpoint).toMatch(/\/token$/);
  }, 120_000);
});
