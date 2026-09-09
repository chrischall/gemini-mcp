import { describe, it, expect, afterEach } from 'vitest';
import { GeminiClient } from '../src/client.js';
import { DEFAULT_VIDEO_MODEL } from '../src/models.js';

/**
 * The omni GA migration and the Lyria request-shape fix, both probed live
 * against a funded key 2026-09-09 (docs/GEMINI-API.md).
 *
 * Two things were wrong before this. The video default was
 * `gemini-omni-flash-preview`, which shuts down 2026-09-30. And the music path
 * sent `response_format.audio_format`, a field the API does not have — every
 * call that carried it answered `400 Unknown parameter 'audio_format' at
 * 'response_format'`, on every Lyria model. The real field is `mime_type`, and
 * no Lyria model accepts anything but MP3 today, so the server sends no format
 * field at all rather than a lever that cannot move.
 */

const ORIG_KEY = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
});

interface Body {
  model?: string;
  response_format?: Record<string, unknown>;
  generation_config?: { video_config?: { task?: string } };
}

const VIDEO_STEP = { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'VIDEOBYTES' }] };
const AUDIO_STEP = { type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: 'AUDIOBYTES' }] };

/** Captures the POST body and answers with the given completed interaction. */
function capture(steps: unknown[]): { fn: typeof fetch; bodies: Body[] } {
  const bodies: Body[] = [];
  const fn = (async (_url: string, init: RequestInit = {}) => {
    if (init.body) bodies.push(JSON.parse(init.body as string) as Body);
    const body = { id: 'v1_x', status: 'completed', steps };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe('video — omni GA', () => {
  it('defaults to the GA omni model, not the preview that shuts down 2026-09-30', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('gemini-omni-1.1-flash');
  });

  it('sends resolution in response_format when the caller asks for one', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capture([VIDEO_STEP]);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateVideo({ input: 'a red balloon', resolution: '360p', delivery: 'inline' });
    expect(cap.bodies[0].response_format?.resolution).toBe('360p');
    expect(cap.bodies[0].model).toBe('gemini-omni-1.1-flash');
  });

  it('omits resolution entirely when unset, so the model applies its own default', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capture([VIDEO_STEP]);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateVideo({ input: 'a red balloon', delivery: 'inline' });
    expect(cap.bodies[0].response_format).not.toHaveProperty('resolution');
  });

  it('passes the extend task through — omni GA added it to the task enum', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capture([VIDEO_STEP]);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateVideo({ input: 'keep going', task: 'extend', delivery: 'inline' });
    expect(cap.bodies[0].generation_config?.video_config?.task).toBe('extend');
  });
});

describe('music — Lyria request shape', () => {
  it('never sends audio_format: the API has no such field and 400s on it', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capture([AUDIO_STEP]);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateMusic({ input: 'lofi' });
    expect(cap.bodies[0].response_format).toEqual({ type: 'audio' });
  });

  it('never sends delivery on audio: the enum accepts uri, the runtime rejects it', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const cap = capture([AUDIO_STEP]);
    const c = new GeminiClient({ fetchImpl: cap.fn });
    await c.generateMusic({ input: 'lofi' });
    expect(cap.bodies[0].response_format).not.toHaveProperty('delivery');
  });
});
