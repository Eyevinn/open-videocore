// #746/#295: makeScalingEncoreClient.cancel must handle the DOUBLE-STATE a job
// can be in — one or MORE buffered queue entries AND a dispatched Encore job at
// the same time (a transport-class retry re-enqueues the same externalId while an
// earlier attempt is already dispatched). cancel() must ALWAYS drain every queue
// entry FIRST, then, if the job was dispatched, POST the real Encore cancel on
// its instance. Draining only when undispatched (or removing a single entry)
// leaves orphaned duplicates the loop would later dispatch with nobody listening.
//
// This test seeds the mixed state (buffered duplicates + a dispatched instance),
// runs cancel(), and asserts drain-all THEN dispatched-cancel ordering plus the
// terminal CANCELLED status.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - makeScalingEncoreClient.cancel drain-all + dispatched-cancel:
//     src/encore-scaler/index.ts:84-155.
//   - Encore cancel endpoint POST {instanceUrl}/encoreJobs/{uuid}/cancel — SVT
//     Encore EncoreController.kt (github.com/svt/encore, verified 2026-07-09),
//     cited src/encore-scaler/index.ts:117-119.
//   - Valkey key schema keys.queue / keys.jobUuid / keys.jobInstance / keys.pool
//     / keys.jobStatus: src/encore-scaler/types.ts.

import { afterEach, describe, it, expect, vi } from 'vitest';

import { makeScalingEncoreClient } from './index.js';
import { keys, type EncoreScalerConfig, type EncoreInstanceRecord } from './types.js';

// In-memory ioredis stand-in for the ops cancel() uses: list (lrange/lrem),
// string (get/set) and hash (hget/hset). Records an ordered op log so the test
// can assert drain-all precedes the dispatched cancel.
class FakeRedis {
  private lists = new Map<string, string[]>();
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();

  constructor(private readonly log: string[]) {}

  private list(key: string): string[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async lpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.unshift(value);
    return l.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.list(key);
    if (start === 0 && stop === -1) return [...l];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    if (count !== 0) throw new Error(`FakeRedis.lrem only models count 0, got ${count}`);
    const l = this.list(key);
    const before = l.length;
    const kept = l.filter((v) => v !== value);
    this.lists.set(key, kept);
    const removed = before - kept.length;
    this.log.push('lrem');
    return removed;
  }

  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
}

function makeConfig(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: 'ws1',
    maxInstances: 2,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
  };
}

describe('#746: makeScalingEncoreClient.cancel drains all + cancels dispatched (double-state)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains EVERY buffered duplicate first, THEN POSTs the dispatched Encore cancel', async () => {
    const log: string[] = [];
    const redis = new FakeRedis(log);
    const ws = 'ws1';
    const jobId = 'ext-mixed-1';
    const encoreUuid = 'uuid-123';
    const instanceId = 'inst-1';
    const instanceUrl = 'https://encore.example';

    // (i) TWO buffered queue entries for the same externalId (distinct enqueuedAt
    // — the #295 re-enqueue). Plus an unrelated job that must survive.
    await redis.lpush(
      keys.queue(ws),
      JSON.stringify({ jobId, payload: { externalId: jobId }, enqueuedAt: 1000 })
    );
    await redis.lpush(
      keys.queue(ws),
      JSON.stringify({ jobId, payload: { externalId: jobId }, enqueuedAt: 2000 })
    );
    const other = JSON.stringify({
      jobId: 'other',
      payload: { externalId: 'other' },
      enqueuedAt: 3000
    });
    await redis.lpush(keys.queue(ws), other);

    // (ii) A DISPATCHED instance for the same job — the double-state.
    await redis.set(keys.jobUuid(jobId), encoreUuid);
    await redis.hset(keys.jobInstance(ws), jobId, instanceId);
    await redis.hset(
      keys.pool(ws),
      instanceId,
      JSON.stringify({
        instanceId,
        url: instanceUrl,
        activeJobs: 1,
        lastIdleAt: 0
      } satisfies EncoreInstanceRecord)
    );

    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      log.push('fetch-cancel');
      // Assert the real Encore cancel endpoint + method at call time.
      expect(String(input)).toBe(`${instanceUrl}/encoreJobs/${encoreUuid}/cancel`);
      expect(init?.method).toBe('POST');
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = makeScalingEncoreClient(makeConfig(redis));
    await client.cancel(jobId);

    // Drain-all happened BEFORE the dispatched cancel: both matching entries were
    // lrem'd, then the Encore cancel POST fired last.
    expect(log).toEqual(['lrem', 'lrem', 'fetch-cancel']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Queue is free of that job's entries; the unrelated job survives.
    const remaining = await redis.lrange(keys.queue(ws), 0, -1);
    expect(remaining).toEqual([other]);

    // Terminal status recorded so getJobStatus reports 'failed'.
    expect(await redis.hget(keys.jobStatus(ws), jobId)).toBe('CANCELLED');
  });
});
