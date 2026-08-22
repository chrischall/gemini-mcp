import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpToolError } from '@chrischall/mcp-utils';
import { TERMINAL_INTERACTION_STATUSES, type GeminiClient } from '../client.js';
import { emitMedia, type NamedMedia } from './shared.js';
import { slugify } from '../images.js';

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
        'Retrieve a generation started with `async: true` or handed off by `max_wait_ms`. Pass the returned `job_id`: ' +
        'while running it reports status "running"; on completion it returns the normal result (image URLs/paths + meta); ' +
        'on failure it raises the recorded error, including the case where the generation was killed before it finished. ' +
        'On the hosted connector job records are stored durably and survive a restart; on a local stdio server they live ' +
        'with the process and expire ~10 min after completion, where the output dir / <image>.json sidecar is the fallback. ' +
        'A killed video/music job started with `background: true` is recovered from its upstream interaction when it finished there.',
      // NOT read-only any more: recovering a killed job writes the media it
      // pulls back, exactly as the generation tool would have.
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        job_id: z.string().min(1).describe('The job_id returned by a generation tool called with async: true'),
        output_dir: z.string().optional().describe('Where to write media recovered from a killed job (default: $GEMINI_OUTPUT_DIR or cwd)'),
      },
    },
    async (args) => {
      try {
        return await client.session.jobs.getResult(args.job_id);
      } catch (err) {
        // The interesting failure is "your executor died mid-generation". If
        // that job had reported an upstream interaction id, the generation
        // itself may well have finished on Google's side — the machine
        // stopping killed the *waiting*, not the work.
        const recovered = await recoverFromInteraction(client, args.job_id, args.output_dir, err);
        if (recovered) return recovered;
        throw err;
      }
    },
  );
}

/**
 * Try to answer a failed poll from the upstream interaction instead.
 *
 * Returns `undefined` when there is nothing to recover from — no record, no id,
 * or an interaction that cannot be read — leaving the original (accurate)
 * error to stand. Recovery must never convert a real loss into a false success,
 * so every path that does not produce media falls through.
 */
async function recoverFromInteraction(
  client: GeminiClient,
  jobId: string,
  outputDir: string | undefined,
  original: unknown,
): Promise<CallToolResult | undefined> {
  const record = await client.session.jobs.peekRecord(jobId);
  const interactionId = record?.interactionId;
  if (!interactionId || record?.status !== 'failed') return undefined;

  let found: Awaited<ReturnType<GeminiClient['fetchInteractionMedia']>>;
  try {
    found = await client.fetchInteractionMedia(interactionId);
  } catch (probeErr) {
    // A 403 (and a 404, the store lag) means the work is STILL RUNNING — that
    // is what a GET of an in-flight interaction answers, verified live:
    // t+20s 403, t+40s completed with the clip. Reporting "unrecoverable"
    // there is the worst wrong answer available, because the caller re-pays
    // for a generation that was about to land.
    if (isInFlight(probeErr)) return stillRunning(jobId, interactionId);
    // Anything else: a backgrounded interaction can settle into a permanent
    // 400 and never become retrievable. Say so on top of the real error rather
    // than pretending the output is somewhere.
    throw new McpToolError(
      `${errorMessage(original)} Its upstream interaction "${interactionId}" could not be read either (${errorMessage(probeErr)}), so the output is not recoverable.`,
      { hint: 'Any media the lost run did write is still listed by gemini_list_recent_media. Otherwise the generation has to be re-run.' },
    );
  }

  const [kind, media] = found.videos.length
    ? (['video', found.videos] as const)
    : found.audios.length
      ? (['audio', found.audios] as const)
      : found.images.length
        ? (['image', found.images] as const)
        : (['image', []] as const);

  if (media.length === 0) {
    // Still running upstream is a genuinely different answer from lost: the
    // caller should poll again, not re-pay. But a TERMINAL status with no media
    // (failed, cancelled, …) is not that — telling someone to poll again would
    // loop them forever on a generation that is never going to arrive, so the
    // real error stands.
    if (found.status && !TERMINAL_INTERACTION_STATUSES.has(found.status)) return stillRunning(jobId, interactionId);
    return undefined;
  }

  const slug = slugify(`recovered-${interactionId}`.slice(0, 60));
  const named: NamedMedia[] = media.map((m, i) => ({
    media: m,
    base: media.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
  }));
  return emitMedia(named, kind, { output_dir: outputDir, sink: client.mediaSink }, {
    job_id: jobId,
    recovered_from_interaction: interactionId,
    note: 'The executor that started this job was reclaimed before it could return. The generation finished upstream and its output was recovered — it was not re-run, and you were not billed twice.',
    ...(found.text ? { text: found.text } : {}),
  });
}

/** The generation outlived its executor and is not finished yet. */
function stillRunning(jobId: string, interactionId: string): CallToolResult {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        job_id: jobId,
        status: 'running',
        interaction_id: interactionId,
        note: 'The executor that started this job is gone, but the generation is still running upstream. Poll again — it has not been lost, and re-running it would bill a second time.',
      }, null, 2),
    }],
  };
}

/**
 * Does this probe failure mean "still working"? 403 is what a GET of an
 * in-flight background interaction returns (verified live), and 404 is the
 * interactions store's eventual consistency.
 */
function isInFlight(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 403 || status === 404;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
