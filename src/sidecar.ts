/**
 * Reading the `<image>.json` sidecars `gemini_interact` writes next to every
 * generated image (see `writeSidecar` in images.ts).
 *
 * The sidecars were introduced so an interaction id could survive a lost MCP
 * response (host timeout). They double as an on-disk index of the whole chain,
 * which is what makes the two chain recoveries in `tools/interact.ts` possible:
 *
 *  - `continue_last` outliving the server process — the in-memory
 *    `lastInteractionId` dies with the process, but the newest sidecar in the
 *    output dir still names the interaction to resume.
 *  - re-anchoring after an interaction id is genuinely gone upstream — the
 *    sidecar for that id names the image file to re-attach, which is exactly
 *    the manual recovery the old error message asked the caller to perform.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SIDECAR_SUFFIX = '.json';

export interface SidecarRecord {
  /** Absolute path of the sidecar file itself. */
  sidecarPath: string;
  /** The interaction that produced the image(s). */
  interactionId: string;
  /** Recorded output image paths, filtered to those still on disk. */
  images: string[];
  /** Sidecar mtime — how "newest" is ordered. */
  mtimeMs: number;
}

/**
 * All parseable sidecars in `dir`, newest first. Never throws: a missing dir,
 * an unreadable file, malformed JSON, or a record with no `interaction_id` is
 * skipped. Recovery is best-effort by definition — it must not turn a
 * recoverable chain into a hard failure.
 */
export async function readSidecars(dir: string): Promise<SidecarRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const records: SidecarRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SIDECAR_SUFFIX)) continue;
    const sidecarPath = join(dir, entry);
    try {
      const parsed: unknown = JSON.parse(await readFile(sidecarPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const { interaction_id: interactionId, images } = parsed as {
        interaction_id?: unknown;
        images?: unknown;
      };
      if (typeof interactionId !== 'string' || !interactionId) continue;
      const paths = Array.isArray(images) ? images.filter((p): p is string => typeof p === 'string') : [];
      records.push({
        sidecarPath,
        interactionId,
        images: paths.filter((p) => existsSync(p)),
        mtimeMs: (await stat(sidecarPath)).mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Output images recorded for `interactionId` (still on disk), or `[]` if that
 * interaction has no sidecar here. Matching is by id, never "the newest image"
 * — re-anchoring on the wrong picture would silently corrupt the edit chain.
 */
export async function findInteractionImages(dir: string, interactionId: string): Promise<string[]> {
  const records = await readSidecars(dir);
  return records.find((r) => r.interactionId === interactionId)?.images ?? [];
}

/** The newest sidecar's interaction id, or undefined if `dir` has none. */
export async function latestInteractionId(dir: string): Promise<string | undefined> {
  return (await readSidecars(dir))[0]?.interactionId;
}
