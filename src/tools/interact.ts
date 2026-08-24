import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, ApiError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import { ChainedRequest404Error, type GeminiClient } from '../client.js';
import { slugify, baseName, resolveImagePath, writeSidecar, resolveOutputDir, readImageAsInline } from '../images.js';
import { resolveImageInputs } from '../inputs.js';
import { findInteractionImages, latestInteractionId } from '../sidecar.js';
import { emit, resolveAspectRatio, orientationSchema, ASPECT_RATIOS, IMAGE_SIZES, MODEL_CHOICE_GUIDE, resolveVideoInput, videoPathSchema, timeoutMsSchema, timeoutRiskHint, idempotencyKeySchema, asyncSchema, maxWaitMsSchema, withProgressHeartbeat, assertLocalInputsAvailable, imagesUrlSchema, imagesFileUrisSchema, type NamedImage } from './shared.js';
import { fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

// The last-interaction id and the written-outputs set used to live here, at
// module scope. On the hosted connector that leaks across tenants — one
// Cloudflare isolate serves many authenticated sessions, so `continue_last`
// from user B would resume user A's interaction under B's key. Both now live
// on `client.session` (src/session.ts), one per authenticated session.

/** Shared warning for the reference-image params. */
const NEW_REFERENCES_ONLY =
  'NEW reference images only (e.g. a style or target photo). When chaining with previous_interaction_id, ' +
  "do NOT re-attach the prior turn's output — the interaction already contains it, and re-sending it " +
  'anchors the model against your edit.';

/**
 * On a chained call, split `images` into genuinely new references vs paths
 * this server itself generated (which the interaction already contains).
 * Unresolvable paths are kept so `resolveImageInputs` surfaces its usual error.
 */
function splitReattachedOutputs(images: string[], writtenOutputs: ReadonlySet<string>): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of images) {
    let resolved: string | undefined;
    try { resolved = resolveImagePath(p); } catch { /* kept; loading will error actionably */ }
    (resolved && writtenOutputs.has(resolved) ? dropped : kept).push(p);
  }
  return { kept, dropped };
}

export function registerInteractTools(server: McpServer, client: GeminiClient): void {
  // The sidecar/re-anchor half of this description is only true where there is
  // a filesystem. Describing it anyway on the hosted connector would tell the
  // model to go looking in an output dir that does not exist — so the
  // description is built from the sink's capability, not hardcoded.
  const onDiskRuntime = client.mediaSink?.persistsFiles ?? true;
  const recoveryDescription = onDiskRuntime
    ? 'If a call times out on the client side, the generation usually still completes: the image plus a ' +
      '`<image>.json` sidecar recording its interaction id land in the output dir, and `continue_last: true` ' +
      'still resumes that interaction — check the output dir before re-issuing (a re-issue is a second billable generation). ' +
      'If a chained call 404s, this tool re-anchors itself on the prior output image and re-issues un-chained: ' +
      'success is reported as `chain_recovered` (the chain was the problem, and you get your image anyway); ' +
      'a second 404 is reported as the interaction id NOT being the cause (check the model id / files uri instead). '
    : 'On this connector each result returns an image URL you can open or share directly (see `media[].url`) — show it ' +
      'to the user rather than assuming they can see the image. There is no filesystem, so no output dir and no ' +
      '`<image>.json` sidecar: a lost response cannot be recovered from disk and a 404 on a chained call cannot be ' +
      're-anchored automatically. Capture the returned `interaction_id` from every result, and use `async: true` + ' +
      'gemini_get_result for long generations. ';

  server.registerTool(
    'gemini_interact',
    {
      description:
        'Preferred tool for iterative or multi-step refinement of a single image — ' +
        "multi-turn generation/editing via Gemini's Interactions API. " +
        'To refine, capture the returned interaction `id` and pass it as `previous_interaction_id` ' +
        'on the next call — do NOT start a new interaction or re-upload the image for each tweak. ' +
        '`continue_last: true` chains from this session\'s most recent interaction without threading the id. ' +
        recoveryDescription +
        'Output is JPEG.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        input: z.string().min(1).describe('Text prompt or editing instruction'),
        previous_interaction_id: z
          .string()
          .optional()
          .describe('ID from a prior gemini_interact call — continues that multi-turn conversation'),
        continue_last: z
          .boolean()
          .optional()
          .describe('Continue from the most recent interaction this server created (convenience for previous_interaction_id; an explicit id wins). Survives a server restart by falling back to the newest <image>.json sidecar in the output dir.'),
        images: z
          .array(z.string().min(1))
          .optional()
          .describe(`Paths to reference input images. ${NEW_REFERENCES_ONLY}`),
        images_url: imagesUrlSchema(`Reference images. ${NEW_REFERENCES_ONLY} Given`),
        images_file_uris: imagesFileUrisSchema(`Reference images. ${NEW_REFERENCES_ONLY} Given`),
        images_base64: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Reference images as base64 strings or data URIs. Last resort: prefer images_url or images_file_uris, ` +
            `which keep image bytes out of the conversation. ${NEW_REFERENCES_ONLY}`,
          ),
        model: z
          .string()
          .optional()
          .describe(`Model id override (default: server default; see gemini_list_models). ${MODEL_CHOICE_GUIDE}`),
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .optional()
          .describe('Exact output aspect ratio. For a plain landscape/portrait/square request, `orientation` is the shorthand; this wins if both are given.'),
        orientation: orientationSchema,
        image_size: z
          .enum(IMAGE_SIZES)
          .optional()
          .describe('Output resolution (512 = 0.5K, Flash-only)'),
        thinking_level: z
          .enum(['minimal', 'high'])
          .optional()
          .describe('Reasoning depth; higher can help complex/structural edits'),
        filename: z
          .string()
          .optional()
          .describe('Base filename for the output image (extension stripped; default: slugified input)'),
        output_dir: z
          .string()
          .optional()
          .describe('Directory to write images to (default: $GEMINI_OUTPUT_DIR or cwd)'),
        inline: z
          .boolean()
          .optional()
          .describe('Return base64 images inline instead of writing to disk'),
        google_search: z
          .boolean()
          .optional()
          .describe('Ground the image in live Google Search results (current events, weather, data)'),
        search_types: z
          .array(z.enum(['web_search', 'image_search']))
          .optional()
          .describe(
            'Grounding search types (implies google_search). image_search (gemini-3.1-flash-image only) uses Google Image Search results as visual references; ' +
            'per Google ToS the returned grounding.search_suggestions HTML must then be displayed to the user. Cannot depict real people from web images.',
          ),
        video_url: z
          .string()
          .url()
          .optional()
          .describe('Public YouTube URL (or a previously uploaded Files API uri) as a video reference (video→image; use a Flash model e.g. gemini-3.1-flash-image)'),
        video_path: videoPathSchema,
        timeout_ms: timeoutMsSchema,
        idempotency_key: idempotencyKeySchema,
        async: asyncSchema,
        max_wait_ms: maxWaitMsSchema,
        from_clipboard: z
          .boolean()
          .optional()
          .describe('Use the image currently on the macOS system clipboard as an input (downscaled to JPEG)'),
        confirm: schemaConfirm,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      // Every sidecar-backed recovery below reads the output dir off disk. A
      // sink with no filesystem has none, so those paths are skipped entirely
      // rather than left to silently read an empty directory.
      const onDisk = client.mediaSink?.persistsFiles ?? true;
      let previousInteractionId = args.previous_interaction_id;
      // `continue_last` resumes the in-memory id first, then falls back to the
      // newest sidecar in the output dir. The in-memory id dies with the server
      // process, but the interaction itself lives on upstream — without the
      // sidecar fallback an MCP restart mid-workflow reads as an expired chain
      // and costs the caller a manual re-anchor for no reason.
      let continuedFromSidecar = false;
      if (!previousInteractionId && args.continue_last) {
        previousInteractionId = client.session.lastInteractionId;
        if (!previousInteractionId && onDisk) {
          previousInteractionId = await latestInteractionId(resolveOutputDir(args.output_dir));
          continuedFromSidecar = previousInteractionId !== undefined;
        }
        if (!previousInteractionId) {
          throw new McpToolError('No previous interaction to continue in this session.', {
            hint: onDisk
              ? 'Call gemini_interact once without continue_last first, or pass an explicit previous_interaction_id.'
              : 'Call gemini_interact once without continue_last first, or pass an explicit previous_interaction_id. (This hosted connector has no filesystem, so there are no <image>.json sidecars to recover an id from across restarts.)',
          });
        }
      }
      let images = args.images;
      let dropped: string[] = [];
      if (previousInteractionId && images?.length) {
        ({ kept: images, dropped } = splitReattachedOutputs(images, client.session.writtenOutputs));
      }
      // Confirm-gate local file inputs AFTER the re-attach split, so the preview
      // reflects the paths actually sent (dropped prior-output paths aren't). A
      // prompt-injected `images`/`video_path` could exfiltrate a local file;
      // base64/clipboard inputs pass through ungated. Dry-run makes NO API call.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local file input(s) to the Gemini Interactions API', '/v1beta/interactions', images, args.video_path);
      if (gate) return gate;
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      // Resolved before the fingerprint so "portrait" and "9:16" are one job.
      const aspectRatio = resolveAspectRatio(args, ASPECT_RATIOS);
      const fingerprint = fingerprintRequest('gemini_interact', {
        model, input: args.input, aspect_ratio: aspectRatio, image_size: args.image_size,
        thinking_level: args.thinking_level, previous_interaction_id: previousInteractionId,
        google_search: args.google_search, search_types: args.search_types,
        images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
        images_url: args.images_url, images_file_uris: args.images_file_uris,
        video_url: args.video_url, video_path: args.video_path,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_interact', fingerprint, idempotencyKey: args.idempotency_key, async: args.async, waitMs: args.max_wait_ms }, async () => {
        const { inputs, report } = await resolveImageInputs({ ...args, images }, client);
        const video = await withProgressHeartbeat(extra, 'Uploading video to the Gemini Files API', () => resolveVideoInput(args, client));
        const callOpts = {
          input: args.input,
          model: args.model,
          aspectRatio,
          imageSize: args.image_size,
          thinkingLevel: args.thinking_level,
          googleSearch: args.google_search,
          searchTypes: args.search_types,
          videoUrl: video.videoUrl,
          videoMimeType: video.videoMimeType,
          timeoutMs: args.timeout_ms,
        };
        // A 404 on a chained request proves *something* was missing, not that it
        // was the interaction (the upstream body is generic — see
        // ChainedRequest404Error). So the recovery doubles as the experiment that
        // settles it: re-attach that turn's output image — located by id via its
        // sidecar, never "the newest image", since re-anchoring on the wrong
        // picture would silently corrupt the edit — and re-issue WITHOUT the
        // chain. Succeeds → the chain really was the problem, and the caller gets
        // their image. 404s again → the id was never the cause, and saying so
        // beats sending them to chase an interaction that was fine all along.
        // Neither 404 generates anything, so a success costs the one generation
        // the manual re-anchor would have cost.
        let chainRecovered: { expired_interaction_id: string; reanchored_on: string[] } | undefined;
        const r = await withProgressHeartbeat(extra, 'Generating image (Gemini Interactions API)', async () => {
          try {
            return await client.interact({ ...callOpts, images: inputs.length ? inputs : undefined, previousInteractionId });
          } catch (err) {
            if (!(err instanceof ChainedRequest404Error)) throw err;
            // The client already asked: if the interaction is ALIVE, the 404 was
            // about something else (the model id, an expired files/… uri), and
            // re-anchoring would bill a second generation to answer a question
            // that is already answered — while silently dropping the
            // conversation context, returning a plausible image the model built
            // without the prior turn. Only probe when the chain is gone or the
            // probe itself could not be completed.
            if (err.chainExists === true) throw err;
            // Re-anchoring needs the prior output image, which only the sidecar
            // index can locate — and that index lives on disk.
            if (!onDisk) throw err;
            const reanchorOn = await findInteractionImages(resolveOutputDir(args.output_dir), err.previousInteractionId);
            if (!reanchorOn.length) throw err;
            const carried = await Promise.all(reanchorOn.map((p) => readImageAsInline(p)));
            try {
              const probe = await client.interact({ ...callOpts, images: [...carried, ...inputs], previousInteractionId: undefined });
              chainRecovered = { expired_interaction_id: err.previousInteractionId, reanchored_on: reanchorOn };
              return probe;
            } catch (probeErr) {
              if (!(probeErr instanceof ApiError && probeErr.status === 404)) throw probeErr;
              throw new McpToolError(
                // Remediation goes in the MESSAGE, not just `hint`: MCP error
                // serialization surfaces the message and drops the hint, so a
                // hint-only fix is invisible exactly when it's needed.
                `The interaction id is not the cause of this 404: the same request re-issued WITHOUT previous_interaction_id ("${err.previousInteractionId}") also returned 404. Upstream said: ${probeErr.message}. ` +
                  `Check that the model id ("${model}") resolves — see gemini_list_models — and that any files/… uri you referenced hasn't expired (~48h TTL). Re-chaining or re-anchoring will not help.`,
                {
                  hint: `Check the model id ("${model}") resolves — see gemini_list_models — and that any files/… uri you referenced hasn't expired (~48h TTL). Re-chaining or re-anchoring will not help.`,
                  cause: probeErr,
                },
              );
            }
          }
        });
        client.session.lastInteractionId = r.id;

        const meta: Record<string, unknown> = { model, interaction_id: r.id };
        // On recovery the prior id was NOT used — reporting it as
        // previous_interaction_id would misrepresent what the model saw.
        if (chainRecovered) meta.chain_recovered = chainRecovered;
        else if (previousInteractionId) meta.previous_interaction_id = previousInteractionId;
        if (continuedFromSidecar) meta.continued_from_sidecar = true;
        if (dropped.length) meta.dropped_previous_output = dropped;
        meta.hint =
          `To refine this image, call gemini_interact again with previous_interaction_id: "${r.id}" (or continue_last: true) — ` +
          'do NOT re-attach the returned image as an input; the interaction already contains it.';
        if (r.text) meta.text = r.text;
        if (r.grounding) meta.grounding = r.grounding;
        if (report) meta.image_inputs = report;
        if (video.videoFileMeta) meta.video_file = video.videoFileMeta;
        const risk = timeoutRiskHint({ model, imageSize: args.image_size, persistsFiles: onDisk });
        if (risk) meta.timeout_risk = risk;

        const slug = args.filename ? baseName(args.filename) : slugify(args.input);
        const named: NamedImage[] = r.images.map((image, i) => ({
          image,
          base: r.images.length > 1 ? `${slug}-${String(i + 1).padStart(2, '0')}` : slug,
        }));

        // writeImage returns already-resolved absolute paths. `emit` only
        // invokes this callback for a filesystem-backed sink, so there is no
        // branch here claiming a sidecar the hosted connector cannot write.
        return emit(named, { ...args, sink: client.mediaSink }, meta, async (paths) => {
          for (const p of paths) client.session.writtenOutputs.add(p);
          // Sidecar per image so the interaction id survives a lost MCP response
          // (host timeout). Best-effort: the image is already on disk and the id
          // is in the result — a sidecar failure shouldn't fail the call.
          try {
            for (const p of paths) await writeSidecar(p, { ...meta, images: paths });
          } catch (err) {
            meta.sidecar_error = err instanceof Error ? err.message : String(err);
          }
        });
      });
    },
  );
}
