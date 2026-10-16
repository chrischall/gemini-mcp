import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmTokenParam, confirmWrite } from '@chrischall/mcp-utils';
import { previewImageInput, previewVideoInput, type LocalInputPreview } from '../images.js';

export { confirmTokenParam };

/** What a gated handler returns instead of proceeding; `undefined` means go ahead. */
export type ConfirmGate = InputRequiredResult | CallToolResult | undefined;

/**
 * The sentence every gated tool's description ends with. `lead` names what is
 * confirmed when it is not the whole call (local file inputs only).
 */
export function confirmNote(lead = 'Asks the user to confirm first'): string {
  return `${lead}: a confirmation prompt where the client supports one; otherwise the first call returns a preview ` +
    'and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).';
}

/**
 * The gate itself is the fleet's shared `confirmWrite` from
 * `@chrischall/mcp-utils` (fleet-audit#1376 — this file used to carry its own
 * adapter over `requireConfirmationWithFallback` + `confirmationFromEnv`). It
 * binds the request, the payload, the displayed preview and the validated
 * args into both the token and the elicitation acceptance. One API key per
 * process (a hosted deployment runs one child per account), so every call
 * passes `account: undefined`.
 */
export { confirmWrite };

export interface ConfirmLocalInputsOptions {
  tool: string;
  action: string;
  description: string;
  endpoint: string;
  imagePaths: string[] | undefined;
  videoPath?: string;
  /**
   * The request as it will be sent (the validated args minus confirmToken, plus
   * anything resolved from them). Bound into the token with the resolved
   * inputs, so a changed prompt or a swapped file between the two calls is
   * refused as DRAFT_CHANGED.
   */
  request: Record<string, unknown>;
  confirmToken: string | undefined;
}

/**
 * Confirm-gate for a Gemini tool that ships LOCAL input files (image/video
 * paths) to Google. Proceeds straight away when the call has no local file
 * inputs — so pure text-to-image / base64 / clipboard calls are unaffected.
 * Otherwise the preview echoes each RESOLVED ABSOLUTE input path plus its mime
 * and size (a local read, no network), so a prompt-injected path (e.g.
 * `~/.ssh/id_rsa`) is visible and interceptable before any byte leaves the box.
 */
export async function confirmLocalInputs(ctx: ServerContext, o: ConfirmLocalInputsOptions): Promise<ConfirmGate> {
  const hasLocal = (o.imagePaths?.length ?? 0) > 0 || Boolean(o.videoPath);
  if (!hasLocal) return undefined;
  const inputs: LocalInputPreview[] = [];
  for (const p of o.imagePaths ?? []) inputs.push(await previewImageInput(p));
  if (o.videoPath) inputs.push(await previewVideoInput(o.videoPath));
  return confirmWrite(ctx, {
    tool: o.tool,
    action: o.action,
    message: 'Review and confirm sending these local files to Google:',
    summary: o.description,
    account: undefined,
    target: '',
    request: { method: 'POST', path: o.endpoint },
    payload: { request: o.request, inputs },
    willSend: { inputs },
    args: o.request,
    confirmToken: o.confirmToken,
  });
}
