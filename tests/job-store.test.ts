import { describe, expect, it } from 'vitest';
import { createBlobJobStore, EXECUTOR_LOST_AFTER_MS, type JobRecord, type JobStoreBucket } from '../src/job-store.js';

/**
 * The durable half of the job registry.
 *
 * The in-memory registry is correct for stdio, where the process outlives the
 * work. Hosted it does not: the connector is a Node child on a Fly machine with
 * `auto_stop_machines = "stop"` / `min_machines_running = 0`, so an open
 * request is the only thing keeping the machine up. An `async: true` call
 * answers immediately, the machine stops, and the child dies holding the only
 * record that the job ever existed — the caller polls two minutes later and is
 * told the id is unknown.
 *
 * So the record goes where the machine cannot take it with it: the same blob
 * store the media already lands in. These tests pin the properties that make
 * that record trustworthy — it survives the executor, it is tenant-scoped, and
 * a job whose executor died ends in a TERMINAL state rather than either
 * vanishing or claiming to still be running.
 */

function fakeBucket(): JobStoreBucket & { objects: Map<string, string>; puts: string[] } {
  const objects = new Map<string, string>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    async put(key, value) {
      puts.push(key);
      objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array));
    },
    async get(key) {
      const hit = objects.get(key);
      if (hit === undefined) return null;
      const bytes = new TextEncoder().encode(hit);
      return {
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    },
  };
}

const T0 = 1_700_000_000_000;

function store(bucket = fakeBucket(), tenant = 'a632ccd72524', now = () => T0) {
  return { jobs: createBlobJobStore(bucket, { tenant, now }), bucket };
}

function record(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: '078b94b4-c52e-416b-b1e0-f77b92b6619d',
    toolName: 'gemini_image_set',
    fingerprint: 'abc123',
    status: 'running',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe('createBlobJobStore', () => {
  it('round-trips a job record through the store', async () => {
    const { jobs } = store();
    await jobs.put(record());
    const got = await jobs.get('078b94b4-c52e-416b-b1e0-f77b92b6619d');
    expect(got?.toolName).toBe('gemini_image_set');
    expect(got?.status).toBe('running');
  });

  it('survives the executor: a record written by one store reads back from another', async () => {
    // The whole point. Two stores over one bucket stand in for the child that
    // wrote the record and the child that replaced it after the machine stopped.
    const bucket = fakeBucket();
    await createBlobJobStore(bucket, { tenant: 'a632ccd72524', now: () => T0 }).put(record());
    const reborn = createBlobJobStore(bucket, { tenant: 'a632ccd72524', now: () => T0 + 120_000 });
    expect((await reborn.get('078b94b4-c52e-416b-b1e0-f77b92b6619d'))?.toolName).toBe('gemini_image_set');
  });

  it('scopes every key to the tenant, so one account cannot read another job', async () => {
    const bucket = fakeBucket();
    await createBlobJobStore(bucket, { tenant: 'a632ccd72524', now: () => T0 }).put(record());
    expect([...bucket.objects.keys()].every((k) => k.startsWith('jobs/a632ccd72524/'))).toBe(true);
    const other = createBlobJobStore(bucket, { tenant: 'ffffffffffff', now: () => T0 });
    expect(await other.get('078b94b4-c52e-416b-b1e0-f77b92b6619d')).toBeUndefined();
  });

  it('reports a still-running job as running while its heartbeat is fresh', async () => {
    const bucket = fakeBucket();
    await createBlobJobStore(bucket, { tenant: 't', now: () => T0 }).put(record({ updatedAt: T0 }));
    const later = createBlobJobStore(bucket, { tenant: 't', now: () => T0 + EXECUTOR_LOST_AFTER_MS - 1 });
    expect((await later.get(record().jobId))?.status).toBe('running');
  });

  it('turns a running job whose executor stopped heartbeating into a terminal failure', async () => {
    // The bug in one assertion: the machine went away mid-job. The record must
    // not keep claiming "running" forever, and must not read as "unknown".
    const bucket = fakeBucket();
    await createBlobJobStore(bucket, { tenant: 't', now: () => T0 }).put(record({ updatedAt: T0 }));
    const later = createBlobJobStore(bucket, { tenant: 't', now: () => T0 + EXECUTOR_LOST_AFTER_MS + 1 });
    const got = await later.get(record().jobId);
    expect(got?.status).toBe('failed');
    expect(got?.error?.message).toMatch(/executor/i);
  });

  it('does not re-age a job that already finished', async () => {
    const bucket = fakeBucket();
    await createBlobJobStore(bucket, { tenant: 't', now: () => T0 }).put(record({ status: 'done', updatedAt: T0 }));
    const later = createBlobJobStore(bucket, { tenant: 't', now: () => T0 + EXECUTOR_LOST_AFTER_MS * 10 });
    expect((await later.get(record().jobId))?.status).toBe('done');
  });

  it('maps an idempotency key to its job across a restart', async () => {
    const bucket = fakeBucket();
    const first = createBlobJobStore(bucket, { tenant: 't', now: () => T0 });
    await first.put(record({ idempotencyKey: 'summer-camp' }));
    await first.putKey('summer-camp', record().jobId);
    const reborn = createBlobJobStore(bucket, { tenant: 't', now: () => T0 + 300_000 });
    expect(await reborn.jobIdForKey('summer-camp')).toBe(record().jobId);
  });

  it('keys an idempotency pointer by hash, so a slash or space cannot escape the key space', async () => {
    const { jobs, bucket } = store();
    await jobs.putKey('../../etc/passwd', 'job-1');
    expect([...bucket.objects.keys()].every((k) => k.startsWith('jobs/a632ccd72524/keys/'))).toBe(true);
    expect([...bucket.objects.keys()].some((k) => k.includes('..'))).toBe(false);
    expect(await jobs.jobIdForKey('../../etc/passwd')).toBe('job-1');
  });

  it('treats a malformed record as absent rather than throwing', async () => {
    // Recovery is best-effort: a parse failure must not turn a pollable job
    // into a 500 that hides every other job behind it.
    const { jobs, bucket } = store();
    bucket.objects.set('jobs/a632ccd72524/broken.json', '{not json');
    expect(await jobs.get('broken')).toBeUndefined();
  });

  it('never lets a store failure escape — a durable miss must not fail the call', async () => {
    const failing: JobStoreBucket = {
      async put() {
        throw new Error('blob put failed (503)');
      },
      async get() {
        throw new Error('blob get failed (503)');
      },
    };
    const jobs = createBlobJobStore(failing, { tenant: 't', now: () => T0 });
    await expect(jobs.put(record())).resolves.toBeUndefined();
    await expect(jobs.get('x')).resolves.toBeUndefined();
    await expect(jobs.jobIdForKey('k')).resolves.toBeUndefined();
  });
});
