import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GeminiClient } from '../client.js';

/**
 * Poll tool for the async generation pattern (issue #52). A generation tool
 * called with `async: true` returns a `job_id` immediately (instead of blocking
 * past a host's tools/call timeout); this tool retrieves that job's status and,
 * once complete, its normal result payload.
 */
// The client is REQUIRED, not decorative: the job registry hangs off it
// (`client.session.jobs`) so each authenticated connector session polls its own
// jobs. Reading a module-level registry here would let any session fetch any
// other session's result by job id — see src/session.ts.
export function registerJobTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_get_result',
    {
      description:
        'Retrieve an async generation started with `async: true`. Pass the returned `job_id`: while running it reports status "running"; on completion it returns the normal result (image paths / inline images + meta); on failure it raises the recorded error. Jobs belong to your session and expire ~10 min after completion — if a job id is unknown, check the output dir / <image>.json sidecar.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        job_id: z.string().min(1).describe('The job_id returned by a generation tool called with async: true'),
      },
    },
    async (args) => client.session.jobs.getResult(args.job_id),
  );
}
