import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Strip // and /* *\/ comments so JSON.parse can read a .jsonc file. */
function parseJsonc(text: string): any {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped);
}

describe('wrangler.jsonc', () => {
  const config = parseJsonc(readRepoFile('wrangler.jsonc'));

  it('names the worker and points at an entrypoint that exists', () => {
    expect(config.name).toBe('gemini-connector');
    expect(config.main).toBe('src/worker.ts');
    // Asserting the string alone passed while the file was absent — and both
    // `wrangler deploy` and the workerd test pool fail to build without it.
    expect(existsSync(path.join(repoRoot, config.main)), `${config.main} does not exist`).toBe(
      true,
    );
  });

  it('enables nodejs_compat with a compatibility date', () => {
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  it('binds the GeminiMcpAgent Durable Object with a sqlite migration', () => {
    expect(config.durable_objects.bindings).toContainEqual(
      expect.objectContaining({ name: 'MCP_OBJECT', class_name: 'GeminiMcpAgent' }),
    );
    expect(config.migrations).toContainEqual(
      expect.objectContaining({ tag: 'v1', new_sqlite_classes: ['GeminiMcpAgent'] }),
    );
  });

  it('binds OAUTH_KV under the exact name workers-oauth-provider hardcodes', () => {
    expect(config.kv_namespaces).toEqual([
      { binding: 'OAUTH_KV', id: '86a316eabcf342a899a624583db6576a' },
    ]);
  });

  it('binds the R2 media bucket used in place of a filesystem', () => {
    expect(config.r2_buckets).toContainEqual(
      expect.objectContaining({
        binding: 'MEDIA_BUCKET',
        bucket_name: 'gemini-connector-media',
      }),
    );
  });

  it('routes the connector custom domain', () => {
    expect(config.routes).toContainEqual(
      expect.objectContaining({ pattern: 'connector.gemini.nullnet.app', custom_domain: true }),
    );
  });

  it('keeps workers_dev explicitly on alongside routes', () => {
    // Wrangler computes `defaultWorkersDev = routes.length === 0`, so omitting
    // this while `routes` is set resolves it to FALSE and provisions no
    // *.workers.dev URL — breaking DEPLOY-CONNECTOR.md step 6.
    expect(config.workers_dev).toBe(true);
  });
});

describe('package.json connector wiring', () => {
  const pkg = JSON.parse(readRepoFile('package.json'));

  it('exposes worker dev/deploy/test scripts', () => {
    expect(pkg.scripts['worker:dev']).toContain('wrangler dev');
    expect(pkg.scripts['worker:deploy']).toContain('wrangler deploy');
    expect(pkg.scripts['worker:test']).toContain('vitest run -c vitest.workers.config.ts');
    // Nothing else typechecks the worker half: tsconfig.json/test.json exclude
    // it, and wrangler + the vitest pool both transpile without checking.
    expect(pkg.scripts['worker:test']).toContain('worker:typecheck');
    expect(pkg.scripts['worker:typecheck']).toBe('tsc -p tsconfig.worker.json');
  });

  it('ships a worker smoke test so worker:test has something to run', () => {
    // An empty include makes `npm run worker:test` exit 0 vacuously.
    expect(existsSync(path.join(repoRoot, 'tests/worker.test.ts'))).toBe(true);
  });

  it('keeps the connector harness and its peers out of runtime dependencies', () => {
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeTruthy();

    // Workers-only, and wrangler bundles it from source — the published stdio
    // package never needs it at runtime. Leaving it in `dependencies` drags its
    // peers (`agents`, `@cloudflare/workers-oauth-provider`) into every
    // `npm i @chrischall/gemini-mcp` via npm 7+ auto-installed peers.
    for (const dep of [
      '@chrischall/mcp-connector',
      'wrangler',
      '@cloudflare/vitest-pool-workers',
      '@cloudflare/workers-types',
      'agents',
      '@cloudflare/workers-oauth-provider',
    ]) {
      expect(pkg.devDependencies[dep], `missing devDependency ${dep}`).toBeTruthy();
      expect(pkg.dependencies[dep], `${dep} must not be a runtime dependency`).toBeUndefined();
    }
  });
});

describe('node vitest config', () => {
  const source = readRepoFile('vitest.config.ts');

  it('excludes worker tests from the node pool', () => {
    expect(source).toContain('tests/worker*.test.ts');
  });

  it('excludes the worker entrypoint from coverage', () => {
    expect(source).toContain('src/worker.ts');
  });
});

describe('workers vitest config', () => {
  // Asserting file CONTENTS here would pass against a config that cannot load
  // (it did: the old `defineWorkersConfig` import is gone from the 0.18 line).
  // Import it instead, so a broken specifier/symbol fails this suite.
  it('loads and wires the workers pool at wrangler.jsonc', async () => {
    const mod = await import('../vitest.workers.config.js');
    const config: any = mod.default;

    const plugins = (config.plugins ?? []).flat(Infinity).filter(Boolean);
    expect(plugins.length).toBeGreaterThan(0);

    expect(config.test.include).toContain('tests/worker*.test.ts');
  });
});

describe('tsconfig.json', () => {
  const config = parseJsonc(readRepoFile('tsconfig.json'));

  it('excludes the worker from the stdio build', () => {
    expect(config.exclude).toContain('src/worker.ts');
  });
});

describe('operator docs', () => {
  it('ships a .dev.vars.example', () => {
    expect(readRepoFile('.dev.vars.example')).toContain('GEMINI_API_KEY');
  });

  it('documents the manual deploy runbook', () => {
    const doc = readRepoFile('docs/DEPLOY-CONNECTOR.md');
    expect(doc).toContain('86a316eabcf342a899a624583db6576a');
    expect(doc).toContain('wrangler r2 bucket create gemini-connector-media');
    expect(doc).toContain('npm run worker:deploy');
    expect(doc).toContain('connector.gemini.nullnet.app');
  });
});

describe('server.json', () => {
  it('does not advertise the personal connector as a registry remote', () => {
    const server = JSON.parse(readRepoFile('server.json'));
    expect(server.remotes).toBeUndefined();
  });
});
