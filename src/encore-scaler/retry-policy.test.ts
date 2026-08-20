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
  backoffForAttempt,
  MAX_ENCODE_ATTEMPTS,
  BACKOFF_MS
} from './retry-policy.js';
import { decideRetry, recordDispatch } from './retry-store.js';
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

  it('full bounded lifecycle: retries up to the bound then fails clearly', async () => {
    // Attempt 1 dispatched.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 1);

    // Failure 1 (attempt 1) -> retry (schedules attempt 2).
    let d = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(d.action).toBe('retry');
    // Simulate the loop dispatching the re-queued job as attempt 2.
    await recordDispatch(asRedis(redis), EXTERNAL_ID, PAYLOAD, 2);

    // Failure 2 (attempt 2) -> retry (schedules attempt 3, the last allowed).
    d = await decideRetry(asRedis(redis), WS, EXTERNAL_ID, TRANSPORT_MSG);
    expect(d.action).toBe('retry');
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
});
