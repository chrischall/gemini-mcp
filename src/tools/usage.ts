import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';
import { PRICED_AT } from '../pricing.js';

/**
 * What this session has spent, in tokens.
 *
 * This exists because the obvious thing — read the account balance before and
 * after — cannot be built. The Generative Language API's discovery document
 * has no billing, quota, usage, account or credit resource at all, and Cloud
 * Billing v1 has no notion of a balance either (its schema never mentions the
 * word): Google Cloud is post-paid, so there is no wallet to read. Even with a
 * service account and the Cloud Billing scopes, actual spend arrives through
 * BigQuery export hours later — far too late to attribute to one call.
 *
 * Tokens do the job better anyway. They are exact, they are per-call, they
 * arrive with the response, and they attribute: a before/after balance diff
 * cannot separate your generation from anything else billing the account in
 * the same window, and this can.
 *
 * Money IS reported, with two safeguards. Image output turned out to be billed
 * per token like everything else — just at 20-40x the text-output rate — so
 * the published per-image prices are exactly the token arithmetic, and an
 * estimate is arithmetic rather than guesswork (see src/pricing.ts). The
 * safeguards are that every figure carries the date its rates were read, and
 * `GEMINI_RATE_CARD` overrides them without waiting on a release.
 *
 * The session's cost is accumulated PER CALL, not derived from the token total
 * at the end: the total spans models, and pricing a Pro call's tokens at a
 * Lite rate would be wrong by 4x.
 */
export function registerUsageTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_token_usage',
    {
      description:
        'Token usage for this session so far — what every generation has cost in tokens, added up. ' +
        'Call it before and after a workflow and subtract to get that workflow\'s cost; call it after a ' +
        'single generation for that call\'s. Reports tokens AND an estimated USD cost, priced per call against each call\'s own model and stamped with the date its rates were read (override with GEMINI_RATE_CARD). Note there is no account-balance endpoint to query — Google Cloud is post-paid and its billing data lags by hours — so this is the accurate way to attribute spend to a call.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        reset: z
          .boolean()
          .optional()
          .describe('Zero the running total after reporting it, so the next call measures from here. Use it to bracket a workflow without arithmetic.'),
      },
    },
    async (args) => {
      const usage = client.session.usageTotal;
      const calls = client.session.billedCalls;
      const costUsd = client.session.costUsd;
      const priced = client.session.pricedCalls;
      if (args.reset) {
        client.session.usageTotal = undefined;
        client.session.billedCalls = 0;
        client.session.costUsd = undefined;
        client.session.pricedCalls = 0;
      }
      return textResult({
        usage: usage ?? null,
        billed_calls: calls,
        estimated_cost_usd: costUsd ?? null,
        priced_calls: priced,
        rates_published: PRICED_AT,
        ...(args.reset ? { reset: true } : {}),
        note:
          usage === undefined
            ? 'No generation has run in this session yet, so nothing has been billed through it.'
            : priced < calls
              ? `Estimate covers ${priced} of ${calls} billed calls — the rest used a model that is not in the rate card. Add it with GEMINI_RATE_CARD to include it.`
              : 'Estimate priced per call against each call\'s own model, then added up.',
        rates:
          `Published rates read on ${PRICED_AT} (paid tier, USD). Override or extend with GEMINI_RATE_CARD ` +
          'if they have moved — an estimate is only as current as its card.',
        scope:
          'This session only. A restart starts from zero, and a hosted deployment counts each authenticated session separately — these are your tokens, not the account\'s.',
      });
    },
  );
}
