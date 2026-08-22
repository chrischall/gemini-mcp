import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { JobRegistry } from '../src/jobs.js';
import { createBlobJobStore, EXECUTOR_LOST_AFTER_MS, type JobStoreBucket } from '../src/job-store.js';
import { GeminiClient, client } from '../src/client.js';
import { registerJobTools } from '../src/tools/jobs.js';
import { textResult } from '@chrischall/mcp-utils';

/**
 * Durable recovery of a lost generation.
 *
 * `background: true` is the only way to learn an interaction id BEFORE the
 * work finishes, and an id is the only thing that outlives the machine: the
 * generation keeps running on Google's side after the executor here is
 * reclaimed, and `GET /interactions/{id}` still serves its output afterwards
 * (verified live 2026-08-22 — a completed interaction returns its media uri
 * long after the request that created it is gone).
 *
 * So: the id is written into the durable job record as soon as it exists, and
 * a poll that finds a lost job with an id recovered from it re-hosts the media
 * instead of reporting the work as destroyed. Durability buys the RECORD and
 * now, where the id exists, the OUTPUT — never the execution.
 */

const ORIG_KEY = process.env.GEMINI_API_KEY;
let dir: string;
// `SessionState.reset()` clears the registry's JOBS, not the `store`/`now` a
// test grafts onto it — so these are restored by hand. Without this, a later
// test in this file inherits a blob store and a clock set minutes into the
// future, which is the sort of leak that fails somewhere else entirely.
const ORIG_STORE = client.session.jobs.store;
const ORIG_NOW = client.session.jobs.now;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_KEY;
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  client.session.reset();
  client.session.jobs.store = ORIG_STORE;
  client.session.jobs.now = ORIG_NOW;
});

const T0 = 1_700_000_000_000;
const MP4_B64 = 'AAAAIGZ0eXBpc29tAAAAAA==';

function fakeBucket(): JobStoreBucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key, value) {
      objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array));
    },
    async get(key) {
      const hit = objects.get(key);
      if (hit === undefined) return null;
      const bytes = new TextEncoder().encode(hit);
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    },
  };
}

function hostedRegistry(bucket: JobStoreBucket, now: () => number = () => T0): JobRegistry {
  const registry = new JobRegistry();
  registry.store = createBlobJobStore(bucket, { tenant: 't', now });
  registry.now = now;
  return registry;
}

function recordIn(bucket: { objects: Map<string, string> }, jobId: string): Record<string, unknown> {
  const key = [...bucket.objects.keys()].find((k) => k.includes(encodeURIComponent(jobId)));
  return key ? JSON.parse(bucket.objects.get(key)!) : {};
}

describe('the interaction id reaches the durable record', () => {
  it('records an interaction id reported while the job is still running', async () => {
    const bucket = fakeBucket();
    const registry = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const call = registry.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f1', async: true }, async (ctx) => {
      ctx.reportInteraction('v1_live');
      await gate;
      return textResult({ videos: ['/tmp/x.mp4'] });
    });
    const handle = parseToolResult<{ job_id: string }>(await call);

    // The point of the whole exercise: the id is durable BEFORE the work ends,
    // because the machine can stop at any moment while it runs.
    await registry.drain();
    expect(recordIn(bucket, handle.job_id).interactionId).toBe('v1_live');
    expect(recordIn(bucket, handle.job_id).status).toBe('running');

    release();
    await registry.drain();
  });

  it('leaves the record alone when the work never reports one', async () => {
    const bucket = fakeBucket();
    const registry = hostedRegistry(bucket);
    const res = await registry.dispatch({ toolName: 'gemini_image_generate', fingerprint: 'f2' }, async () => textResult({ images: ['x'] }));
    expect(res).toBeDefined();
    await registry.drain();
    const [key] = [...bucket.objects.keys()];
    expect(JSON.parse(bucket.objects.get(key)!)).not.toHaveProperty('interactionId');
  });
});

describe('generateVideo reports its interaction id as soon as it exists', () => {
  it('fires the callback on the POST response, not on completion', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const seen: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        const started = { id: 'v1_bg', status: 'in_progress' };
        return { ok: true, status: 200, json: async () => started, text: async () => JSON.stringify(started) };
      }
      polls++;
      // Still running for the first poll: the id must already be reported.
      const body = polls === 1
        ? { id: 'v1_bg', status: 'in_progress' }
        : { id: 'v1_bg', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: MP4_B64 }] }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;

    const c = new GeminiClient({
      fetchImpl,
      sleep: async () => { seen.push(`poll-${polls}`); },
    });
    await c.generateVideo({
      input: 'x',
      delivery: 'inline',
      background: true,
      onInteractionStarted: (id) => seen.push(`reported:${id}`),
    });
    expect(seen[0]).toBe('reported:v1_bg');
  });
});

describe('fetchInteractionMedia', () => {
  it('fetches a finished interaction and resolves its media to bytes', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media';
    const fetchImpl = (async (url: string) => {
      if (url.includes('/interactions/')) {
        const body = { id: 'v1_done', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri }] }] };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      const bytes = new Uint8Array([0x41, 0x42, 0x43]);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'video/mp4' },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }) as unknown as typeof fetch;
    const c = new GeminiClient({ fetchImpl });
    const out = await c.fetchInteractionMedia('v1_done');
    expect(out.status).toBe('completed');
    expect(out.videos).toEqual([{ base64: 'QUJD', mimeType: 'video/mp4' }]);
  });
});

describe('gemini_get_result recovers a lost generation from its interaction id', () => {
  it('re-hosts the media of a job whose executor died', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    dir = mkdtempSync(join(tmpdir(), 'gemini-recover-'));
    const bucket = fakeBucket();

    // A child started a backgrounded video, recorded the id, and was reclaimed.
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f', async: true }, async (ctx) => {
        ctx.reportInteraction('v1_survivor');
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    // A fresh child answers the poll, long after the heartbeat stopped.
    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    vi.spyOn(client, 'fetchInteractionMedia').mockResolvedValue({
      status: 'completed',
      images: [],
      videos: [{ base64: MP4_B64, mimeType: 'video/mp4' }],
      audios: [],
    });

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id, output_dir: dir });
    const data = parseToolResult<{ videos: string[]; recovered_from_interaction: string }>(res);

    expect(data.recovered_from_interaction).toBe('v1_survivor');
    expect(data.videos).toHaveLength(1);
    expect(existsSync(data.videos[0])).toBe(true);
    await h.close();
    release();
  });

  it('reports still-running rather than recovering a half-finished interaction', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const bucket = fakeBucket();
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f', async: true }, async (ctx) => {
        ctx.reportInteraction('v1_slow');
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    vi.spyOn(client, 'fetchInteractionMedia').mockResolvedValue({ status: 'in_progress', images: [], videos: [], audios: [] });

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id });
    const data = parseToolResult<{ status: string }>(res);
    expect(data.status).toBe('running');
    await h.close();
    release();
  });

  it('keeps the executor-lost error when the interaction cannot be retrieved', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const bucket = fakeBucket();
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f', async: true }, async (ctx) => {
        ctx.reportInteraction('v1_unreachable');
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    // The 400-forever case seen live: the interaction exists as an id and is
    // never retrievable. Recovery must not paper over the loss.
    vi.spyOn(client, 'fetchInteractionMedia').mockRejectedValue(new Error('Request contains an invalid argument.'));

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/was lost/i);
    expect(text).toContain('v1_unreachable');
    await h.close();
    release();
  });

  it('reads a 403 probe as work still in flight, not as an unrecoverable loss', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const bucket = fakeBucket();
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f', async: true }, async (ctx) => {
        ctx.reportInteraction('v1_inflight');
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    // Verified live: a GET of an in-flight background interaction answers 403.
    // Telling the caller their generation is unrecoverable while it is still
    // being generated is the worst possible wrong answer — they re-pay.
    vi.spyOn(client, 'fetchInteractionMedia').mockRejectedValue(
      Object.assign(new Error('Gemini Interactions error 403 for GET /interactions/v1_inflight'), { status: 403 }),
    );

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id });
    const data = parseToolResult<{ status: string; interaction_id: string }>(res);
    expect(data.status).toBe('running');
    expect(data.interaction_id).toBe('v1_inflight');
    await h.close();
    release();
  });

  it('does not report a failed upstream interaction as still running', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const bucket = fakeBucket();
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_video_generate', fingerprint: 'f', async: true }, async (ctx) => {
        ctx.reportInteraction('v1_failed');
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    // Terminal upstream, no media. Telling the caller to "poll again" would
    // loop them forever on a generation that is never going to arrive.
    vi.spyOn(client, 'fetchInteractionMedia').mockResolvedValue({ status: 'failed', images: [], videos: [], audios: [] });

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/was lost/i);
    await h.close();
    release();
  });

  it('does not attempt recovery for a job that never had an interaction id', async () => {
    const bucket = fakeBucket();
    const submitter = hostedRegistry(bucket);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = parseToolResult<{ job_id: string }>(
      await submitter.dispatch({ toolName: 'gemini_image_generate', fingerprint: 'f', async: true }, async () => {
        await gate;
        return textResult({});
      }),
    );
    await submitter.drain();

    const later = () => T0 + EXECUTOR_LOST_AFTER_MS + 60_000;
    client.session.jobs.store = createBlobJobStore(bucket, { tenant: 't', now: later });
    client.session.jobs.now = later;
    const spy = vi.spyOn(client, 'fetchInteractionMedia');

    const h = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await h.callTool('gemini_get_result', { job_id: handle.job_id });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    await h.close();
    release();
  });
});
