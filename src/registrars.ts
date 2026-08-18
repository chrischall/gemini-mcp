/**
 * The tool roster, and the one place error reporting is attached to it.
 *
 * This lives apart from `index.ts` because that file is an ENTRY POINT: it has
 * top-level `await loadStdioDotenv()` and `await runMcp(…)`, so importing it
 * starts a server on stdio. Nothing can assert what it wires without booting
 * it — which is precisely how `.map(reporting)` could be deleted with the
 * suite still green, leaving hosted failures unattributed again (the exact
 * regression this repo just spent a debugging round trip on). Here the list is
 * an ordinary value, and `tests/registrars.test.ts` runs a registrar through it.
 */

import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { GeminiClient } from './client.js';
import { surfaceToolErrors } from './errors.js';
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

/**
 * Give one registrar a server that reports failures in full.
 *
 * A hosted upload-URL failure reached the client as a bare "Error occurred
 * during tool execution" — no message, no failing step. That wrapper is the
 * client's, but it is only ever the whole story when our own text is empty, so
 * every handler's throw is turned into a message naming the tool, the real
 * error class, and the `cause` chain MCP serialization drops (src/errors.ts).
 */
export const reporting =
  <T>(register: ToolRegistrar<T>): ToolRegistrar<T> =>
  (server, deps) =>
    register(surfaceToolErrors(server), deps);

/**
 * Every registrar, already wrapped. `index.ts` passes this straight to
 * `runMcp`; the last two self-gate on the client having somewhere to put bytes
 * (hosted with a blob store they register, on a local install they no-op
 * rather than advertising a tool that cannot work).
 */
export const TOOL_REGISTRARS: Array<ToolRegistrar<GeminiClient>> = [
  registerModelTools,
  registerGenerateTools,
  registerSetTools,
  registerInteractTools,
  registerVideoTools,
  registerMusicTools,
  registerJobTools,
  registerFileTools,
  registerUploadUrlTools,
  registerLibraryTools,
].map(reporting);
