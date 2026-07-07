import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { schemaConfirm, textResult } from '@chrischall/mcp-utils';
import { previewImageInput, previewVideoInput, type LocalInputPreview } from '../images.js';

export { schemaConfirm };

/**
 * Confirm-gate for a mutating tool (the fleet convention). When `confirm` is not
 * `true`, returns a no-network dry-run preview of exactly what would be sent;
 * when it is `true`, returns `null` so the caller proceeds with the write.
 */
export function previewUnlessConfirmed(
  confirm: boolean | undefined,
  action: string,
  method: string,
  path: string,
  body?: unknown,
): CallToolResult | null {
  if (confirm === true) return null;
  return textResult({
    dryRun: true,
    action,
    method,
    path,
    ...(body !== undefined ? { willSend: body } : {}),
    note: 'Re-run with confirm: true to execute.',
  });
}

/**
 * Confirm-gate for a Gemini tool that ships LOCAL input files (image/video
 * paths) to Google. Returns `null` (proceed) when `confirm === true` OR the call
 * has no local file inputs — so pure text-to-image / base64 / clipboard calls
 * are unaffected. Otherwise returns a NO-API dry-run echoing each RESOLVED
 * ABSOLUTE input path plus its mime and size, so a prompt-injected path (e.g.
 * `~/.ssh/id_rsa`) is visible and interceptable before any byte leaves the box.
 */
export async function previewLocalInputsUnlessConfirmed(
  confirm: boolean | undefined,
  action: string,
  endpoint: string,
  imagePaths: string[] | undefined,
  videoPath?: string,
): Promise<CallToolResult | null> {
  const hasLocal = (imagePaths?.length ?? 0) > 0 || Boolean(videoPath);
  if (confirm === true || !hasLocal) return null;
  const inputs: LocalInputPreview[] = [];
  for (const p of imagePaths ?? []) inputs.push(await previewImageInput(p));
  if (videoPath) inputs.push(await previewVideoInput(videoPath));
  return previewUnlessConfirmed(confirm, action, 'POST', endpoint, { inputs });
}
