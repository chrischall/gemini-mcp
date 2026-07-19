import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('names the worker and points at the worker entrypoint', () => {
    expect(config.name).toBe('gemini-connector');
    expect(config.main).toBe('src/worker.ts');
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
});

describe('package.json connector wiring', () => {
  const pkg = JSON.parse(readRepoFile('package.json'));

  it('exposes worker dev/deploy/test scripts', () => {
    expect(pkg.scripts['worker:dev']).toContain('wrangler dev');
    expect(pkg.scripts['worker:deploy']).toContain('wrangler deploy');
    expect(pkg.scripts['worker:test']).toBe('vitest run -c vitest.workers.config.ts');
  });

  it('depends on the connector harness and its peers', () => {
    expect(pkg.dependencies['@chrischall/mcp-connector']).toBeTruthy();
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeTruthy();
    for (const dep of [
      'wrangler',
      '@cloudflare/vitest-pool-workers',
      '@cloudflare/workers-types',
      'agents',
      '@cloudflare/workers-oauth-provider',
    ]) {
      expect(pkg.devDependencies[dep], `missing devDependency ${dep}`).toBeTruthy();
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
  const source = readRepoFile('vitest.workers.config.ts');

  it('uses the workers pool pointed at wrangler.jsonc', () => {
    expect(source).toContain('@cloudflare/vitest-pool-workers');
    expect(source).toContain('wrangler.jsonc');
    expect(source).toContain('tests/worker*.test.ts');
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
