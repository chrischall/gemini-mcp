#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { loadStdioDotenv } from './dotenv.js';
import { VERSION } from './version.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerVideoTools } from './tools/video.js';
import { registerMusicTools } from './tools/music.js';
import { registerJobTools } from './tools/jobs.js';
import { client } from './client.js';

// Load `.env` here rather than in client.ts, which the Cloudflare Worker
// imports: `import.meta.url` + async I/O at module scope crashes the isolate at
// startup (see src/dotenv.ts, guarded by tests/connector-boot.test.ts).
//
// Ordering is deliberately NOT load-bearing: GeminiClient reads
// $GEMINI_API_KEY at request time, so it does not matter that the `client`
// singleton is constructed (by the import above) before this line runs.
await loadStdioDotenv();

// The registrars take their GeminiClient as an argument (they import only the
// *type*), so a non-stdio entry point can build one client per authenticated
// user. This stdio entry point threads the env-driven module-level singleton
// through runMcp's `deps`, which passes it as each registrar's second argument.
// That singleton defers its config error to the first request — so the server
// boots and answers the host's install-time tools/list probe even without
// GEMINI_API_KEY. It also owns this process's session state (job registry,
// last-interaction memory); stdio is single-user, so one client is one session.
await runMcp({
  name: 'gemini-mcp',
  version: VERSION,
  banner: '[gemini-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  tools: [registerModelTools, registerGenerateTools, registerSetTools, registerInteractTools, registerVideoTools, registerMusicTools, registerJobTools],
  deps: client,
});
