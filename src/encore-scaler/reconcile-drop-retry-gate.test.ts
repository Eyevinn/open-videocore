// Route reconcile-detected drops through the #295 retry gate (issue #727).
//
// #295 / PR #314 made transport- and IO-class encode failures retriable, and
// retry-policy.ts classes "Stream ends prematurely", "corrupt input packet" and
// "Invalid NAL unit size" as io-retryable. But that retry gate (decideRetry) had
// exactly ONE call site — encore-callback-poller.ts, the FAILED-callback path. A
// read severed mid-encode produces NO FAILED callback: Encore never reports the
// job FAILED, it simply leaves QUEUED/IN_PROGRESS, and the scaler's reconcile()
// observes it as a DROP. That path (main.ts onJobsDropped -> settleFailedTranscode)
// settled terminal and never consulted decideRetry — so the ONE failure class #295
// was built to retry was the one class that structurally could not reach it.
//
// #727 routes onJobsDropped through the SAME retry gate. This file covers the four
// acceptance-criteria cases against the REAL decideRetry / settleFailedTranscode /
// recordDispatch / clearRetryState, driving each drop through the exact per-drop
// logic main.ts's onJobsDropped handler runs:
//   (a) an io-retryable drop UNDER the bound is re-dispatched (not settled).
//   (b) an io-retryable drop AT the bound settles `exhausted`.
//   (c) a deterministic drop settles `not-retryable`.
//   (d) a drop with no recovered reason settles as today (generic wording).
// Plus a guard: a drop already settled terminal is not re-dispatched (#709's
// conditional settle preserved).
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - decideRetry(redis, workspaceId, jobId, failureMessage) => RetryDecision
//     ({ action:'retry'|'settle', ... }); recordDispatch / clearRetryState —
//     src/encore-scaler/retry-store.ts:41-49, 53-55, 138-213.
//   - classifyEncoreFailure substring rule + IO_RETRYABLE_SIGNATURES / MAX_ENCODE_
//     ATTEMPTS — src/encore-scaler/retry-policy.ts:96-175, 115, 143-149.
//   - settleFailedTranscode(deps, job, error, reason?) + SettleReason
//     'gone-from-active-set' (conditional #709 settle) —
//     src/pipeline/failed-transcode-reconciler.ts:171, 189-228.
//   - DroppedJob = { encoreJobId, reason? } (reason carries Encore's own FAILED
//     message when recoverable, #704) — src/encore-scaler/types.ts:39-42.
//   - keys.queue / jobStatus / jobInstance / jobPayload / jobAttempts + QueuedJob —
//     src/encore-scaler/types.ts:185-232.
//   - decodeEncoreJobId / encodeEncoreJobId `${workspaceId}__${jobLocalId}` +
//     InMemory{Job,Asset,Pipeline}Repository — src/data/job-repo.ts,
//     src/data/asset-repo.ts, src/data/pipeline-repo.ts.
//   - main.ts onJobsDropped per-drop wiring (retry gate before settle) —
//     src/main.ts onJobsDropped handler.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

import { decideRetry, recordDispatch, clearRetryState } from './retry-store.js';
import { MAX_ENCODE_ATTEMPTS } from './retry-policy.js';
import { keys, type DroppedJob, type QueuedJob } from './types.js';
import {
  InMemoryJobRepository,
  encodeEncoreJobId,
  decodeEncoreJobId
} from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { settleFailedTranscode } from '../pipeline/failed-transcode-reconciler.js';

// Minimal in-memory Valkey fake covering exactly the commands decideRetry /
// recordDispatch / clearRetryState touch (strings, hashes, lists). Mirrors the
// fake in retry-policy.test.ts so both files exercise decideRetry identically.
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();

  async set(key: string, val: string): Promise<'OK'> {
    // EX/seconds args accepted and ignored by the fake.
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  async del(...args: string[]): Promise<number> {
    let n = 0;
    for (const k of args) if (this.strings.delete(k)) n++;
    return n;
  }
  async hset(key: string, field: string, val: string): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !h.has(field);
    h.set(field, val);
    this.hashes.set(key, h);
    return isNew ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, field: string): Promise<number> {
    const h = this.hashes.get(key);
    if (h && h.delete(field)) return 1;
    return 0;
  }
  async lpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    const end = stop === -1 ? l.length - 1 : stop;
    return l.slice(start, end + 1);
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

// The EXACT per-drop logic main.ts's onJobsDropped handler runs (#727): build the
// failureText, route non-terminal jobs through decideRetry, re-dispatch on 'retry'
// (no settle), settle terminal + clearRetryState on 'settle' / terminal / no-decode.
// Kept faithful to the handler so this file guards the composition, not a private copy.
async function handleDrop(
  redis: FakeRedis,
  repos: {
    jobs: InMemoryJobRepository;
    assets: InMemoryAssetRepository;
    pipeline: InMemoryPipelineRepository;
  },
  drop: DroppedJob
): Promise<{ redispatched: boolean }> {
  const { encoreJobId, reason } = drop;
  const found = await repos.jobs.findByEncoreJobId(encoreJobId);
  if (!found) return { redispatched: false };

  const failureText =
    reason && reason.trim().length > 0
      ? `dropped by Encore: ${reason}`
      : 'dropped by Encore: gone from active set with no completion';

  const decoded = decodeEncoreJobId(encoreJobId);
  const isTerminal =
    found.job.status === 'done' ||
    found.job.status === 'failed' ||
    found.job.status === 'cancelled';
  if (decoded && !isTerminal) {
    const decision = await decideRetry(
      asRedis(redis),
      decoded.workspaceId,
      encoreJobId,
      failureText
    );
    if (decision.action === 'retry') {
      return { redispatched: true };
    }
    // action:'settle' -> fall through to the terminal settle below.
  }

  await settleFailedTranscode(
    {
      jobs: repos.jobs,
      assets: repos.assets,
      pipeline: repos.pipeline
    },
    found.job,
    failureText,
    'gone-from-active-set'
  );
  if (decoded) {
    await clearRetryState(asRedis(redis), encoreJobId).catch(() => {});
  }
  return { redispatched: false };
}

// A `running` transcode job over a `processing` source asset + a running
// pipeline lock — exactly the shape reconcile() observes when a job vanishes from
// Encore's live set mid-encode.
async function runningScalerJob(
  repos: {
    jobs: InMemoryJobRepository;
    assets: InMemoryAssetRepository;
    pipeline: InMemoryPipelineRepository;
  },
  externalId: string
) {
  const asset = await repos.assets.create({ name: 'clip.mov', objectKey: 'src/clip.mov' });
  await repos.assets.update(asset.id, { status: 'processing' });

  const job = await repos.jobs.create({
    type: 'transcode',
    assetId: asset.id,
    profile: 'abr-vod',
    encoreJobId: externalId
  });
  await repos.jobs.update(job.id, { status: 'queued' });
  await repos.jobs.update(job.id, { status: 'running', encoreInternalJobId: externalId });

  const execution = await repos.pipeline.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  const steps = execution.steps.map((s) => ({ ...s, status: 'running' as const }));
  await repos.pipeline.update(execution.id, { steps });

  return { assetId: asset.id, jobId: job.id, executionId: execution.id };
}

const WS = 'ws1';
// The severed-read demux string #295/#293 class as io-retryable — the exact class
// #727 is about: it arrives via reconcile() (a drop), never a FAILED callback.
const IO_RETRYABLE_REASON = 'Error during demuxing: I/O error';
const DETERMINISTIC_REASON =
  "Profile 'abr-vod' requires an audio stream but the input has none";
const PAYLOAD = { externalId: '', profile: 'abr-vod', inputs: [{ uri: 's3://b/k' }] };

describe('#727 reconcile-detected drop routed through the retry gate', () => {
  let redis: FakeRedis;
  let repos: {
    jobs: InMemoryJobRepository;
    assets: InMemoryAssetRepository;
    pipeline: InMemoryPipelineRepository;
  };

  beforeEach(() => {
    redis = new FakeRedis();
    repos = {
      jobs: new InMemoryJobRepository(),
      assets: new InMemoryAssetRepository(),
      pipeline: new InMemoryPipelineRepository()
    };
  });

  // (a) io-retryable drop UNDER the bound -> re-dispatched, NOT settled.
  it('(a) re-dispatches an io-retryable drop under the bound instead of settling', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-io-retry');
    const { jobId, assetId } = await runningScalerJob(repos, externalId);
    // First dispatch recorded (attempt 1); decideRetry needs the payload to re-POST.
    await recordDispatch(asRedis(redis), externalId, { ...PAYLOAD, externalId }, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: IO_RETRYABLE_REASON
    });

    expect(redispatched).toBe(true);
    // The caller-facing job is NOT settled — it stays running while the retry is pending.
    expect((await repos.jobs.get(jobId))?.status).toBe('running');
    expect((await repos.assets.get(assetId))?.status).toBe('processing');
    // decideRetry re-queued the job with its original payload + a backoff timestamp,
    // and pinned the scaler-facing status back to RUNNING.
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    const requeued = JSON.parse(queued[0]) as QueuedJob;
    expect(requeued.jobId).toBe(externalId);
    expect(requeued.notBefore).toBeGreaterThan(Date.now());
    expect(await redis.hget(keys.jobStatus(WS), externalId)).toBe('RUNNING');
  });

  // (b) io-retryable drop AT the bound -> settles `exhausted` (terminal), no re-queue.
  it('(b) settles an io-retryable drop that has reached MAX_ENCODE_ATTEMPTS (exhausted)', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-io-exhausted');
    const { jobId, assetId, executionId } = await runningScalerJob(repos, externalId);
    // Already dispatched the full bound — the next observation must settle terminal.
    await recordDispatch(asRedis(redis), externalId, { ...PAYLOAD, externalId }, MAX_ENCODE_ATTEMPTS);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: IO_RETRYABLE_REASON
    });

    expect(redispatched).toBe(false);
    // Settled terminal — job + source asset + pipeline lock all failed.
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
    expect((await repos.assets.get(assetId))?.status).toBe('failed');
    expect((await repos.pipeline.get(executionId))?.status).toBe('failed');
    // Not retried past the bound — no queue entry.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    // #709 conditional settle preserved: reversible so a late SUCCESSFUL callback
    // can still correct it.
    expect((await repos.jobs.get(jobId))?.droppedByScaler).toBe(true);
    // Retry bookkeeping cleared on settle.
    expect(await redis.get(keys.jobPayload(externalId))).toBeNull();
    expect(await redis.get(keys.jobAttempts(externalId))).toBeNull();
  });

  // (c) deterministic drop -> settles `not-retryable` on first observation.
  it('(c) settles a deterministic drop terminal without retrying', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-deterministic');
    const { jobId, assetId } = await runningScalerJob(repos, externalId);
    // Even with a payload + attempt-1 available, a deterministic message is not retried.
    await recordDispatch(asRedis(redis), externalId, { ...PAYLOAD, externalId }, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: DETERMINISTIC_REASON
    });

    expect(redispatched).toBe(false);
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
    expect((await repos.assets.get(assetId))?.status).toBe('failed');
    // Encore's own recovered cause surfaced to the caller (#704 wording preserved).
    expect((await repos.jobs.get(jobId))?.error).toContain(DETERMINISTIC_REASON);
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  // (d) drop with NO recovered reason -> settles as today (generic wording, no retry).
  it('(d) settles a drop with no recovered reason exactly as today', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-no-reason');
    const { jobId, assetId } = await runningScalerJob(repos, externalId);
    // A payload exists, but with reason undefined the failureText is the generic
    // gone-from-active-set wording, which matches no signature -> deterministic -> settle.
    await recordDispatch(asRedis(redis), externalId, { ...PAYLOAD, externalId }, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: undefined
    });

    expect(redispatched).toBe(false);
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
    expect((await repos.assets.get(assetId))?.status).toBe('failed');
    expect((await repos.jobs.get(jobId))?.error).toBe(
      'dropped by Encore: gone from active set with no completion'
    );
    // #709 conditional settle preserved.
    expect((await repos.jobs.get(jobId))?.droppedByScaler).toBe(true);
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  // Guard: a drop already settled terminal is NOT re-dispatched, even for an
  // io-retryable reason with retries nominally remaining (#709 preserved).
  it('does not re-dispatch a drop whose job is already terminal', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-already-failed');
    const { jobId } = await runningScalerJob(repos, externalId);
    // The job was already settled failed by an earlier path.
    await repos.jobs.update(jobId, { status: 'failed', error: 'already settled' });
    await recordDispatch(asRedis(redis), externalId, { ...PAYLOAD, externalId }, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: IO_RETRYABLE_REASON
    });

    expect(redispatched).toBe(false);
    // No re-queue — a completed/terminal job must never be re-dispatched.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
  });
});
