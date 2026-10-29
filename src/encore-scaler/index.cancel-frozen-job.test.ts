// #1219: cancelling a FROZEN transcode job must actually POST the Encore cancel.
//
// The failure reported in #1219 is Videocore showing CANCELLED while the Encore
// job stays IN_PROGRESS. The in-repo cause on the cancel path was resolution:
// cancel() resolved the target from the LIVE keys.jobInstance mapping plus a
// keys.pool record and skipped the POST entirely when either was missing — which
// is the normal state for a job whose live mapping has been cleared (a
// scale-down/transport re-enqueue, the dropped-job path) or whose instance has
// left the pool. It then recorded CANCELLED regardless.
//
// These tests pin the dispatch-time URL path (keys.jobEncoreUrl survives both),
// the terminal-instance fallback, and that an undelivered cancel is surfaced
// instead of being reported as a successful cancel.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Encore cancel endpoint: POST {instanceUrl}/encoreJobs/{uuid}/cancel — SVT
//     Encore EncoreController.kt (github.com/svt/encore,
//     encore-web/.../controller/EncoreController.kt), cited at
//     src/pipeline/encore-client.ts:53-58 and src/encore-scaler/retry-store.ts:85-90.
//     404/409 are idempotent no-ops.
//   - keys.jobEncoreUrl = `{instanceUrl}/encoreJobs/{uuid}`, written at dispatch
//     with a 24h TTL: src/encore-scaler/types.ts:403-407, written at
//     src/encore-scaler/scaler-loop.ts:2301.
//   - keys.jobTerminalInstance retained past terminal (#739):
//     src/encore-scaler/types.ts:408-418.
//   - keys.jobInstance is hdel'd on re-enqueue: src/encore-scaler/retry-store.ts:231,361.
//   - resolver under test: resolveEncoreCancelUrl, src/encore-scaler/cancel-target.ts.

import { afterEach, describe, it, expect, vi } from 'vitest';

import { makeScalingEncoreClient } from './index.js';
import { resolveEncoreCancelUrl } from './cancel-target.js';
import { keys, type EncoreScalerConfig, type EncoreInstanceRecord } from './types.js';

// In-memory ioredis stand-in for the ops cancel() uses: list (lrange/lrem),
// string (get/set) and hash (hget/hset).
class FakeRedis {
  private lists = new Map<string, string[]>();
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();

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
    return before - kept.length;
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

  async hdel(key: string, field: string): Promise<number> {
    return this.hash(key).delete(field) ? 1 : 0;
  }
}

const WS = 'ws1';

function makeConfig(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 2,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
  };
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => 'Ok' }) as unknown as Response);
}

describe('#1219: cancel reaches Encore for a job whose live instance mapping is gone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs {jobEncoreUrl}/cancel when keys.jobInstance has already been cleared', async () => {
    const redis = new FakeRedis();
    const jobId = 'ws1--frozen-1';
    const jobUrl = 'https://encore-inst-7.example/encoreJobs/2b2c3356';

    // Dispatched, then the live mapping was cleared (re-enqueue / dropped-job
    // path) and the instance is no longer in the pool — the #1219 state. Only
    // the dispatch-time URL remains.
    await redis.set(keys.jobEncoreUrl(jobId), jobUrl);
    await redis.hset(keys.jobStatus(WS), jobId, 'RUNNING');

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await makeScalingEncoreClient(makeConfig(redis)).cancel(jobId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method?: string }];
    expect(String(url)).toBe(`${jobUrl}/cancel`);
    expect(init?.method).toBe('POST');
    expect(await redis.hget(keys.jobStatus(WS), jobId)).toBe('CANCELLED');
  });

  it('bounds the cancel POST so a frozen instance cannot hang the request', async () => {
    const redis = new FakeRedis();
    const jobId = 'ws1--frozen-2';
    await redis.set(keys.jobEncoreUrl(jobId), 'https://encore-inst-7.example/encoreJobs/u2');

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await makeScalingEncoreClient(makeConfig(redis)).cancel(jobId);

    const [, init] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces an undelivered cancel instead of reporting it as cancelled, while still recording the local terminal status', async () => {
    const redis = new FakeRedis();
    const jobId = 'ws1--frozen-3';
    await redis.set(keys.jobEncoreUrl(jobId), 'https://encore-inst-7.example/encoreJobs/u3');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      })
    );

    await expect(makeScalingEncoreClient(makeConfig(redis)).cancel(jobId)).rejects.toThrow(
      /ETIMEDOUT/
    );
    // The operator's intent is still recorded locally so nothing re-dispatches it.
    expect(await redis.hget(keys.jobStatus(WS), jobId)).toBe('CANCELLED');
  });

  it('treats 404/409 as idempotent no-ops (job already gone or terminal)', async () => {
    for (const status of [404, 409]) {
      const redis = new FakeRedis();
      const jobId = `ws1--gone-${status}`;
      await redis.set(keys.jobEncoreUrl(jobId), 'https://encore-inst-7.example/encoreJobs/u4');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status, text: async () => '' }) as unknown as Response)
      );

      await expect(makeScalingEncoreClient(makeConfig(redis)).cancel(jobId)).resolves.toBeUndefined();
      expect(await redis.hget(keys.jobStatus(WS), jobId)).toBe('CANCELLED');
    }
  });
});

describe('#1219: resolveEncoreCancelUrl', () => {
  it('prefers the dispatch-time URL over reconstruction', async () => {
    const redis = new FakeRedis();
    const jobId = 'ws1--a';
    await redis.set(keys.jobEncoreUrl(jobId), 'https://direct.example/encoreJobs/uuid-direct');
    await redis.set(keys.jobUuid(jobId), 'uuid-other');
    await redis.hset(keys.jobInstance(WS), jobId, 'inst-1');
    await redis.hset(
      keys.pool(WS),
      'inst-1',
      JSON.stringify({
        instanceId: 'inst-1',
        url: 'https://pool.example',
        activeJobs: 1,
        lastIdleAt: 0
      } satisfies EncoreInstanceRecord)
    );

    expect(await resolveEncoreCancelUrl(redis, WS, jobId)).toBe(
      'https://direct.example/encoreJobs/uuid-direct'
    );
  });

  it('reconstructs from the terminal-surviving instance when the live mapping is gone', async () => {
    const redis = new FakeRedis();
    const jobId = 'ws1--b';
    await redis.set(keys.jobUuid(jobId), 'uuid-b');
    await redis.set(keys.jobTerminalInstance(jobId), 'inst-2');
    await redis.hset(
      keys.pool(WS),
      'inst-2',
      JSON.stringify({
        instanceId: 'inst-2',
        url: 'https://inst-2.example/',
        activeJobs: 1,
        lastIdleAt: 0
      } satisfies EncoreInstanceRecord)
    );

    expect(await resolveEncoreCancelUrl(redis, WS, jobId)).toBe(
      'https://inst-2.example/encoreJobs/uuid-b'
    );
  });

  it('returns undefined when the job has no recorded dispatch at all', async () => {
    const redis = new FakeRedis();
    expect(await resolveEncoreCancelUrl(redis, WS, 'ws1--never-dispatched')).toBeUndefined();
  });
});
