import { describe, it, expect } from 'vitest';
import { GeminiClient } from '../src/client.js';
import { resolveImageInputs } from '../src/inputs.js';
import { DEFAULT_VIDEO_MODEL, DEFAULT_MUSIC_MODEL } from '../src/models.js';

/**
 * The three media paths, against the REAL API. Opt-in and skipped by default.
 *
 *   GEMINI_LIVE_API_KEY=… npx vitest run tests/media-paths.live.test.ts
 *
 * **These cost money.** Roughly $0.07 for the image, $0.34 for a 10s 360p
 * clip, $0.04 for a music clip. The key must be on a funded account; the
 * video and music models are refused outright on a free one.
 *
 * The suite exists because every one of these paths shipped a shape that had
 * never been run: the video model was three weeks from shutdown, and the music
 * request carried a field the API does not have (`audio_format`), so every
 * call that used it had always 400'd. Mocked tests pin what we MEANT to send.
 * Only this pins that the API accepts it.
 *
 * Deliberately not part of `npm test`: CI has no funded key, and a test that
 * cannot run in CI must not be able to fail it.
 */

const KEY = process.env.GEMINI_LIVE_API_KEY;
const live = KEY ? describe : describe.skip;

/** A 1×1 PNG — enough to exercise the upload, not enough to cost anything. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function client(): GeminiClient {
  return new GeminiClient({ apiKey: KEY });
}

live('base64 inputs are promoted to a Files API reference', () => {
  it('uploads the bytes and hands back a files/<id> the API accepts', async () => {
    const c = client();
    const { inputs, report } = await resolveImageInputs({ images_base64: [PNG_B64] }, c);

    // Promoted, not inlined: the caller gets a handle to reuse.
    expect(inputs[0].uri).toMatch(/\/files\//);
    expect(inputs[0].base64).toBeUndefined();
    expect(report?.base64_uploaded?.[0].file_uri).toMatch(/^files\//);

    // And the reference is one generateContent actually resolves. A `files/`
    // uri that uploads fine but is refused at generation time would look like
    // a safety block, so this half matters as much as the upload.
    const r = await c.generate({ prompt: 'describe the attached image as a single colour swatch', images: inputs });
    expect(r.images.length).toBeGreaterThan(0);

    // Same bytes again: cached, no second upload — and still reported, since
    // the repeat paste is the caller who needs the file_uri.
    const again = await resolveImageInputs({ images_base64: [PNG_B64] }, c);
    expect(again.inputs[0].uri).toBe(inputs[0].uri);
    expect(again.report?.base64_uploaded?.[0].file_uri).toBe(report?.base64_uploaded?.[0].file_uri);
  }, 180_000);
});

live('video — the GA omni model and its resolution lever', () => {
  it('generates a 360p clip through the default model', async () => {
    const c = client();
    const r = await c.generateVideo({ input: 'a single red balloon drifting upward', resolution: '360p' });
    expect(r.videos[0].mimeType).toBe('video/mp4');
    expect(r.videos[0].base64.length).toBeGreaterThan(1000);
    // Priced from the model that actually ran, not from the preview it replaced.
    expect(DEFAULT_VIDEO_MODEL).toBe('gemini-omni-1.1-flash');
    expect(r.usage?.video_tokens ?? 0).toBeGreaterThan(0);
  }, 900_000);
});

live('music — the Lyria request shape', () => {
  it('generates a clip with no format field in the request', async () => {
    const c = client();
    const r = await c.generateMusic({ input: 'a short calm solo piano loop, instrumental' });
    expect(r.audios[0].mimeType).toMatch(/^audio\//);
    expect(r.audios[0].base64.length).toBeGreaterThan(1000);
    expect(DEFAULT_MUSIC_MODEL).toBe('lyria-3-clip-preview');
  }, 600_000);
});
