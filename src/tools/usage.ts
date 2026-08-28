import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { GeminiClient } from '../client.js';

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
 * Deliberately NOT reported here: money. Converting tokens to a cost needs a
 * per-model rate table, and image pricing is not purely per-token — those
 * image tokens are a billing proxy whose rate varies by model and resolution
 * tier, before cached-input discounts and service tier. A stale hardcoded
 * table produces confident wrong numbers, which is worse than none, because
 * people act on them. Multiply these counts by the rate card you trust.
 */
export function registerUsageTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_token_usage',
    {
      description:
        'Token usage for this session so far — what every generation has cost in tokens, added up. ' +
        'Call it before and after a workflow and subtract to get that workflow\'s usage; call it after a ' +
        'single generation for that call\'s. Reports tokens, not money: converting to a cost needs a rate ' +
        'card this server deliberately does not hardcode. Note there is no account-balance endpoint to ' +
        'query — Google Cloud is post-paid and its billing data lags by hours — so this is the accurate ' +
        'way to attribute spend to a call.',
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
      if (args.reset) {
        client.session.usageTotal = undefined;
        client.session.billedCalls = 0;
      }
      return textResult({
        usage: usage ?? null,
        billed_calls: calls,
        ...(args.reset ? { reset: true } : {}),
        note:
          usage === undefined
            ? 'No generation has run in this session yet, so nothing has been billed through it.'
            : 'Tokens only — this server does not convert to money, because image pricing is not purely per-token and a hardcoded rate card goes stale silently. Multiply by the rate card you trust.',
        scope:
          'This session only. A restart starts from zero, and a hosted deployment counts each authenticated session separately — these are your tokens, not the account\'s.',
      });
    },
  );
}
