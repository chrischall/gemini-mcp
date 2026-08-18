import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerGenerateTools } from '../../src/tools/generate.js';
import { registerJobTools } from '../../src/tools/jobs.js';
import { client } from '../../src/client.js';

vi.mock('../../src/clipboard.js', () => ({
  readClipboardImage: vi.fn().mockResolvedValue({ base64: 'Y2xpcGJvYXJk', mimeType: 'image/jpeg' }),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-jobs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); client.session.reset(); });

// A real timer, not setImmediate: finishing the job runs a dynamic import and
// a disk write, and neither lands in the microtask/check phase. With
// setImmediate the 50 iterations below could all elapse inside one busy tick,
// which failed this test intermittently under a loaded parallel run.
const tick = () => new Promise((r) => setTimeout(r, 2));
// The registry is a module-level singleton, so a job started on one harness is
// visible to gemini_get_result on another. Poll until it leaves 'running'.
// `args` must be Record<string, unknown> (not `unknown`) to accept a real
// TestHarness — parameter types are checked contravariantly.
async function pollResult(h: { callTool: (n: string, a?: Record<string, unknown>) => Promise<unknown> }, jobId: string) {
  for (let i = 0; i < 50; i++) {
    const m = parseToolResult<{ status?: string; images?: string[] }>(await h.callTool('gemini_get_result', { job_id: jobId }) as never);
    if (m.status !== 'running') return m;
    await tick();
  }
  throw new Error('job never left running');
}

describe('gemini_get_result', () => {
  it('async generation returns a job_id; get_result polls running → done', async () => {
    let resolveGen!: (v: { images: { base64: string; mimeType: string }[] }) => void;
    vi.spyOn(client, 'generate').mockImplementation(() => new Promise((res) => { resolveGen = res; }));
    const gen = await createTestHarness((srv) => registerGenerateTools(srv, client));
    const jobs = await createTestHarness((srv) => registerJobTools(srv, client));

    const started = parseToolResult<{ job_id: string; status: string }>(
      await gen.callTool('gemini_image_generate', { prompt: 'a red leaf', output_dir: dir, async: true }),
    );
    expect(started.status).toBe('running');
    expect(typeof started.job_id).toBe('string');

    const running = parseToolResult<{ status: string }>(await jobs.callTool('gemini_get_result', { job_id: started.job_id }));
    expect(running.status).toBe('running');

    resolveGen({ images: [{ base64: PNG, mimeType: 'image/png' }] });
    const done = await pollResult(jobs, started.job_id);
    expect(done.images).toHaveLength(1);

    await gen.close();
    await jobs.close();
  });

  it('returns an error for an unknown/expired job id', async () => {
    const jobs = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await jobs.callTool('gemini_get_result', { job_id: 'no-such-job' });
    expect(res.isError).toBe(true);
    await jobs.close();
  });
});
