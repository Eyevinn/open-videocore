// Durable encode-attempt COMPLETION capture (ADR-012, #381).
//
// #380 appends an attempt (index + startedAt) at DISPATCH time via the scaler's
// onEncodeDispatched hook. #381 is the COMPLETION side driven by the callback
// poller (src/pipeline/encore-callback-poller.ts): when an attempt ends it
// stamps that same attempt's `endedAt` (always) and, for a FAILED attempt, its
// retry-policy `classification` — enriching the CURRENT attempt in place rather
// than appending a new one. These tests exercise the durable write/read-back
// path (JobRepository.completeEncodeAttempt) driven through the exact
// dispatch -> complete interleaving the poller produces.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - JobRepository.appendEncodeAttempt(id, { index?, startedAt? }) — dispatch
//     side (#380), src/data/job-repo.ts.
//   - JobRepository.completeEncodeAttempt(id, { endedAt?, classification? })
//     => Promise<Job | undefined> — completion side (#381), src/data/job-repo.ts.
//   - EncodeAttempt = { index; startedAt; endedAt?; classification? }
//     (src/data/job-repo.ts).
//   - FailureClass = 'transport' | 'io-retryable' | 'deterministic'
//     (src/encore-scaler/retry-policy.ts:70), reused not redefined.

import { describe, it, expect } from 'vitest';

import { InMemoryJobRepository } from './job-repo.js';

// The distinct ISO timestamps a real run would produce, in order. Using fixed
// strings makes the "distinct start/end pairs" assertions exact rather than
// timing-dependent.
const T = {
  dispatch1: '2026-08-22T10:00:00.000Z',
  end1: '2026-08-22T10:01:00.000Z',
  dispatch2: '2026-08-22T10:02:00.000Z',
  end2: '2026-08-22T10:03:00.000Z',
  dispatch3: '2026-08-22T10:04:00.000Z',
  end3: '2026-08-22T10:05:00.000Z'
} as const;

describe('durable encode-attempt completion capture (#381)', () => {
  it('a job that retried twice records three attempts with distinct start/end pairs and per-attempt classification', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    // --- Attempt 1: dispatched (#380 onEncodeDispatched), then FAILS transport.
    await repo.appendEncodeAttempt(job.id, { index: 1, startedAt: T.dispatch1 });
    // Poller decide path: transport-class failure re-dispatches -> close attempt.
    await repo.completeEncodeAttempt(job.id, { endedAt: T.end1, classification: 'transport' });

    // --- Attempt 2: re-dispatched, then FAILS io-retryable.
    await repo.appendEncodeAttempt(job.id, { index: 2, startedAt: T.dispatch2 });
    await repo.completeEncodeAttempt(job.id, { endedAt: T.end2, classification: 'io-retryable' });

    // --- Attempt 3: re-dispatched, then SUCCEEDS (no classification).
    await repo.appendEncodeAttempt(job.id, { index: 3, startedAt: T.dispatch3 });
    const final = await repo.completeEncodeAttempt(job.id, { endedAt: T.end3 });

    expect(final).toBeDefined();
    // Three attempts recorded (dispatch + two re-dispatches).
    expect(final!.encodeAttempts).toBe(3);
    const log = final!.encodeAttemptLog!;
    expect(log).toHaveLength(3);

    // Distinct start/end pairs per attempt.
    expect(log[0]).toMatchObject({ index: 1, startedAt: T.dispatch1, endedAt: T.end1 });
    expect(log[1]).toMatchObject({ index: 2, startedAt: T.dispatch2, endedAt: T.end2 });
    expect(log[2]).toMatchObject({ index: 3, startedAt: T.dispatch3, endedAt: T.end3 });

    // Per-attempt classification on the FAILED attempts only.
    expect(log[0].classification).toBe('transport');
    expect(log[1].classification).toBe('io-retryable');
    // The successful final attempt carries no failure class.
    expect(log[2].classification).toBeUndefined();

    // Completion enriched in place — every attempt has both timestamps set, and
    // no phantom/extra attempts were appended.
    expect(log.every((a) => typeof a.startedAt === 'string' && typeof a.endedAt === 'string')).toBe(true);

    // Elapsed time attributable to the successful attempt alone is derivable.
    const successElapsedMs =
      Date.parse(log[2].endedAt!) - Date.parse(log[2].startedAt);
    expect(successElapsedMs).toBe(60_000);
  });

  it('a job that never retried records exactly one attempt with both timestamps set (encodeAttempts === 1)', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    // Single dispatch (#380), then terminal SUCCESS closes the same attempt (#381).
    await repo.appendEncodeAttempt(job.id, { index: 1, startedAt: T.dispatch1 });
    const done = await repo.completeEncodeAttempt(job.id, { endedAt: T.end1 });

    expect(done!.encodeAttempts).toBe(1);
    expect(done!.encodeAttemptLog).toHaveLength(1);
    const only = done!.encodeAttemptLog![0];
    expect(only).toMatchObject({ index: 1, startedAt: T.dispatch1, endedAt: T.end1 });
    // A successful never-retried attempt has no failure class.
    expect(only.classification).toBeUndefined();
    // The field has a single reading and is never 0.
    expect(done!.encodeAttempts).not.toBe(0);
    // Elapsed time is derivable from the single timing pair.
    expect(Date.parse(only.endedAt!) - Date.parse(only.startedAt)).toBe(60_000);
  });

  it('synthesises a single attempt if completion runs with no dispatch attempt recorded (never 0)', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    // No appendEncodeAttempt was called (dispatch append lost); completion still
    // must leave exactly one attempt so the field is never 0.
    const done = await repo.completeEncodeAttempt(job.id, { endedAt: T.end1, classification: 'deterministic' });

    expect(done!.encodeAttempts).toBe(1);
    expect(done!.encodeAttemptLog).toHaveLength(1);
    const only = done!.encodeAttemptLog![0];
    expect(only.endedAt).toBe(T.end1);
    // start == end when synthesised, so elapsed is derivable (0) rather than absent.
    expect(only.startedAt).toBe(T.end1);
    expect(only.classification).toBe('deterministic');
  });

  it('a failed terminal settle stamps the last attempt classification (exhausted retries)', async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.create({ type: 'transcode', assetId: 'asset-1' });

    await repo.appendEncodeAttempt(job.id, { index: 1, startedAt: T.dispatch1 });
    const settled = await repo.completeEncodeAttempt(job.id, {
      endedAt: T.end1,
      classification: 'transport'
    });

    expect(settled!.encodeAttempts).toBe(1);
    expect(settled!.encodeAttemptLog![0].classification).toBe('transport');
    expect(settled!.encodeAttemptLog![0].endedAt).toBe(T.end1);
  });

  it('returns undefined for an unknown job id', async () => {
    const repo = new InMemoryJobRepository();
    const result = await repo.completeEncodeAttempt('nope', { endedAt: T.end1 });
    expect(result).toBeUndefined();
  });
});
