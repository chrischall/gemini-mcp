import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import { resolveModel } from '../models.js';
import type { GeminiClient, GeneratedImage } from '../client.js';
import { slugify, baseName } from '../images.js';
import { resolveImageInputs } from '../inputs.js';
import { emit, resolveAspectRatio, ASPECT_RATIOS, sharedImageSchema, pickSeed, buildMeta, timeoutRiskHint, withProgressHeartbeat, assertLocalInputsAvailable, imagesUrlSchema, imagesFileUrisSchema, imagesR2KeysSchema, charactersSchema, styleSchema, resolveCharacterRefs, composePrompt, persistBundle, SET_URL_TTL_MS, type NamedImage } from './shared.js';
import { fingerprintRequest } from '../jobs.js';
import { previewLocalInputsUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerSetTools(server: McpServer, client: GeminiClient): void {
  server.registerTool(
    'gemini_image_set',
    {
      description:
        'Generate a consistent SET of images: a master image from master_prompt, then one image per scene that references the master so the subject/style stays consistent. Provide `scenes` (explicit per-image prompts) OR `count` (variations of the master). ' +
        'Scene generations run in parallel (reference_mode "master", the default). On the hosted connector: saved `characters` and a saved `style` can seed the whole set by name, multi-image results include a `bundle_url` zip of every image (one curl instead of N), and `max_wait_ms` returns a pollable job handle if the batch runs long.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        master_prompt: z.string().min(1).describe('Prompt for the master/reference image'),
        scenes: z.array(z.string().min(1)).min(1).max(8).optional().describe('Per-image prompts (1-8); each references the master'),
        count: z.number().int().positive().max(8).optional().describe('Number of variations of master_prompt (when scenes omitted)'),
        reference_mode: z.enum(['master', 'chain']).optional().describe('master: every image references the master (default). chain: each references the previous.'),
        basename: z.string().optional().describe('Base filename prefix for output images (default: slugified master_prompt)'),
        master_images: z.array(z.string().min(1)).optional().describe('Reference image paths passed to the master generation call'),
        master_images_url: imagesUrlSchema('Reference images passed to the master AND to every scene call (fetched once)'),
        master_images_file_uris: imagesFileUrisSchema('Reference images passed to the master AND to every scene call'),
        master_images_r2_keys: imagesR2KeysSchema('Reference images passed to the master AND to every scene call'),
        characters: charactersSchema,
        style: styleSchema,
        master_images_base64: z.array(z.string().min(1)).optional().describe('Reference images as base64 strings or data URIs for master generation. Last resort: prefer master_images_url or master_images_file_uris, which keep image bytes out of the conversation'),
        confirm: schemaConfirm,
        ...sharedImageSchema,
      },
    },
    async (args, extra) => {
      assertLocalInputsAvailable(client.mediaSink, args);
      // `scenes` is min(1) at the schema, so a non-undefined value is non-empty.
      if ((args.scenes && args.count) || (!args.scenes && !args.count)) {
        throw new McpToolError('Provide exactly one of `scenes` or `count`.');
      }
      // Confirm-gate local file inputs: only `master_images` (paths) can read a
      // local file; base64 references pass through ungated. Dry-run makes NO API call.
      const gate = await previewLocalInputsUnlessConfirmed(args.confirm, 'Send local master image input(s) to the Gemini API', '/v1beta/models/{model}:generateContent', args.master_images);
      if (gate) return gate;
      const model = resolveModel(args.model, readEnvVar('GEMINI_IMAGE_MODEL'));
      // Resolve shape BEFORE fingerprinting: `orientation: 'portrait'` and
      // `aspect_ratio: '9:16'` are the same upstream request, so they must
      // dedup to the same job rather than billing twice (hence the resolved
      // ratio in the fingerprint below, and no `orientation` alongside it).
      const aspectRatio = resolveAspectRatio(args, ASPECT_RATIOS);
      const fingerprint = fingerprintRequest('gemini_image_set', {
        model, master_prompt: args.master_prompt, scenes: args.scenes, count: args.count,
        reference_mode: args.reference_mode, aspect_ratio: aspectRatio, image_size: args.image_size,
        thinking_level: args.thinking_level, google_search: args.google_search,
        master_images: args.master_images, master_images_base64: args.master_images_base64, from_clipboard: args.from_clipboard,
        master_images_url: args.master_images_url, master_images_file_uris: args.master_images_file_uris,
        master_images_r2_keys: args.master_images_r2_keys, characters: args.characters, style: args.style,
      });
      return client.session.jobs.dispatch({ toolName: 'gemini_image_set', fingerprint, idempotencyKey: args.idempotency_key, async: args.async, waitMs: args.max_wait_ms }, async () => {
        const seed = pickSeed(args.seed);
        const cfg = { model: args.model, aspectRatio, imageSize: args.image_size, thinkingLevel: args.thinking_level, googleSearch: args.google_search, timeoutMs: args.timeout_ms };
        const slug = args.basename ? baseName(args.basename) : slugify(args.master_prompt);

        // 1. master (optionally seeded from reference images).
        //
        // Two resolutions, because the two groups have different lifetimes:
        //
        //  - `carried` — URL and Files API references. Fetched/uploaded ONCE for
        //    the whole set (a URL repeated across master + N scenes is one
        //    download, and a `files/…` reference costs nothing to repeat), and
        //    passed to EVERY scene call, where they do the most good: they are
        //    what keeps the subject consistent scene to scene.
        //  - `masterOnly` — path / base64 / clipboard references. Master-only,
        //    exactly as before these parameters existed, so pre-existing calls
        //    still build byte-identical requests.
        // Saved characters/style resolve first and fail fast on an unknown
        // name, before anything billable. Their reference images join the
        // CARRIED group — consistency references belong on every scene call.
        const charRefs = await resolveCharacterRefs(client, args.characters, args.style);
        // The master prompt gets the full library treatment (character
        // preamble + style fragment). Scene prompts get only the style
        // fragment: their first attached image is the master output, so the
        // preamble's "attached in order" claim would be off by one there —
        // the master image itself is what anchors identity scene to scene.
        const masterPrompt = composePrompt(args.master_prompt, charRefs);
        const styleOnly = { styleFragment: charRefs.styleFragment };
        const carried = await resolveImageInputs(
          { images_url: args.master_images_url, images_file_uris: args.master_images_file_uris, images_r2_keys: args.master_images_r2_keys },
          client,
        );
        /** What every SCENE call attaches (after its master/previous image). */
        const carriedRefs = [...charRefs.inputs, ...carried.inputs];
        const masterOnly = await resolveImageInputs(
          { images: args.master_images, images_base64: args.master_images_base64, from_clipboard: args.from_clipboard },
          client,
        );
        const masterRefInputs = [...charRefs.inputs, ...masterOnly.inputs, ...carried.inputs];
        /** Scenes that failed, so one bad scene cannot lose the whole batch. */
        const failed: Array<{ scene: number; prompt: string; error: string }> = [];
        const report = carried.report || masterOnly.report
          ? { ...masterOnly.report, ...carried.report }
          : undefined;
        const named: NamedImage[] = [];
        const masterResult = await withProgressHeartbeat(extra, `Generating image set (${model})`, async () => {
          const result = await client.generate({
            prompt: masterPrompt,
            images: masterRefInputs.length > 0 ? masterRefInputs : undefined,
            seed,
            ...cfg,
          });
          const master = result.images[0];
          named.push({ image: master, base: `${slug}-master` });

          // Only the master's text is surfaced (below). Per-scene text is intentionally
          // dropped — a set returns one combined result and merging N captions is noise.
          // 2. scene prompts (explicit, or N repeats of master_prompt for variations)
          const scenePrompts = args.scenes ?? Array.from({ length: args.count ?? 0 }, () => args.master_prompt);
          const mode = args.reference_mode ?? 'master';

          // A set is N+1 billed generations in one tools/call, and any one of
          // them can fail — a safety filter on a single scene, a transient 5xx.
          // `Promise.all` rejected the whole batch on the first failure, losing
          // the master and every scene that HAD succeeded, and surfaced as an
          // opaque "Error occurred during tool execution" with no indication of
          // which scene or why. Failures are collected per scene instead.
          const sceneName = (i: number) => `${slug}-${String(i + 1).padStart(2, '0')}`;
          const record = (err: unknown, i: number) => {
            failed.push({
              scene: i + 1,
              prompt: scenePrompts[i],
              error: err instanceof Error ? err.message : String(err),
            });
          };

          if (mode === 'chain') {
            let ref: GeneratedImage = master;
            for (let i = 0; i < scenePrompts.length; i++) {
              try {
                const { images: [img] } = await client.generate({ prompt: composePrompt(scenePrompts[i], styleOnly), images: [ref, ...carriedRefs], seed: seed + i + 1, ...cfg });
                named.push({ image: img, base: sceneName(i) });
                // Chain mode anchors each scene on the previous OUTPUT, so a
                // failure must not advance the reference — the next scene
                // continues from the last image that actually exists.
                ref = img;
              } catch (err) {
                record(err, i);
              }
            }
          } else {
            const settled = await Promise.allSettled(
              scenePrompts.map((p, i) => client.generate({ prompt: composePrompt(p, styleOnly), images: [master, ...carriedRefs], seed: seed + i + 1, ...cfg }).then((r) => r.images[0])),
            );
            settled.forEach((outcome, i) => {
              if (outcome.status === 'fulfilled') named.push({ image: outcome.value, base: sceneName(i) });
              else record(outcome.reason, i);
            });
          }
          return result;
        });
        const masterText = masterResult.text;

        const meta = buildMeta(model, seed, { ...args, aspect_ratio: aspectRatio });
        if (masterText) meta.text = masterText;
        if (masterResult.grounding) meta.grounding = masterResult.grounding;
        if (report) meta.image_inputs = report;
        if (charRefs.meta) Object.assign(meta, charRefs.meta);
        if (failed.length) {
          meta.failed_scenes = failed;
          meta.partial =
            `${failed.length} of ${failed.length + named.length - 1} scene(s) failed; the master and the ` +
            `${named.length - 1} scene(s) that succeeded are returned above. Re-run just the failed prompts rather than the whole set — ` +
            'each failure message is in failed_scenes.';
        }
        // A set is master + N scenes in one tools/call — the most timeout-prone
        // tool. Effective image count drives the risk hint.
        const risk = timeoutRiskHint({ model, imageSize: args.image_size, count: named.length, persistsFiles: client.mediaSink?.persistsFiles });
        if (risk) meta.timeout_risk = risk;
        // One zip of the whole set (object-storage sinks, >1 image) — the
        // consumer runs ONE curl instead of N. Best-effort; per-image URLs and
        // curl_hints below are unaffected.
        if (!args.inline) Object.assign(meta, await persistBundle(named, client.mediaSink, slug));
        // A set is a batch someone comes back to: sign its links (and the
        // bundle's) for ~7 days rather than the default ~48h. The sink clamps
        // to the retention window; the disk sink ignores it entirely.
        return emit(named, { ...args, sink: client.mediaSink, urlTtlMs: SET_URL_TTL_MS }, meta);
      });
    },
  );
}
