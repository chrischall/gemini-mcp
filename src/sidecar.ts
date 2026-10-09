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
import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SIDECAR_SUFFIX = '.json';

/**
 * `writeSidecar` always names the sidecar after its output: `<file>.<ext>.json`.
 * Any other `.json` in the directory — the output dir defaults to cwd, which
 * can be a cloned repo — is not ours and is never read (chrischall/fleet-audit#473).
 */
const SIDECAR_NAME = /^.+\.[A-Za-z0-9]+\.json$/;

/** True for a regular file (NOT a symlink — the server never writes through one). */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export interface SidecarRecord {
  /** Absolute path of the sidecar file itself. */
  sidecarPath: string;
  /** The interaction that produced the image(s). */
  interactionId: string;
  /** Recorded output image paths, filtered to outputs still on disk in this
   * directory, each beside its own sidecar (see readSidecars). */
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
  // The outputs this directory has sidecars for. A recorded image path is
  // only trusted when it is one of these: an output file this server wrote,
  // sitting in this directory beside its own sidecar. That is what keeps a
  // planted sidecar from naming an arbitrary local file for the chain
  // re-anchor to read and send upstream without the confirm gate.
  const sidecarNames = entries.filter((e) => SIDECAR_NAME.test(e));
  const outputs = new Set(sidecarNames.map((e) => resolve(dir, e.slice(0, -SIDECAR_SUFFIX.length))));
  const records: SidecarRecord[] = [];
  for (const entry of sidecarNames) {
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
      const kept: string[] = [];
      for (const p of paths) {
        if (outputs.has(resolve(p)) && (await isRegularFile(p))) kept.push(p);
      }
      records.push({
        sidecarPath,
        interactionId,
        images: kept,
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
