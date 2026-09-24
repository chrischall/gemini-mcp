import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, confirmTokenParam, requireConfirmationWithFallback } from '@chrischall/mcp-utils';
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

export interface ConfirmWriteOptions {
  /** The tool name the token is bound to. */
  tool: string;
  /** `<service>.<verb>` identifier for the operation. */
  action: string;
  /** Prompt shown above the preview. */
  message: string;
  /** Human-readable description of what the call does. */
  description: string;
  method: string;
  path: string;
  /** What will be sent, shown to the user as `willSend`. */
  body?: unknown;
  /** The primary id acted on, or '' if none. */
  target: string;
  /** EXACTLY what the write will send; hashed into the token. */
  payload: unknown;
  confirmToken: string | undefined;
}

/**
 * Confirm a mutating call before it runs: an elicitation prompt where the
 * client supports one, otherwise the preview-plus-token fallback governed by
 * MCP_CONFIRM_MODE. The preview is the same method/path/willSend shape the old
 * dry-run returned.
 */
export async function confirmWrite(ctx: ServerContext, o: ConfirmWriteOptions): Promise<ConfirmGate> {
  const preview: Record<string, unknown> = {
    action: o.description,
    method: o.method,
    path: o.path,
    ...(o.body !== undefined ? { willSend: o.body } : {}),
  };
  return requireConfirmationWithFallback(ctx, confirmationFromEnv({
    action: o.action,
    message: o.message,
    details: preview,
    tool: o.tool,
    confirmToken: o.confirmToken,
    subject: () => ({ target: o.target, payload: o.payload, preview }),
  }));
}

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
    description: o.description,
    method: 'POST',
    path: o.endpoint,
    body: { inputs },
    target: '',
    payload: { request: o.request, inputs },
    confirmToken: o.confirmToken,
  });
}
