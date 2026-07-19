import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import type { GeminiClient, GroundingResult } from '../client.js';
import { slugify, baseName, gatherImageInputs } from '../images.js';
import { emit, sharedImageSchema, pickSeed, buildMeta, timeoutRiskHint, resolveVideoInput, videoPathSchema, withProgressHeartbeat, assertLocalInputsAvailable, type NamedImage } from './shared.js';
import { fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

const GENERATE_ENDPOINT = '/v1beta/models/{model}:generateContent';
const SEND_LOCAL_ACTION = 'Send local file input(s) to the Gemini API';

// generateContent output can't seed an Interactions-API conversation, so
// results point follow-up edits at gemini_interact instead of an id.
const REFINE_HINT =
  'To iteratively refine this image, use gemini_interact (pass the output file via `images` on the first call, ' +
  'then chain `previous_interaction_id` on each subsequent call).';

export function registerGenerateTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_image_generate',
    {
      description:
        'Generate image(s) from a text prompt with a Gemini image model (Nano Banana / Nano Banana Pro). ' +
        'If the result will likely be refined iteratively, prefer gemini_interact (multi-turn) as the entry point.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Text prompt describing the image'),
        count: z.number().int().positive().max(8).optional().describe('Number of independent images (default 1)'),
        filename: z.string().optional().describe('Base filename for the output image (extension stripped; default: slugified prompt)'),
        images: z.array(z.string().min(1)).optional().describe('Paths to reference input images (image-conditioned generation)'),
        images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs'),
        video_url: z.string().url().optional().describe('Public YouTube URL (or a previously uploaded Files API uri) as a video reference (video→image; use a Flash model e.g. gemini-3.1-flash-image)'),
        video_path: videoPathSchema,
        confirm: schemaConfirm,
        ...sharedImageSchema,
      },
    },
    async (args, extra) => {
      // Local-path / clipboard / disk-upload inputs simply do not exist on the
      // hosted connector. Fail here — before the confirm gate previews files and
      // before any billable call — with the base64/URL alternative.
      assertLocalInputsAvailable(client.mediaSink, args);
      // Confirm-gate local file inputs: a prompt-injected `images`/`video_path`
      // could exfiltrate a local file. Pure text-to-image calls (no local input)
      // are unaffected. Dry-run makes NO API call.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, SEND_LOCAL_ACTION, GENERATE_ENDPOINT, args.images, args.video_path);
      if (gate) return gate;
      const count = args.count ?? 1;
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      // Fingerprint the request identity (excl. server-picked seed / output path)
      // so a blind re-issue after a host timeout dedups instead of re-billing.
      const fingerprint = fingerprintRequest('gemini_image_generate', {
        model, prompt: args.prompt, aspect_ratio: args.aspect_ratio, image_size: args.image_size,
        thinking_level: args.thinking_level, google_search: args.google_search, count,
        images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
        video_url: args.video_url, video_path: args.video_path,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_image_generate', fingerprint, idempotencyKey: args.idempotency_key, async: args.async }, async () => {
        const seed = pickSeed(args.seed);
        const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
        const refInputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
        // Upload ONCE (before the count loop) — every generate call references
        // the same files/… uri.
        const video = await withProgressHeartbeat(extra, 'Uploading video to the Gemini Files API', () => resolveVideoInput(args, client));
        const named: NamedImage[] = [];
        let capturedText: string | undefined;
        // For count>1, surface the FIRST call's grounding (each call grounds
        // independently; one representative set of sources beats concatenating N).
        let capturedGrounding: GroundingResult | undefined;
        await withProgressHeartbeat(extra, `Generating ${count > 1 ? `${count} images` : 'image'} (${model})`, async () => {
          for (let i = 0; i < count; i++) {
            // Distinct seed per image (seed+0 for the single-image case == echoed seed)
            // so count>1 yields N *different* images, not N duplicates.
            const result = await client.generate({
              prompt: args.prompt,
              images: refInputs.length > 0 ? refInputs : undefined,
              model: args.model,
              aspectRatio: args.aspect_ratio,
              imageSize: args.image_size,
              seed: seed + i,
              thinkingLevel: args.thinking_level,
              googleSearch: args.google_search,
              videoUrl: video.videoUrl,
              videoMimeType: video.videoMimeType,
              timeoutMs: args.timeout_ms,
            });
            const { images: [img], text } = result;
            if (text && !capturedText) capturedText = text;
            if (result.grounding && !capturedGrounding) capturedGrounding = result.grounding;
            named.push({ image: img, base: count === 1 ? slug : `${slug}-${String(i + 1).padStart(2, '0')}` });
          }
        });
        const meta = buildMeta(model, seed, args);
        if (capturedText) meta.text = capturedText;
        if (capturedGrounding) meta.grounding = capturedGrounding;
        if (video.videoFileMeta) meta.video_file = video.videoFileMeta;
        meta.hint = REFINE_HINT;
        const risk = timeoutRiskHint({ model, imageSize: args.image_size, count, persistsFiles: client.mediaSink?.persistsFiles });
        if (risk) meta.timeout_risk = risk;
        return emit(named, { ...args, sink: client.mediaSink }, meta);
      });
    },
  );

  server.registerTool(
    'gemini_image_edit',
    {
      description:
        'Edit or compose images: provide one or more input images (paths or base64), plus a text instruction. ' +
        'For a SERIES of successive edits to the same image, prefer gemini_interact (multi-turn) — it keeps edit context ' +
        'and avoids re-processing the full image each round; use gemini_image_edit for one-off edits or composing multiple distinct inputs. ' +
        'Gemini over-preserves the input; there is no edit-strength control — for large structural changes, reroll with a different `seed` or more forceful wording.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe('Instruction describing the edit or composition'),
        images: z.array(z.string().min(1)).optional().describe('Paths to input image file(s) (1 = edit, 2+ = compose)'),
        images_base64: z.array(z.string().min(1)).optional().describe('Input images as base64 strings or data URIs'),
        filename: z.string().optional().describe('Base filename for the output image (extension stripped; default: slugified prompt)'),
        confirm: schemaConfirm,
        ...sharedImageSchema,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      const hasPaths = (args.images?.length ?? 0) > 0;
      const hasBase64 = (args.images_base64?.length ?? 0) > 0;
      if (!hasPaths && !hasBase64 && !args.from_clipboard) {
        throw new McpToolError('Provide at least one input image via `images`, `images_base64`, or `from_clipboard`.');
      }
      // Confirm-gate local file inputs (see gemini_image_generate). base64 /
      // clipboard inputs are not local-path reads and pass through ungated.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, SEND_LOCAL_ACTION, GENERATE_ENDPOINT, args.images);
      if (gate) return gate;
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      const fingerprint = fingerprintRequest('gemini_image_edit', {
        model, prompt: args.prompt, aspect_ratio: args.aspect_ratio, image_size: args.image_size,
        thinking_level: args.thinking_level, google_search: args.google_search,
        images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_image_edit', fingerprint, idempotencyKey: args.idempotency_key, async: args.async }, async () => {
        const seed = pickSeed(args.seed);
        const slug = args.filename ? baseName(args.filename) : slugify(args.prompt);
        const inputs = await gatherImageInputs({ images: args.images, images_base64: args.images_base64, from_clipboard: args.from_clipboard });
        const result = await withProgressHeartbeat(extra, `Editing image (${model})`, () =>
          client.generate({
            prompt: args.prompt,
            images: inputs,
            model: args.model,
            aspectRatio: args.aspect_ratio,
            imageSize: args.image_size,
            seed,
            thinkingLevel: args.thinking_level,
            googleSearch: args.google_search,
            timeoutMs: args.timeout_ms,
          }));
        const { images: [img], text } = result;
        const meta = buildMeta(model, seed, args);
        if (text) meta.text = text;
        if (result.grounding) meta.grounding = result.grounding;
        meta.hint = REFINE_HINT;
        const risk = timeoutRiskHint({ model, imageSize: args.image_size, persistsFiles: client.mediaSink?.persistsFiles });
        if (risk) meta.timeout_risk = risk;
        return emit([{ image: img, base: slug }], { ...args, sink: client.mediaSink }, meta);
      });
    },
  );
}
