import { describe, it, expect } from 'vitest';

import { InMemoryJobRepository, type Job, type JobRepository } from '../data/job-repo.js';
import type { RecordAuditInput } from '../data/audit-repo.js';
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
//   - AuditEmitter.record(input) is the only method an emitter needs, and
//     RecordAuditInput carries actor/action/targetType/targetId/detail:
//     src/data/audit-emit.ts:28-30; src/data/audit-repo.ts:96-105
//   - The terminal `job.failed` entry this reconciler must match (the one the
//     in-process worker emits when IT settles the job):
//     src/pipeline/url-pull-worker.ts:324-334
//   - Per-stack scan contract mirrored by the fake below:
//     WorkspaceStackResolver.listStackNames() (src/services/workspace-stack.ts:1155)
//     + runWithRequestStack(stackName, fn) (src/services/request-stack-context.ts:46)

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

  // Issue #1032/#1000: this reconciler is a SETTLE SITE for the ingest-url job's
  // terminal transition, so it owes the same terminal audit entry the in-process
  // worker emits (url-pull-worker.ts:324-334). Without it the job keeps its
  // `job.submitted` entry and its audit history never closes.
  it('emits exactly one terminal job.failed audit entry per settled job, and none for a job left alone', async () => {
    const inner = new InMemoryJobRepository();
    const { job: interrupted } = await runningIngest(inner);
    const boundary = msAfter(interrupted, 60_000);
    // A live pull: stamped AFTER the boundary, so it is not settled and must not
    // produce a terminal entry.
    const live = (await inner.update(
      (await inner.create({ type: 'ingest-url', assetId: 'asset-live', sourceUrl: 'https://x/live' })).id,
      { status: 'running' }
    ))!;
    expect(Date.parse(live.updatedAt)).toBeLessThan(boundary); // same wall clock...
    const jobs: JobRepository = {
      list: (opts) => inner.list(opts),
      get: async (id: string) => {
        const fresh = await inner.get(id);
        if (!fresh) return undefined;
        // ...so push the live pull past the boundary on the fresh read, exactly
        // as a progress update from a running worker would.
        return fresh.id === live.id
          ? { ...fresh, updatedAt: new Date(boundary + 1_000).toISOString() }
          : fresh;
      },
      update: (id, patch) => inner.update(id, patch),
      create: (input) => inner.create(input),
      findActiveByAssetId: (assetId) => inner.findActiveByAssetId(assetId),
      findByEncoreJobId: (encoreJobId) => inner.findByEncoreJobId(encoreJobId),
      appendEncodeAttempt: (id, attempt) => inner.appendEncodeAttempt(id, attempt),
      finalizeEncodeAttempt: (id, patch) => inner.finalizeEncodeAttempt(id, patch)
    };

    const recorded: RecordAuditInput[] = [];
    const auditErrors: unknown[] = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: boundary,
      audit: { record: async (input) => { recorded.push(input); return undefined; } },
      auditLog: { error: (obj) => auditErrors.push(obj) }
    });

    expect(result).toEqual({ scanned: 2, settled: 1 });
    // emitAudit is fire-and-forget (src/data/audit-emit.ts:59-63): let the
    // detached promise chain flush before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(auditErrors).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      actor: { principalId: null, origin: 'system' },
      action: 'job.failed',
      targetType: 'job',
      targetId: interrupted.id,
      detail: { jobType: 'ingest-url', assetId: 'asset-1', error: INTERRUPTED_PULL_ERROR }
    });
    // No entry for the job that was left alone.
    expect(recorded.filter((e) => e.targetId === live.id)).toEqual([]);
    // The source URL is never put in the audit detail (it can carry credentials).
    expect(JSON.stringify(recorded[0])).not.toContain('https://');
  });

  // A second run settles nothing, so the audit trail does not grow a duplicate
  // terminal entry for a job this reconciler already closed.
  it('does not re-emit job.failed on a repeated run', async () => {
    const { jobs, job } = await runningIngest();
    const boundary = msAfter(job, 60_000);
    const recorded: RecordAuditInput[] = [];
    const audit = { record: async (input: RecordAuditInput) => { recorded.push(input); return undefined; } };

    await reconcileInterruptedIngests({ jobs, processStartedAtMs: boundary, audit });
    await reconcileInterruptedIngests({ jobs, processStartedAtMs: boundary, audit });
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded.map((e) => e.action)).toEqual(['job.failed']);
  });

  // Audit emission is best-effort and must never make the settle failable: the
  // durable write already happened when the entry is emitted.
  it('still settles the job when the audit emitter rejects', async () => {
    const { jobs, job } = await runningIngest();
    const errors: unknown[] = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: msAfter(job, 60_000),
      audit: { record: async () => { throw new Error('audit store down'); } },
      auditLog: { error: (obj) => errors.push(obj) }
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect(errors).toHaveLength(1);
  });

  it('no-ops on an empty job list', async () => {
    const jobs = new InMemoryJobRepository();
    await expect(reconcileInterruptedIngests({ jobs, processStartedAtMs: Date.now() })).resolves.toEqual(
      { scanned: 0, settled: 0 }
    );
  });
});

// Issue #1062: PerWorkspaceJobRepository resolves the AMBIENT request stack, and
// boot has none, so an unassisted boot scan only ever sees the first-listed stack.
// These cases pin the per-stack walk that fixes it, with a fake that mirrors
// WorkspaceStackResolver.listStackNames() + runWithRequestStack().
describe('reconcileInterruptedIngests across stacks', () => {
  // A per-stack job store, selected by the ambient stack name — the behaviour
  // PerWorkspaceJobRepository gets from resolver.resolve(currentRequestStackName()).
  function multiStackJobs(stacks: Record<string, InMemoryJobRepository>): {
    jobs: JobRepository;
    stacks: {
      listStackNames(): Promise<string[]>;
      runInStack<T>(stackName: string | undefined, fn: () => Promise<T>): Promise<T>;
    };
    current(): string | undefined;
  } {
    let ambient: string | undefined;
    // With no ambient name, resolve the FIRST listed stack — exactly what
    // workspace-stack.ts resolve() does for an empty stack name.
    const repo = (): InMemoryJobRepository => stacks[ambient ?? Object.keys(stacks)[0]!]!;
    const jobs: JobRepository = {
      list: (opts) => repo().list(opts),
      get: (id) => repo().get(id),
      update: (id, patch) => repo().update(id, patch),
      create: (input) => repo().create(input),
      findActiveByAssetId: (assetId) => repo().findActiveByAssetId(assetId),
      findByEncoreJobId: (encoreJobId) => repo().findByEncoreJobId(encoreJobId),
      appendEncodeAttempt: (id, attempt) => repo().appendEncodeAttempt(id, attempt),
      finalizeEncodeAttempt: (id, patch) => repo().finalizeEncodeAttempt(id, patch)
    };
    return {
      jobs,
      stacks: {
        listStackNames: async () => Object.keys(stacks),
        runInStack: async (stackName, fn) => {
          const previous = ambient;
          ambient = stackName;
          try {
            return await fn();
          } finally {
            ambient = previous;
          }
        }
      },
      current: () => ambient
    };
  }

  it('settles interrupted jobs in every provisioned stack, not just the first', async () => {
    const stackA = new InMemoryJobRepository();
    const stackB = new InMemoryJobRepository();
    const { job: jobA } = await runningIngest(stackA);
    const { job: jobB } = await runningIngest(stackB);
    const wiring = multiStackJobs({ 'stack-a': stackA, 'stack-b': stackB });

    const recorded: RecordAuditInput[] = [];
    const result = await reconcileInterruptedIngests({
      jobs: wiring.jobs,
      stacks: wiring.stacks,
      processStartedAtMs: msAfter(jobB, 60_000),
      audit: { record: async (input) => { recorded.push(input); return undefined; } }
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ scanned: 2, settled: 2 });
    expect((await stackA.get(jobA.id))?.status).toBe('failed');
    expect((await stackB.get(jobB.id))?.status).toBe('failed');
    // One terminal entry per settled job, in both stacks.
    expect(recorded.map((e) => e.targetId).sort()).toEqual([jobA.id, jobB.id].sort());
    // The ambient stack is restored after the walk.
    expect(wiring.current()).toBeUndefined();
  });

  // One unreachable stack must not hide the others' interrupted jobs.
  it('keeps reconciling the remaining stacks when one stack cannot be scanned', async () => {
    const good = new InMemoryJobRepository();
    const { job } = await runningIngest(good);
    const warnings: unknown[][] = [];

    const result = await reconcileInterruptedIngests({
      jobs: {
        list: async (opts) => good.list(opts),
        get: (id) => good.get(id),
        update: (id, patch) => good.update(id, patch),
        create: (input) => good.create(input),
        findActiveByAssetId: (assetId) => good.findActiveByAssetId(assetId),
        findByEncoreJobId: (encoreJobId) => good.findByEncoreJobId(encoreJobId),
        appendEncodeAttempt: (id, attempt) => good.appendEncodeAttempt(id, attempt),
        finalizeEncodeAttempt: (id, patch) => good.finalizeEncodeAttempt(id, patch)
      },
      stacks: {
        listStackNames: async () => ['broken', 'good'],
        runInStack: async (stackName, fn) => {
          if (stackName === 'broken') throw new Error('couch unreachable');
          return fn();
        }
      },
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await good.get(job.id))?.status).toBe('failed');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('broken');
  });

  // No parameter store / single fixed deployment context: listStackNames()
  // returns [] (workspace-stack.ts:1157) and the scan runs exactly ONCE against
  // the default resolution, identical to omitting `stacks` entirely.
  it('falls back to a single default-context pass when no stacks are listed', async () => {
    const { jobs, job } = await runningIngest();
    const contexts: Array<string | undefined> = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      stacks: {
        listStackNames: async () => [],
        runInStack: async (stackName, fn) => {
          contexts.push(stackName);
          return fn();
        }
      },
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(contexts).toEqual([undefined]);
    expect((await jobs.get(job.id))?.status).toBe('failed');
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
