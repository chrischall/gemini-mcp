import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariant: every GEMINI_* knob the server reads can be set from BOTH install
 * paths — the .mcpb bundle (`manifest.json` server.mcp_config.env, wired to a
 * `user_config` entry) and the MCP Registry package (`server.json`
 * environmentVariables) — and none is marked required.
 *
 * Four knobs (heartbeat, chain retry, debug, rate card) were documented in the
 * README / CLAUDE.md but reachable from neither manifest, and GEMINI_TIMEOUT_MS
 * was missing from server.json (mcp-utils 3.0.0 audit-annotations --strict).
 * Required is false everywhere because the server reads every one with
 * `readEnvVar` and boots without any of them — GEMINI_API_KEY included: it is
 * resolved at request time, so `gemini_healthcheck` can report a missing key
 * instead of the process refusing to start (tests/server-boot.test.ts).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Env vars the server reads: every `readEnvVar('GEMINI_…')` literal, plus GEMINI_REFERENCE_DIR (read through a list). */
function readVars(): string[] {
  const found = new Set<string>(['GEMINI_REFERENCE_DIR']);
  for (const f of sourceFiles(join(root, 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/readEnvVar\(\s*'(GEMINI_[A-Z0-9_]+)'/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));

describe('env declared on every install path', () => {
  it('finds the knobs it is checking', () => {
    expect(readVars()).toEqual(
      expect.arrayContaining(['GEMINI_API_KEY', 'GEMINI_HEARTBEAT_MS', 'GEMINI_CHAIN_RETRY_MS', 'GEMINI_DEBUG', 'GEMINI_RATE_CARD', 'GEMINI_REFERENCE_DIR']),
    );
  });

  it('wires every read var through manifest.json mcp_config.env to an optional user_config entry', () => {
    const env = manifest.server.mcp_config.env as Record<string, string>;
    const userConfig = manifest.user_config as Record<string, { required?: boolean }>;
    for (const name of readVars()) {
      const value = env[name];
      expect(value, `${name} missing from manifest.json mcp_config.env`).toBeDefined();
      const key = /^\$\{user_config\.([a-z0-9_]+)\}$/.exec(value!)?.[1];
      expect(key, `${name} is not wired to a user_config entry`).toBeDefined();
      expect(userConfig[key!], `user_config.${key} missing`).toBeDefined();
      expect(userConfig[key!]!.required, `user_config.${key} must be optional`).toBe(false);
    }
  });

  it('declares every read var in server.json as optional', () => {
    const vars = serverJson.packages[0].environmentVariables as Array<{ name: string; isRequired?: boolean }>;
    for (const name of readVars()) {
      const v = vars.find((x) => x.name === name);
      expect(v, `${name} missing from server.json`).toBeDefined();
      expect(v!.isRequired, `${name} must be optional in server.json`).toBe(false);
    }
  });

  it('declares nothing the server does not read', () => {
    const read = readVars();
    expect(Object.keys(manifest.server.mcp_config.env).filter((n) => !read.includes(n))).toEqual([]);
    expect(
      (serverJson.packages[0].environmentVariables as Array<{ name: string }>).map((v) => v.name).filter((n) => !read.includes(n)),
    ).toEqual([]);
  });
});
