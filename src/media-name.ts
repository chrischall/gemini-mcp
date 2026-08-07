/**
 * The human filename behind a stored media key.
 *
 * Keys look like `gen/<tenant>/2026-07-29/ab12cd34-a-cat.png`; the random
 * component is there to make the key unique, not to be read. Stripping it turns
 * a saved file into `a-cat.png`, which matters because the reliable way to show
 * a user an image in a chat client is for the agent to download it and attach
 * it — and an attachment called `ab12cd34-a-cat.png` looks like a machine
 * artefact.
 *
 * Lives on its own because it is pure string work that both the tools and the
 * job registry need. It used to sit in `media-endpoint.ts` alongside the
 * Worker's `/media` route handler; that route is the host's job now
 * (mcp-host's blob store serves signed GETs), but the naming rule is ours.
 */
export function downloadFilename(key: string): string {
  const last = key.split('/').pop() || 'media';
  const stripped = last.replace(/^[0-9a-f]{6,12}-/i, '');
  return stripped || last;
}
