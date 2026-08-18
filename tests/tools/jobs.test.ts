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
// setImmediate the loop below could exhaust every iteration inside one busy
// tick, which failed this test intermittently under a loaded parallel run.
const tick = () => new Promise((r) => setTimeout(r, 2));
// And a DEADLINE, not an iteration count: how many polls fit before the work
// lands is a property of the runner's load, so a count is a wall-clock budget
// written in the wrong unit.
//
// It must stay comfortably UNDER the test's own timeout, which is why that
// timeout is set explicitly below rather than left at vitest's default —
// measured at exactly 5000ms, the same number, and started earlier (at test
// entry, before the two harnesses are built). Equal budgets meant the outer
// clock won the race and replaced the message below with a generic "Test timed
// out in 5000ms", which is the opposite of the point. Raised in review of #150.
const POLL_DEADLINE_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;
// The registry is a module-level singleton, so a job started on one harness is
// visible to gemini_get_result on another. Poll until it leaves 'running'.
// `args` must be Record<string, unknown> (not `unknown`) to accept a real
// TestHarness — parameter types are checked contravariantly.
async function pollResult(h: { callTool: (n: string, a?: Record<string, unknown>) => Promise<unknown> }, jobId: string) {
  const giveUpAt = Date.now() + POLL_DEADLINE_MS;
  do {
    const m = parseToolResult<{ status?: string; images?: string[] }>(await h.callTool('gemini_get_result', { job_id: jobId }) as never);
    if (m.status !== 'running') return m;
    await tick();
  } while (Date.now() < giveUpAt);
  throw new Error(`job never left running within ${POLL_DEADLINE_MS}ms`);
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
  }, TEST_TIMEOUT_MS);

  it('returns an error for an unknown/expired job id', async () => {
    const jobs = await createTestHarness((srv) => registerJobTools(srv, client));
    const res = await jobs.callTool('gemini_get_result', { job_id: 'no-such-job' });
    expect(res.isError).toBe(true);
    await jobs.close();
  });
});
