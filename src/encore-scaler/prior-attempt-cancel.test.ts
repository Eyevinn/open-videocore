// Prior-attempt cancellation before re-dispatch (issue #745).
//
// #745: a re-dispatch (a #295 transport/IO retry via decideRetry, or a #514
// scale-down re-enqueue via requeueInterruptedByScaleDown) can submit the same
// externalId while the PREVIOUS attempt is still IN_PROGRESS on another Encore
// instance — producing concurrent encodes writing the same output (live
// evidence: one externalId IN_PROGRESS on three instances at once). Both
// re-dispatch paths now cancel the prior attempt FIRST, using the full Encore
// job URL recorded at dispatch time (keys.jobEncoreUrl), BEFORE that key is
// deleted by the re-queue path.
//
// This file asserts the acceptance criteria the reviewer flagged as untested:
//   (a) decideRetry 'retry' branch invokes the PriorAttemptCanceler with the
//       recorded keys.jobEncoreUrl(jobId) value BEFORE that key is deleted.
//   (b) requeueInterruptedByScaleDown does the same before deleting the key.
//   (c) a 'settle' decision NEVER invokes the canceler (no re-dispatch).
//   (d) a rejected/failed canceler does NOT block the re-dispatch (best-effort).
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - PriorAttemptCanceler = (encoreJobUrl: string) => Promise<void>, threaded
//     through decideRetry / requeueInterruptedByScaleDown as an optional final
//     arg — src/encore-scaler/retry-store.ts:57, 163, 232.
//   - cancelPriorActiveAttempt reads keys.jobEncoreUrl(jobId) then calls
//     cancelPrior(priorUrl), swallowing failures — retry-store.ts:89-112.
//   - decideRetry 'retry' branch: cancel at retry-store.ts:284 runs BEFORE the
//     keys.jobEncoreUrl deletion at retry-store.ts:301-304.
//   - requeueInterruptedByScaleDown: cancel at retry-store.ts:191 runs BEFORE the
//     keys.jobEncoreUrl deletion at retry-store.ts:198.
//   - keys.jobEncoreUrl = `encore:job-url:${encoreJobId}` — src/encore-scaler/
//     types.ts:223. QueuedJob shape — types.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

import {
  decideRetry,
  recordDispatch,
  requeueInterruptedByScaleDown,
  type PriorAttemptCanceler
} from './retry-store.js';
import { keys, type QueuedJob } from './types.js';

// Minimal in-memory Valkey fake covering exactly the commands decideRetry /
// recordDispatch / requeueInterruptedByScaleDown touch. Mirrors the fake in
// retry-policy.test.ts, plus an `ops` log capturing every del so the test can
// assert the cancel happens BEFORE the jobEncoreUrl key is deleted.
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  // Ordered log of mutating ops (del of each key + an explicit 'cancel' marker
  // the stubbed canceler pushes) so ordering is assertable.
  ops: string[] = [];

  async set(key: string, val: string): Promise<'OK'> {
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  async del(...args: string[]): Promise<number> {
    let n = 0;
    for (const k of args) {
      this.ops.push(`del:${k}`);
      if (this.strings.delete(k)) n++;
    }
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

const WS = 'ws1';
const EXTERNAL_ID = `${WS}__job-abc`;
const PAYLOAD = { externalId: EXTERNAL_ID, profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] };

// The full per-instance Encore job URL recorded at dispatch time. cancel POSTs
// `{this}/cancel` (encore-client.ts contract); the canceler must receive it verbatim.
const PRIOR_URL = 'https://encore-inst-7.example/encoreJobs/11111111-2222-3333-4444-555555555555';
const ENCORE_URL_KEY = keys.jobEncoreUrl(EXTERNAL_ID);

const TRANSPORT_MSG =
  'SdkClientException: Acquire operation took longer than the configured maximum time';
const DETERMINISTIC_MSG = 'Unknown profile: nope';

describe('#745 cancel the still-active prior Encore attempt before re-dispatch', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  // (a) decideRetry 'retry' branch cancels the prior attempt with the recorded
  //     keys.jobEncoreUrl value, BEFORE that key is deleted.
  it('(a) decideRetry retry branch cancels the recorded prior URL before deleting the key', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    // The prior dispatch recorded its full Encore job URL.
    await redis.set(ENCORE_URL_KEY, PRIOR_URL);

    // At cancel time the jobEncoreUrl key must still exist (cancel reads it and
    // must run before the delete). Capture that snapshot.
    let urlPresentAtCancel: boolean | undefined;
    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => {
      urlPresentAtCancel = redis.strings.has(ENCORE_URL_KEY);
      redis.ops.push('cancel');
    });

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG, cancelPrior);

    expect(decision.action).toBe('retry');
    // Invoked exactly once, with the recorded keys.jobEncoreUrl value.
    expect(cancelPrior).toHaveBeenCalledTimes(1);
    expect(cancelPrior).toHaveBeenCalledWith(PRIOR_URL);
    // Ordering: cancel ran while the key still existed, and BEFORE its deletion.
    expect(urlPresentAtCancel).toBe(true);
    const cancelIdx = redis.ops.indexOf('cancel');
    const delIdx = redis.ops.indexOf(`del:${ENCORE_URL_KEY}`);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(cancelIdx);
    // And the key really was deleted by the re-dispatch path.
    expect(await redis.get(ENCORE_URL_KEY)).toBeNull();
    // The job was still re-queued.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
  });

  // (b) requeueInterruptedByScaleDown cancels the prior attempt with the recorded
  //     keys.jobEncoreUrl value, BEFORE that key is deleted.
  it('(b) requeueInterruptedByScaleDown cancels the recorded prior URL before deleting the key', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    await redis.hset(keys.jobInstance(WS), EXTERNAL_ID, 'inst-gone');
    await redis.hset(keys.jobStatus(WS), EXTERNAL_ID, 'running');
    await redis.set(ENCORE_URL_KEY, PRIOR_URL);

    let urlPresentAtCancel: boolean | undefined;
    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => {
      urlPresentAtCancel = redis.strings.has(ENCORE_URL_KEY);
      redis.ops.push('cancel');
    });

    const ok = await requeueInterruptedByScaleDown(asRedis(redis), WS, EXTERNAL_ID, cancelPrior);

    expect(ok).toBe(true);
    expect(cancelPrior).toHaveBeenCalledTimes(1);
    expect(cancelPrior).toHaveBeenCalledWith(PRIOR_URL);
    expect(urlPresentAtCancel).toBe(true);
    const cancelIdx = redis.ops.indexOf('cancel');
    const delIdx = redis.ops.indexOf(`del:${ENCORE_URL_KEY}`);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(cancelIdx);
    expect(await redis.get(ENCORE_URL_KEY)).toBeNull();
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
  });

  // (c) a 'settle' decision NEVER invokes the canceler (nothing is re-dispatched,
  //     so the prior attempt — if terminal — must not be touched).
  it('(c) a settle decision never invokes the canceler', async () => {
    // Deterministic message under the bound: decideRetry settles 'not-retryable'.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    await redis.set(ENCORE_URL_KEY, PRIOR_URL);

    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => undefined);

    const decision = await decideRetry(
      asRedis(redis),
      WS,
      EXTERNAL_ID,
      DETERMINISTIC_MSG,
      cancelPrior
    );

    expect(decision.action).toBe('settle');
    // No re-dispatch -> the canceler is never consulted.
    expect(cancelPrior).not.toHaveBeenCalled();
    // Not re-queued, and the settle path leaves the URL key untouched here.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  // (d) a rejected/failed canceler does NOT block the re-dispatch (best-effort):
  //     the job is still re-queued and the stale URL key still deleted.
  it('(d) a rejected canceler does not block re-dispatch (best-effort)', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    await redis.set(ENCORE_URL_KEY, PRIOR_URL);

    // The prior-attempt cancel POST fails (e.g. 500 / network) — must be swallowed.
    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => {
      throw new Error('Encore prior-attempt cancellation failed: 500');
    });
    // Suppress the expected best-effort warning so the suite output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG, cancelPrior);

    expect(cancelPrior).toHaveBeenCalledTimes(1);
    expect(cancelPrior).toHaveBeenCalledWith(PRIOR_URL);
    // The rejection did NOT abort the re-dispatch.
    expect(decision.action).toBe('retry');
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    expect((JSON.parse(queued[0]) as QueuedJob).jobId).toBe(EXTERNAL_ID);
    expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('RUNNING');
    // The stale prior-attempt URL key was still deleted after the failed cancel.
    expect(await redis.get(ENCORE_URL_KEY)).toBeNull();

    warnSpy.mockRestore();
  });

  // Best-effort, same semantics on the scale-down path: a rejected canceler must
  // not block requeueInterruptedByScaleDown either.
  it('(d) a rejected canceler does not block requeueInterruptedByScaleDown', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    await redis.hset(keys.jobStatus(WS), EXTERNAL_ID, 'running');
    await redis.set(ENCORE_URL_KEY, PRIOR_URL);

    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => {
      throw new Error('boom');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const ok = await requeueInterruptedByScaleDown(asRedis(redis), WS, EXTERNAL_ID, cancelPrior);

    expect(ok).toBe(true);
    expect(cancelPrior).toHaveBeenCalledTimes(1);
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
    expect(await redis.get(ENCORE_URL_KEY)).toBeNull();

    warnSpy.mockRestore();
  });

  // Guard: with NO recorded prior URL there is nothing to cancel — the canceler
  // is not invoked, but the re-dispatch still proceeds (cancelPriorActiveAttempt
  // early-returns on a missing key, retry-store.ts:101).
  it('does not invoke the canceler when no prior URL was recorded, but still re-dispatches', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    // No keys.jobEncoreUrl set.
    const cancelPrior: PriorAttemptCanceler = vi.fn(async () => undefined);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG, cancelPrior);

    expect(cancelPrior).not.toHaveBeenCalled();
    expect(decision.action).toBe('retry');
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
  });
});
