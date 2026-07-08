import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJobResult } from '../jobs.js';

/**
 * Poll tool for the async generation pattern (issue #52). A generation tool
 * called with `async: true` returns a `job_id` immediately (instead of blocking
 * past a host's tools/call timeout); this tool retrieves that job's status and,
 * once complete, its normal result payload.
 */
export function registerJobTools(server: McpServer): void {
  server.registerTool(
    'gemini_get_result',
    {
      description:
        'Retrieve an async generation started with `async: true`. Pass the returned `job_id`: while running it reports status "running"; on completion it returns the normal result (image paths / inline images + meta); on failure it raises the recorded error. Jobs are per-process and expire ~10 min after completion — if a job id is unknown, check the output dir / <image>.json sidecar.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        job_id: z.string().min(1).describe('The job_id returned by a generation tool called with async: true'),
      },
    },
    async (args) => getJobResult(args.job_id),
  );
}
