// Durable encode-attempt persistence (ADR-012, #380).
//
// #380 makes encode-attempt history outlive the TTL'd Valkey retry key
// (encore:job-attempts:{id}). These tests exercise the durable WRITE/read-back
// path on the JobRepository: appending an attempt, reading it back after
// simulating the Valkey key being cleared, and the never-retried baseline
// (one dispatch => encodeAttempts 1 / one log entry).
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - JobRepository.appendEncodeAttempt(id, { index?, startedAt?, endedAt?,
//     classification? }) => Promise<Job | undefined>  (src/data/job-repo.ts)
//   - Job.encodeAttempts?: number; Job.encodeAttemptLog?: EncodeAttempt[]
//     (src/data/job-repo.ts) where EncodeAttempt = { index; startedAt;
//     endedAt?; classification? }.
//   - FailureClass = 'transport' | 'io-retryable' | 'deterministic'
//     (src/encore-scaler/retry-policy.ts:70), reused not redefined.

import { describe, it, expect } from 'vitest';

import { InMemoryJobRepository } from './job-repo.js';

describe('durable encode-attempt persistence (#380)', () => {
  it('persists a single attempt on first dispatch (never-retried baseline)', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    // A never-retried job is dispatched exactly once => attempt 1.
    const updated = await repo.appendEncodeAttempt(job.id, { index: 1 });

    expect(updated).toBeDefined();
    expect(updated!.encodeAttempts).toBe(1);
    expect(updated!.encodeAttemptLog).toHaveLength(1);
    expect(updated!.encodeAttemptLog![0]).toMatchObject({ index: 1 });
    expect(typeof updated!.encodeAttemptLog![0].startedAt).toBe('string');
    // endedAt/classification are populated on completion (#381), not at dispatch.
    expect(updated!.encodeAttemptLog![0].endedAt).toBeUndefined();
    expect(updated!.encodeAttemptLog![0].classification).toBeUndefined();

    // The ingest/URL-pull attempts counter is UNCHANGED (kept separate).
    expect(updated!.attempts).toBe(0);
  });

  it('appends re-dispatches and remains readable after the Valkey TTL is simulated as cleared', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    // Simulated Valkey retry counter (encore:job-attempts:{id}), TTL'd/cleared
    // independently of the durable record.
    const valkeyAttempts = new Map<string, number>();

    // Dispatch 1 + two transport-class re-dispatches. Each dispatch writes the
    // Valkey counter AND appends to the durable log.
    for (const attempt of [1, 2, 3]) {
      valkeyAttempts.set(job.id, attempt);
      await repo.appendEncodeAttempt(job.id, { index: attempt });
    }

    // The TTL elapses / re-dispatch clears the Valkey key.
    valkeyAttempts.delete(job.id);
    expect(valkeyAttempts.has(job.id)).toBe(false);

    // The durable record still has the full attempt history.
    const after = await repo.get(job.id);
    expect(after!.encodeAttempts).toBe(3);
    expect(after!.encodeAttemptLog!.map((a) => a.index)).toEqual([1, 2, 3]);
  });

  it('preserves prior attempts when a later dispatch enriches classification', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    await repo.appendEncodeAttempt(job.id, { index: 1 });
    // A completion enrichment (#381 shape) may carry classification/endedAt.
    const enriched = await repo.appendEncodeAttempt(job.id, {
      index: 2,
      classification: 'transport',
      endedAt: new Date().toISOString()
    });

    expect(enriched!.encodeAttempts).toBe(2);
    expect(enriched!.encodeAttemptLog![1].classification).toBe('transport');
    expect(enriched!.encodeAttemptLog![1].endedAt).toBeDefined();
  });

  it('returns undefined for an unknown job id', async () => {
    const repo = new InMemoryJobRepository();
    const result = await repo.appendEncodeAttempt('nope', { index: 1 });
    expect(result).toBeUndefined();
  });

  it('defaults index to the next log position when omitted', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    await repo.appendEncodeAttempt(job.id, {});
    const second = await repo.appendEncodeAttempt(job.id, {});

    expect(second!.encodeAttemptLog!.map((a) => a.index)).toEqual([1, 2]);
    expect(second!.encodeAttempts).toBe(2);
  });
});
