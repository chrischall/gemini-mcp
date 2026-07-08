#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerJobTools } from './tools/jobs.js';

// The GeminiClient is a module-level singleton (imported by each tool module)
// that defers its config error to the first request — so the server boots and
// answers the host's install-time tools/list probe even without GEMINI_API_KEY.
await runMcp({
  name: 'gemini-mcp',
  version: VERSION,
  banner: '[gemini-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  tools: [registerModelTools, registerGenerateTools, registerSetTools, registerInteractTools, registerJobTools],
});
