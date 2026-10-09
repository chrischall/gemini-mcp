import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('Claude Code plugin manifest', () => {
  it('declares its MCP config under `mcpServers`, the key Claude Code reads', () => {
    expect(plugin).toHaveProperty('mcpServers');
    // `mcp` is not a plugin.json field — Claude Code ignores it at load time.
    expect(plugin).not.toHaveProperty('mcp');
  });

  it('points `mcpServers` at a file that exists', () => {
    expect(typeof plugin.mcpServers).toBe('string');
    expect(existsSync(join(ROOT, plugin.mcpServers as string))).toBe(true);
  });
});
