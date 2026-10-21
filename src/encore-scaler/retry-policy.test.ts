// Contract/integration tests for the #295 transport-class retry mechanism.
//
// Two layers:
//  1. classifyEncoreFailure — the transport-vs-input classification rule.
//  2. decideRetry — the re-dispatch gate over a minimal in-memory Valkey fake,
//     asserting: transport-class failure -> re-dispatched (job stays running);
//     success-on-retry equivalent (re-queued payload preserved, not settled);
//     bad-input beyond the bound -> settles clearly; non-transport
//     deterministic failure -> not retried.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  classifyEncoreFailure,
  isRetryableFailureClass,
  isScaleDownInterruption,
  backoffForAttempt,
  MAX_ENCODE_ATTEMPTS,
  BACKOFF_MS
} from './retry-policy.js';
import {
  decideRetry,
  recordDispatch,
  requeueInterruptedByScaleDown
} from './retry-store.js';
import { keys, type QueuedJob } from './types.js';

// ---------------------------------------------------------------------------
// Layer 1: classification rule
// ---------------------------------------------------------------------------

describe('classifyEncoreFailure (#295 transport-vs-input rule)', () => {
  it('classifies S3 SdkClientException pool-acquire timeout (write, #292) as transport', () => {
    const msg =
      'software.amazon.awssdk.core.exception.SdkClientException: Unable to execute HTTP request: ' +
      'Acquire operation took longer than the configured maximum time. This indicates that a ' +
      'request cannot get a connection from the pool within the specified maximum time.';
    expect(classifyEncoreFailure(msg)).toBe('transport');
    expect(isRetryableFailureClass(classifyEncoreFailure(msg))).toBe(true);
  });

  it('classifies a severed read stream (demux I/O error, #293) as io-retryable', () => {
    // #293: this SAME string appeared on a byte-for-byte INTACT source, so it
    // must be retryable, not treated as bad input.
    const msg = 'Error during demuxing: I/O error';
    expect(classifyEncoreFailure(msg)).toBe('io-retryable');
    expect(isRetryableFailureClass(classifyEncoreFailure(msg))).toBe(true);
  });

  it('classifies "Stream ends prematurely" / corrupt-packet / NAL as io-retryable (bounded)', () => {
    // Per #293 these appear on both transport-severed reads AND genuinely corrupt
    // sources; classification cannot distinguish, so they are retryable up to the
    // bound (a truly corrupt source exhausts the bound and then fails clearly).
    expect(classifyEncoreFailure('Stream ends prematurely')).toBe('io-retryable');
    expect(classifyEncoreFailure('corrupt input packet in stream 0')).toBe('io-retryable');
    expect(classifyEncoreFailure('Invalid NAL unit size (-1)')).toBe('io-retryable');
  });

  it('classifies a deterministic profile/validation failure as deterministic (not retried)', () => {
    const msg =
      "Profile 'program-x265' requires an audio stream but the input has none (AudioEncode is not optional)";
    expect(classifyEncoreFailure(msg)).toBe('deterministic');
    expect(isRetryableFailureClass(classifyEncoreFailure(msg))).toBe(false);
  });

  it('treats an absent/empty message as deterministic (no transport evidence)', () => {
    expect(classifyEncoreFailure(undefined)).toBe('deterministic');
    expect(classifyEncoreFailure('')).toBe('deterministic');
  });

  it('backoff table is bounded and clamps beyond its length', () => {
    expect(backoffForAttempt(1)).toBe(BACKOFF_MS[0]);
    expect(backoffForAttempt(2)).toBe(BACKOFF_MS[1]);
    expect(backoffForAttempt(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Layer 1b: scale-down interruption is a DISTINCT, recoverable class (#514)
// ---------------------------------------------------------------------------

describe('interrupted_by_scaledown classification (#514)', () => {
  it('is a distinct, clearly-recoverable failure class', () => {
    expect(isRetryableFailureClass('interrupted_by_scaledown')).toBe(true);
    expect(isScaleDownInterruption('interrupted_by_scaledown')).toBe(true);
  });

  it('is distinct from transport / io-retryable / deterministic', () => {
    expect(isScaleDownInterruption('transport')).toBe(false);
    expect(isScaleDownInterruption('io-retryable')).toBe(false);
    expect(isScaleDownInterruption('deterministic')).toBe(false);
  });

  it('is NEVER inferred from a failure message — a deterministic message stays deterministic', () => {
    // The whole point of #514: scale-down interruption is a topology event, not a
    // message signature. classifyEncoreFailure only returns message-derived
    // classes, so a genuine deterministic (or transport/IO) failure message can
    // never be reclassified as scale-down interruption.
    const deterministicMsg =
      "Profile 'program-x265' requires an audio stream but the input has none";
    expect(classifyEncoreFailure(deterministicMsg)).toBe('deterministic');
    expect(classifyEncoreFailure(deterministicMsg)).not.toBe('interrupted_by_scaledown');

    // Even messages that *mention* scaling/draining words are not reclassified —
    // the class is structural, not lexical.
    expect(classifyEncoreFailure('instance drained during scale down')).toBe('deterministic');
    expect(classifyEncoreFailure(undefined)).not.toBe('interrupted_by_scaledown');
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Valkey fake — only the commands decideRetry/recordDispatch
// use. Mirrors ioredis semantics for those commands (strings, hashes, lists).
// ---------------------------------------------------------------------------

class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();

  async set(key: string, val: string): Promise<'OK'> {
    // Extra EX/seconds args are accepted and ignored by the fake.
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
  // The router/submit path uses LPUSH to the queue tail; the loop RPOPLPUSHes.
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
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  // ioredis RPOPLPUSH: atomically pop the tail of `src` and LPUSH it to the head
  // of `dst`, returning the moved element (null when `src` is empty). Head is
  // index 0 here (lpush unshifts), so the tail is the last element.
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const s = this.lists.get(src) ?? [];
    const val = s.pop();
    this.lists.set(src, s);
    if (val === undefined) return null;
    const d = this.lists.get(dst) ?? [];
    d.unshift(val);
    this.lists.set(dst, d);
    return val;
  }
  // ioredis LREM with count > 0 removes up to `count` matching elements scanning
  // from head to tail. The scaler loop always calls it as `lrem(list, 1, val)`.
  async lrem(key: string, count: number, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    let removed = 0;
    const out: string[] = [];
    for (const item of l) {
      if (item === val && (count === 0 || removed < count)) {
        removed++;
        continue;
      }
      out.push(item);
    }
    this.lists.set(key, out);
    return removed;
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

// externalId must decode to a workspaceId via decodeEncoreJobId (the {ws}__{id}
// shape). recordDispatch/decideRetry key off the raw externalId.
const WS = 'ws1';
const EXTERNAL_ID = `${WS}__job-abc`;
const PAYLOAD = { externalId: EXTERNAL_ID, profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] };

const TRANSPORT_MSG =
  'SdkClientException: Acquire operation took longer than the configured maximum time';
const DEMUX_MSG = 'Error during demuxing: I/O error';
const DETERMINISTIC_MSG = 'Unknown profile: nope';

describe('decideRetry (#295 re-dispatch gate)', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('transport-class failure on attempt 1 -> re-dispatches and keeps job running', async () => {
    // First dispatch recorded (attempt 1).
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);

    expect(decision.action).toBe('retry');
    if (decision.action !== 'retry') throw new Error('unreachable');
    expect(decision.failureClass).toBe('transport');
    expect(decision.attempt).toBe(2);

    // Caller-facing status pinned to RUNNING (NOT settled to failed) so the
    // caller never sees a hung/settled job while the retry is pending.
    expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('RUNNING');

    // The job was re-queued with its ORIGINAL payload and a backoff timestamp.
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    const requeued = JSON.parse(queued[0]) as QueuedJob;
    expect(requeued.jobId).toBe(EXTERNAL_ID);
    expect(requeued.payload).toEqual(PAYLOAD);
    expect(requeued.attempts).toBe(1); // prior attempt count carried
    expect(requeued.notBefore).toBeGreaterThan(Date.now());

    // Stale per-attempt mappings cleared so the callback poller resolves the
    // fresh dispatch, not the dead one.
    expect(await redis.hget(keys.jobInstance(WS), EXTERNAL_ID)).toBeNull();
    expect(await redis.get(keys.jobUuid(EXTERNAL_ID))).toBeNull();
  });

  it('io-retryable (severed read on intact source, #293) also re-dispatches', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, DEMUX_MSG);
    expect(decision.action).toBe('retry');
    if (decision.action !== 'retry') throw new Error('unreachable');
    expect(decision.failureClass).toBe('io-retryable');
  });

  it('bad-input beyond the bound -> settles clearly (not retried forever)', async () => {
    // Simulate a source that keeps producing the same demux error: it has already
    // been dispatched MAX_ENCODE_ATTEMPTS times.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, MAX_ENCODE_ATTEMPTS);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, DEMUX_MSG);
    expect(decision.action).toBe('settle');
    if (decision.action !== 'settle') throw new Error('unreachable');
    expect(decision.reason).toBe('exhausted');

    // No new queue entry — the job is NOT retried past the bound.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  it('non-transport deterministic failure -> not retried, settles immediately', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, DETERMINISTIC_MSG);
    expect(decision.action).toBe('settle');
    if (decision.action !== 'settle') throw new Error('unreachable');
    expect(decision.reason).toBe('not-retryable');
    expect(decision.failureClass).toBe('deterministic');
    // Not re-queued.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  // Simulate the scaler loop draining the re-queued entry off keys.queue and
  // dispatching it — RPOPLPUSH queue->inflight then LREM inflight once the POST
  // lands — exactly as scaler-loop.ts:253-283 does. After this the entry has left
  // BOTH lists, which is precisely why the #743 idempotency guard does NOT trip on
  // the next genuine failure signal in production: a real Encore failure only
  // arrives AFTER the retry has been dispatched and drained. The lifecycle test
  // must model that drain, otherwise the queued-but-not-yet-dispatched entry makes
  // the guard (correctly) report `already-pending` and short-circuit the retry.
  async function drainDispatch(): Promise<void> {
    const claimed = await redis.rpoplpush(keys.queue(WS), keys.inflight(WS));
    if (claimed === null) throw new Error('expected a queued retry entry to drain');
    await redis.lrem(keys.inflight(WS), 1, claimed);
  }

  it('full bounded lifecycle: retries up to the bound then fails clearly', async () => {
    // Attempt 1 dispatched.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);

    // Failure 1 (attempt 1) -> retry (schedules attempt 2).
    let d = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(d.action).toBe('retry');
    // The loop drains the re-queued entry off the queue and dispatches it as
    // attempt 2 — mirroring real dispatch flow, so the next failure signal sees
    // an EMPTY queue (guard does not trip) rather than the stale queued entry.
    await drainDispatch();
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 2);

    // Failure 2 (attempt 2) -> retry (schedules attempt 3, the last allowed).
    d = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(d.action).toBe('retry');
    await drainDispatch();
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 3);

    // Failure 3 (attempt 3 == MAX) -> settle exhausted, fail clearly.
    d = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(d.action).toBe('settle');
    if (d.action !== 'settle') throw new Error('unreachable');
    expect(d.reason).toBe('exhausted');
  });

  it('missing original payload (e.g. pre-#295 job / expired TTL) -> settles rather than looping', async () => {
    // attempts recorded but payload absent.
    await redis.set(keys.jobAttempts(EXTERNAL_ID), '1');
    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(decision.action).toBe('settle');
    if (decision.action !== 'settle') throw new Error('unreachable');
    expect(decision.reason).toBe('not-retryable');
  });

  // -------------------------------------------------------------------------
  // #743 acceptance criterion: "a retry with an entry already queued produces
  // no additional queue entry." decideRetry must be idempotent — a duplicate
  // failure signal for a job whose retry is already queued (or mid-dispatch,
  // hence inflight) must be a no-op, NOT a second LPUSH. The guard is
  // hasQueuedOrInflightEntry (retry-store.ts:52-70), consulted before every
  // state mutation (retry-store.ts:231-233).
  // -------------------------------------------------------------------------

  function queuedEntry(): string {
    const entry: QueuedJob = {
      jobId: EXTERNAL_ID,
      payload: PAYLOAD,
      enqueuedAt: Date.now(),
      notBefore: Date.now() + 60_000,
      attempts: 1
    };
    return JSON.stringify(entry);
  }

  it('#743: entry already in keys.queue -> skip/already-pending, no duplicate LPUSH', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    // A retry for this job is already sitting in the pending queue.
    await redis.lpush(keys.queue(WS), queuedEntry());
    const before = await redis.llen(keys.queue(WS));
    expect(before).toBe(1);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') throw new Error('unreachable');
    expect(decision.reason).toBe('already-pending');
    expect(decision.failureClass).toBe('transport');

    // The queue length is UNCHANGED — no second entry was pushed (the exact bug
    // #743 fixes: one execution accumulating far more than MAX_ENCODE_ATTEMPTS).
    expect(await redis.llen(keys.queue(WS))).toBe(before);
  });

  it('#743: entry already in keys.inflight (mid-dispatch) -> skip/already-pending, queue untouched', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    // The retry has been claimed by the loop and is transiently on the inflight
    // list (RPOPLPUSH'd, not yet LREM'd) — still counts as pending.
    await redis.lpush(keys.inflight(WS), queuedEntry());
    expect(await redis.llen(keys.queue(WS))).toBe(0);

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') throw new Error('unreachable');
    expect(decision.reason).toBe('already-pending');

    // No entry was LPUSHed onto the queue for the duplicate signal.
    expect(await redis.llen(keys.queue(WS))).toBe(0);
  });

  it('#743: an unparseable queue entry is ignored by the guard -> retry still dispatches', async () => {
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    // A non-JSON entry (or one for a different job) must NOT be mistaken for this
    // job's pending retry — hasQueuedOrInflightEntry's catch branch (retry-store.ts:65-67)
    // swallows the parse error and keeps scanning, so the guard does not trip.
    await redis.lpush(keys.queue(WS), 'not-json{');
    await redis.lpush(keys.queue(WS), JSON.stringify({ jobId: `${WS}__other`, payload: {} }));

    const decision = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(decision.action).toBe('retry');
    if (decision.action !== 'retry') throw new Error('unreachable');
    expect(decision.attempt).toBe(2);

    // The guard did not match the junk entries, so a genuine retry WAS enqueued:
    // the two seeded entries plus the new one.
    expect(await redis.llen(keys.queue(WS))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// requeueInterruptedByScaleDown (#514): a scale-down interruption is re-queued
// as clearly-recoverable work, NOT surfaced as a generic failure.
// ---------------------------------------------------------------------------

describe('requeueInterruptedByScaleDown (#514 re-enqueue)', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('re-enqueues the interrupted job with its original payload and keeps it running', async () => {
    // The job was dispatched (attempt 1) then its worker was scaled away.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);
    await redis.hset(keys.jobInstance(WS), EXTERNAL_ID, 'inst-gone');
    await redis.hset(keys.jobStatus(WS), EXTERNAL_ID, 'running');

    const ok = await requeueInterruptedByScaleDown(asRedis(redis), WS, EXTERNAL_ID);
    expect(ok).toBe(true);

    // Re-queued with the ORIGINAL payload; NO backoff (interrupted, not failing);
    // the prior attempt count is carried unchanged (a scale-down is not a failed
    // attempt, so it must not advance toward the bound).
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    const requeued = JSON.parse(queued[0]) as QueuedJob;
    expect(requeued.jobId).toBe(EXTERNAL_ID);
    expect(requeued.payload).toEqual(PAYLOAD);
    expect(requeued.attempts).toBe(1);
    expect(requeued.notBefore).toBeUndefined();

    // Caller-facing status pinned RUNNING (never observed as failed), and the
    // stale mapping to the scaled-away instance is dropped.
    expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('RUNNING');
    expect(await redis.hget(keys.jobInstance(WS), EXTERNAL_ID)).toBeNull();
  });

  it('returns false and does not re-queue when the original payload is unavailable', async () => {
    // No recordDispatch: payload key absent (e.g. TTL expired).
    await redis.hset(keys.jobStatus(WS), EXTERNAL_ID, 'running');
    const ok = await requeueInterruptedByScaleDown(asRedis(redis), WS, EXTERNAL_ID);
    expect(ok).toBe(false);
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });
});
