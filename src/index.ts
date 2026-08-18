#!/usr/bin/env node
import { runMcp, type ToolRegistrar } from '@chrischall/mcp-utils';
import { loadStdioDotenv } from './dotenv.js';
import { VERSION } from './version.js';
import { registerModelTools } from './tools/models.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerSetTools } from './tools/set.js';
import { registerInteractTools } from './tools/interact.js';
import { registerVideoTools } from './tools/video.js';
import { registerMusicTools } from './tools/music.js';
import { registerJobTools } from './tools/jobs.js';
import { registerFileTools } from './tools/files.js';
import { registerUploadUrlTools } from './tools/uploads.js';
import { registerLibraryTools } from './tools/library.js';
import { client } from './client.js';
import { surfaceToolErrors } from './errors.js';

// Load `.env` here rather than in client.ts: `import.meta.url` + async I/O at
// module scope is not safe in every runtime this module graph reaches (see
// src/dotenv.ts).
//
// Ordering is deliberately NOT load-bearing: GeminiClient reads
// $GEMINI_API_KEY at request time, so it does not matter that the `client`
// singleton is constructed (by the import above) before this line runs.
await loadStdioDotenv();

/**
 * Every registrar sees a server that reports failures in full.
 *
 * A hosted upload-URL failure reached the client as a bare "Error occurred
 * during tool execution" with no message and no failing step. That wrapper is
 * the client's, but it is only ever the whole story when our own text is
 * empty — so every handler's throw is turned into a message naming the tool,
 * the real error class, and the `cause` chain MCP serialization drops (see
 * src/errors.ts). Applied here, once, rather than in ten registrars.
 */
const reporting = (register: ToolRegistrar<typeof client>): ToolRegistrar<typeof client> =>
  (server, deps) => register(surfaceToolErrors(server), deps);

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
  tools: [
    registerModelTools,
    registerGenerateTools,
    registerSetTools,
    registerInteractTools,
    registerVideoTools,
    registerMusicTools,
    registerJobTools,
    registerFileTools,
    // Both gate on the client having somewhere to put bytes: hosted with a
    // blob store they register, and on a local install they no-op rather than
    // advertising a tool that cannot work.
    registerUploadUrlTools,
    registerLibraryTools,
  ].map(reporting),
  deps: client,
});
