import { describe, it, expect } from 'vitest';

import { InMemoryJobRepository, type Job, type JobRepository } from '../data/job-repo.js';
import {
  reconcileInterruptedIngests,
  processStartTimeMs,
  INTERRUPTED_PULL_ERROR
} from './interrupted-ingest-reconciler.js';

// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Job.type/'ingest-url' + Job.status/'running' + Job.updatedAt + Job.error:
//     src/data/job-repo.ts:84-85, :56-57, :113-114, :179
//   - running -> failed allowed (ALLOWED_JOB_TRANSITIONS): src/data/job-repo.ts:248
//   - InMemoryJobRepository.create/get/update/list: src/data/job-repo.ts:452-509
//   - Test style (in-memory repos, build the stuck shape in a helper, assert the
//     { scanned, ... } summary + the record): src/pipeline/failed-transcode-reconciler.test.ts:66-96

// Build an ingest-url job in the exact stuck shape issue #1084 describes: the
// worker drove it `pending -> running` (url-pull-worker.ts:110) and then its
// process died, so nothing ever wrote the terminal state. Returns the repo and
// the job as last stamped.
async function runningIngest(repo?: JobRepository): Promise<{
  jobs: JobRepository;
  job: Job;
}> {
  const jobs = repo ?? new InMemoryJobRepository();
  const created = await jobs.create({
    type: 'ingest-url',
    assetId: 'asset-1',
    sourceUrl: 'https://example.com/source.mov'
  });
  const job = (await jobs.update(created.id, { status: 'running' }))!;
  return { jobs, job };
}

// The liveness boundary expressed relative to a job's own stamp, so the tests do
// not depend on wall-clock timing.
function msAfter(job: Job, deltaMs: number): number {
  return Date.parse(job.updatedAt) + deltaMs;
}

describe('reconcileInterruptedIngests', () => {
  // Acceptance 1: a running ingest-url job stamped BEFORE process start cannot be
  // owned by a worker in this process, so it is settled `failed` with a reason
  // naming the interruption.
  it('settles a running ingest-url job whose updatedAt predates process start', async () => {
    const { jobs, job } = await runningIngest();

    const result = await reconcileInterruptedIngests({
      jobs,
      // This process started a minute after the job was last touched.
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });

    const settled = await jobs.get(job.id);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBe(INTERRUPTED_PULL_ERROR);
    expect(settled?.error).toContain('interrupted');
  });

  // Acceptance 2: a running job stamped AFTER process start may be a pull that is
  // streaming bytes right now — it must never be settled.
  it('leaves a running ingest-url job whose updatedAt is after process start alone', async () => {
    const { jobs, job } = await runningIngest();

    const result = await reconcileInterruptedIngests({
      jobs,
      // This process started a minute BEFORE the job was last touched, i.e. the
      // pull belongs to this process and is live.
      processStartedAtMs: msAfter(job, -60_000)
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });

    const untouched = await jobs.get(job.id);
    expect(untouched?.status).toBe('running');
    expect(untouched?.error).toBeUndefined();
  });

  // The boundary itself: "at or after process start must be left untouched", so
  // updatedAt === processStart is NOT interrupted (the comparison is strict).
  it('leaves a job stamped exactly at process start alone (boundary is exclusive)', async () => {
    const { jobs, job } = await runningIngest();

    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: msAfter(job, 0)
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect((await jobs.get(job.id))?.status).toBe('running');
  });

  // Acceptance 3: other job types are owned by other paths — transcode jobs by
  // the Encore callback/#273 sweep, package jobs by the packager callback/#336
  // sweep — and must not be touched even when they look just as stale.
  it('does not touch non-ingest-url jobs (transcode, package)', async () => {
    const jobs = new InMemoryJobRepository();

    const transcode = await jobs.create({ type: 'transcode', assetId: 'asset-t', profile: 'program' });
    await jobs.update(transcode.id, { status: 'running', encoreInternalJobId: 'enc-1' });
    const pkg = await jobs.create({ type: 'package', assetId: 'asset-p' });
    await jobs.update(pkg.id, { status: 'running' });

    const stamped = (await jobs.get(transcode.id))!;
    const result = await reconcileInterruptedIngests({
      jobs,
      // Far in the future relative to both jobs: they are as stale as can be, and
      // still none of our business.
      processStartedAtMs: msAfter(stamped, 60 * 60_000)
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect((await jobs.get(transcode.id))?.status).toBe('running');
    expect((await jobs.get(transcode.id))?.error).toBeUndefined();
    expect((await jobs.get(pkg.id))?.status).toBe('running');
  });

  // Only `running` is owned by a dead worker: a terminal job is already settled
  // (and re-failing it would clobber the real outcome), and a `pending` job never
  // reached the worker's streaming phase, so it is out of this issue's scope.
  it('does not touch terminal or pending ingest-url jobs', async () => {
    const jobs = new InMemoryJobRepository();

    const done = await jobs.create({ type: 'ingest-url', assetId: 'a1', sourceUrl: 'https://x/1' });
    await jobs.update(done.id, { status: 'running' });
    await jobs.update(done.id, { status: 'done', progress: 100 });

    const failed = await jobs.create({ type: 'ingest-url', assetId: 'a2', sourceUrl: 'https://x/2' });
    await jobs.update(failed.id, { status: 'running' });
    await jobs.update(failed.id, { status: 'failed', error: 'source not found' });

    const pending = await jobs.create({ type: 'ingest-url', assetId: 'a3', sourceUrl: 'https://x/3' });

    const stamped = (await jobs.get(pending.id))!;
    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: msAfter(stamped, 60_000)
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect((await jobs.get(done.id))?.status).toBe('done');
    // The real terminal reason is preserved, not overwritten with ours.
    expect((await jobs.get(failed.id))?.error).toBe('source not found');
    expect((await jobs.get(pending.id))?.status).toBe('pending');
  });

  // Idempotent and safe to run more than once: the first run makes the job
  // terminal, so a second run finds nothing to settle and rewrites nothing.
  it('is idempotent across repeated runs', async () => {
    const { jobs, job } = await runningIngest();
    const boundary = msAfter(job, 60_000);

    const first = await reconcileInterruptedIngests({ jobs, processStartedAtMs: boundary });
    expect(first).toEqual({ scanned: 1, settled: 1 });
    const afterFirst = await jobs.get(job.id);

    const second = await reconcileInterruptedIngests({ jobs, processStartedAtMs: boundary });
    expect(second).toEqual({ scanned: 0, settled: 0 });

    const afterSecond = await jobs.get(job.id);
    expect(afterSecond?.status).toBe('failed');
    expect(afterSecond?.error).toBe(INTERRUPTED_PULL_ERROR);
    expect(afterSecond?.updatedAt).toBe(afterFirst?.updatedAt);
  });

  // A job that advanced between the page snapshot and the write (a slow pull that
  // just reported progress) is re-checked against a FRESH read and left alone, so
  // a live pull is never settled by a late write.
  it('re-reads before the write and skips a job that advanced since the snapshot', async () => {
    const { jobs: inner, job } = await runningIngest();
    const boundary = msAfter(job, 60_000);

    // A repository wrapper whose get() simulates the worker having just written
    // progress (a stamp after the boundary) between the list page and the settle.
    const jobs: JobRepository = {
      list: (opts) => inner.list(opts),
      get: async (id: string) => {
        const fresh = await inner.get(id);
        if (!fresh) return undefined;
        return { ...fresh, updatedAt: new Date(boundary + 1_000).toISOString() };
      },
      update: (id, patch) => inner.update(id, patch),
      create: (input) => inner.create(input),
      findActiveByAssetId: (assetId) => inner.findActiveByAssetId(assetId),
      findByEncoreJobId: (encoreJobId) => inner.findByEncoreJobId(encoreJobId),
      appendEncodeAttempt: (id, attempt) => inner.appendEncodeAttempt(id, attempt),
      finalizeEncodeAttempt: (id, patch) => inner.finalizeEncodeAttempt(id, patch)
    };

    const result = await reconcileInterruptedIngests({ jobs, processStartedAtMs: boundary });

    expect(result).toEqual({ scanned: 1, settled: 0 });
    expect((await inner.get(job.id))?.status).toBe('running');
  });

  // Best-effort per job: one job's failed write is logged and skipped, and the
  // rest of the run still settles.
  it('keeps going when one job fails to settle', async () => {
    const inner = new InMemoryJobRepository();
    const { job: first } = await runningIngest(inner);
    const { job: second } = await runningIngest(inner);
    const boundary = msAfter(second, 60_000);

    const warnings: unknown[][] = [];
    const jobs: JobRepository = {
      list: (opts) => inner.list(opts),
      get: (id) => inner.get(id),
      create: (input) => inner.create(input),
      findActiveByAssetId: (assetId) => inner.findActiveByAssetId(assetId),
      findByEncoreJobId: (encoreJobId) => inner.findByEncoreJobId(encoreJobId),
      appendEncodeAttempt: (id, attempt) => inner.appendEncodeAttempt(id, attempt),
      finalizeEncodeAttempt: (id, patch) => inner.finalizeEncodeAttempt(id, patch),
      update: async (id, patch) => {
        if (id === first.id) throw new Error('conflict');
        return inner.update(id, patch);
      }
    };

    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: boundary,
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 2, settled: 1 });
    expect((await inner.get(first.id))?.status).toBe('running');
    expect((await inner.get(second.id))?.status).toBe('failed');
    expect(warnings.length).toBe(1);
  });

  it('no-ops on an empty job list', async () => {
    const jobs = new InMemoryJobRepository();
    await expect(reconcileInterruptedIngests({ jobs, processStartedAtMs: Date.now() })).resolves.toEqual(
      { scanned: 0, settled: 0 }
    );
  });
});

describe('processStartTimeMs', () => {
  // The default liveness boundary: derived from process.uptime() so it is the
  // real process start whenever it is called, never dependent on import order.
  it('reports a boundary in the past, consistent with process.uptime()', () => {
    const start = processStartTimeMs();
    const now = Date.now();
    expect(start).toBeLessThanOrEqual(now);
    // Within a second of now - uptime, allowing for the clock read in between.
    expect(Math.abs(now - Math.round(process.uptime() * 1000) - start)).toBeLessThan(1_000);
  });
});
