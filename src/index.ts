#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { loadStdioDotenv } from './dotenv.js';
import { VERSION } from './version.js';
import { TOOL_REGISTRARS } from './registrars.js';
import { client } from './client.js';

// Load `.env` here rather than in client.ts: `import.meta.url` + async I/O at
// module scope is not safe in every runtime this module graph reaches (see
// src/dotenv.ts).
//
// Ordering is deliberately NOT load-bearing: GeminiClient reads
// $GEMINI_API_KEY at request time, so it does not matter that the `client`
// singleton is constructed (by the import above) before this line runs.
await loadStdioDotenv();

// The registrars take their GeminiClient as an argument (they import only the
// *type*), so a future multi-user entry point COULD build one client per user.
// None does: this is the only entry point (mcp-host runs it as a per-registration
// child), and it threads the env-driven module-level singleton through runMcp's
// `deps` to every connection — sound because one registration is one user (see
// src/session.ts).
// That singleton defers its config error to the first request — so the server
// boots and answers the host's install-time tools/list probe even without
// GEMINI_API_KEY. It also owns this process's session state (job registry,
// last-interaction memory); one process is one user, so one client is one session.
//
// The roster itself lives in registrars.ts: this file cannot be imported
// without booting a server, and a list nothing can import is a list nothing
// can test (see the note there).
await runMcp({
  name: 'gemini-mcp',
  version: VERSION,
  banner: '[gemini-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  tools: TOOL_REGISTRARS,
  deps: client,
});
