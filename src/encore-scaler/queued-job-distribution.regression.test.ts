// Regression test for issue #1170: queued transcode jobs must be distributed
// across EVERY ready Encore instance, not drained serially through the first.
//
// Incident (verbatim from the issue): "With scaler max 2 and three jobs queued
// together, the second instance became ready (muxs3tn6 at 07:21:59) but
// received no job. All three jobs ran in sequence on the first instance
// (muxri65i), and the second took its first job only at 07:26."
//
// HOW JOBS ARE ASSIGNED (determined by reading the code before writing this):
// shared-queue PULL followed by submission to a specific instance. Producers
// LPUSH onto `encore:queue:{workspaceId}` (src/encore-scaler/index.ts
// makeScalingEncoreClient.submit, src/encore-scaler/encore-scaler-router.ts
// POST /encoreJobs) and the control loop's step 5
// (EncoreScalerLoop.tick, src/encore-scaler/scaler-loop.ts) RPOPLPUSHes each
// entry and POSTs it to one chosen instance (EncoreScalerLoop.dispatch).
// So distribution is entirely decided by step 5's per-instance gates.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - JOBS_PER_INSTANCE = 1 — src/encore-scaler/types.ts:377. One job per
//     instance is the whole per-instance capacity, so two queued jobs can only
//     run concurrently by landing on two different instances.
//   - EncoreInstanceRecord fields used below (`activeJobs`, `readyAt`,
//     `lastIdleAt`, `callbackListenerUrl`, `callbackTrustReady`,
//     `callbackTrustFirstProbeAt`) — src/encore-scaler/types.ts.
//   - keys.queue / keys.pool / keys.jobInstance — src/encore-scaler/types.ts.
//   - The trust probe targets `${callbackListenerUrl}/encoreCallback` —
//     buildCallbackUri / CALLBACK_PATH, src/encore-scaler/callback-trust-probe.ts.
//   - Encore `GET /encoreJobs/search/findByStatus?status=..&page=..&size=..`
//     returning a HATEOAS page with `page.totalElements` —
//     src/encore-scaler/encore-paging-contract.ts, pinned by
//     test/encore-findbystatus-contract.test.ts against
//     docs/contracts/encore-findbystatus-paging.json.
//   - Encore `POST /encoreJobs` answering with `{ id }` —
//     EncoreScalerLoop.dispatch, src/encore-scaler/scaler-loop.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from './types.js';

// ---------------------------------------------------------------------------
// Minimal in-memory Valkey fake — only the commands tick()/dispatch use.
// Mirrors the fake in callback-trust-gate.test.ts.
// ---------------------------------------------------------------------------
class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  strings = new Map<string, string>();

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
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
    return h && h.delete(field) ? 1 : 0;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const s = this.lists.get(src) ?? [];
    if (s.length === 0) return null;
    const val = s.pop() as string;
    const d = this.lists.get(dst) ?? [];
    d.unshift(val);
    this.lists.set(src, s);
    this.lists.set(dst, d);
    return val;
  }
  async rpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lrem(key: string, _count: number, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    const idx = l.indexOf(val);
    if (idx === -1) return 0;
    l.splice(idx, 1);
    this.lists.set(key, l);
    return 1;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }
  async set(key: string, val: string): Promise<'OK'> {
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }
  async smembers(): Promise<string[]> {
    return [];
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

const WS = 'ws1';
const LISTENER_A = 'https://listener-a.auto.prod-se.osaas.io';
const LISTENER_B = 'https://listener-b.auto.prod-se.osaas.io';

function seedInstance(redis: FakeRedis, record: EncoreInstanceRecord): void {
  const h = redis.hashes.get(keys.pool(WS)) ?? new Map<string, string>();
  h.set(record.instanceId, JSON.stringify(record));
  redis.hashes.set(keys.pool(WS), h);
}

function readInstance(redis: FakeRedis, id: string): EncoreInstanceRecord {
  const raw = redis.hashes.get(keys.pool(WS))!.get(id)!;
  return JSON.parse(raw) as EncoreInstanceRecord;
}

function queueJobs(redis: FakeRedis, ids: string[]): string[] {
  const entries: string[] = [];
  for (const jobId of ids) {
    entries.push(
      JSON.stringify({
        jobId,
        payload: { externalId: jobId },
        enqueuedAt: Date.now()
      })
    );
  }
  // Producers LPUSH and the loop RPOPs, so the oldest job must sit at the tail.
  redis.lists.set(keys.queue(WS), [...entries].reverse());
  return ids;
}

// An Encore findByStatus page (contract: `_embedded.encoreJobs[].externalId`
// plus `page.totalElements` — src/encore-scaler/encore-paging-contract.ts).
function statusPage(externalIds: string[]): unknown {
  return {
    _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
    page: { totalElements: externalIds.length, size: 500, number: 0 }
  };
}

function makeConfig(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 2,
    idleTimeoutMs: 5 * 60 * 1000,
    redisUrl: 'redis://x',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: asRedis(redis),
    getToken: async () => 'tkn'
  };
}

// Stub global fetch for: the callback-trust probe, Encore's findByStatus reads
// and Encore's POST /encoreJobs. `trustedListeners` controls which listener
// ingresses answer the probe successfully.
function stubFetch(opts: {
  trustedListeners: string[];
  // Encore base URL -> externalIds that instance really reports IN_PROGRESS.
  activeJobsByInstanceUrl?: Record<string, string[]>;
}): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/encoreCallback')) {
      const base = url.slice(0, -'/encoreCallback'.length);
      // 200 => trusted; 401 => reachable but not usable (still in the fresh
      // listener's ingress-auth window, src/encore-scaler/callback-trust-probe.ts).
      return {
        status: opts.trustedListeners.includes(base) ? 200 : 401,
        ok: opts.trustedListeners.includes(base)
      } as unknown as Response;
    }
    if (url.includes('/encoreJobs/search/findByStatus')) {
      const host = url.slice(0, url.indexOf('/encoreJobs/'));
      const active = opts.activeJobsByInstanceUrl?.[host] ?? [];
      const inProgress = url.includes('status=IN_PROGRESS');
      return {
        ok: true,
        status: 200,
        json: async () => statusPage(inProgress ? active : [])
      } as unknown as Response;
    }
    if (url.endsWith('/encoreJobs') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: `encore-uuid-${Math.random().toString(36).slice(2)}` })
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return spy as unknown as ReturnType<typeof vi.fn>;
}

describe('queued-job distribution across ready instances (#1170)', () => {
  let redis: FakeRedis;
  let loop: EncoreScalerLoop;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    redis = new FakeRedis();
    loop = new EncoreScalerLoop(makeConfig(redis));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  // Acceptance (verbatim from #1170): "with max 2 and 3 queued jobs, two jobs
  // run concurrently on separate instances."
  it('dispatches to BOTH ready instances in a single tick: 3 queued jobs, max 2 => 2 concurrent on separate instances', async () => {
    const now = Date.now();
    seedInstance(redis, {
      instanceId: 'inst-a',
      url: 'https://encore-a.osaas.io',
      callbackListenerUrl: LISTENER_A,
      callbackTrustReady: true,
      callbackTrustConfirmedAt: now - 60_000,
      activeJobs: 0,
      lastIdleAt: now,
      readyAt: now
    });
    seedInstance(redis, {
      instanceId: 'inst-b',
      url: 'https://encore-b.osaas.io',
      callbackListenerUrl: LISTENER_B,
      callbackTrustReady: true,
      callbackTrustConfirmedAt: now - 60_000,
      activeJobs: 0,
      lastIdleAt: now,
      readyAt: now
    });
    const [job1, job2, job3] = queueJobs(redis, [
      `${WS}__job-1`,
      `${WS}__job-2`,
      `${WS}__job-3`
    ]);

    globalThis.fetch = stubFetch({
      trustedListeners: [LISTENER_A, LISTENER_B]
    }) as unknown as typeof fetch;

    await loop.tick();

    const owners = [
      await redis.hget(keys.jobInstance(WS), job1!),
      await redis.hget(keys.jobInstance(WS), job2!)
    ];
    expect(owners).toContain('inst-a');
    expect(owners).toContain('inst-b');
    // The third job stays queued (per-instance capacity is 1, #types.ts:377).
    expect(await redis.hget(keys.jobInstance(WS), job3!)).toBeNull();
    expect(await redis.llen(keys.queue(WS))).toBe(1);
    expect(readInstance(redis, 'inst-a').activeJobs).toBe(1);
    expect(readInstance(redis, 'inst-b').activeJobs).toBe(1);
  });

  // The incident shape: the first instance is already busy, the second has just
  // become ready and its callback-trust probe has not passed yet. Queued work
  // must reach it as soon as the probe passes - and NOT be handed to the busy
  // first instance in the meantime.
  it('a newly ready second instance takes queued work on the tick its trust probe passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    seedInstance(redis, {
      instanceId: 'inst-a',
      url: 'https://encore-a.osaas.io',
      callbackListenerUrl: LISTENER_A,
      callbackTrustReady: true,
      callbackTrustConfirmedAt: 0,
      activeJobs: 1,
      lastIdleAt: 0,
      readyAt: 0
    });
    seedInstance(redis, {
      instanceId: 'inst-b',
      url: 'https://encore-b.osaas.io',
      callbackListenerUrl: LISTENER_B,
      activeJobs: 0,
      lastIdleAt: 0,
      readyAt: 0
    });
    // job-1 is already running on inst-a; job-2 is the one still queued.
    const job1 = `${WS}__job-1`;
    const [job2] = queueJobs(redis, [`${WS}__job-2`]);
    // inst-a is genuinely running job-1, so reconcile keeps it at capacity
    // (JOBS_PER_INSTANCE = 1, src/encore-scaler/types.ts:377) and the queued
    // job can only run concurrently if it lands on inst-b.
    await redis.hset(keys.jobInstance(WS), job1, 'inst-a');
    await redis.hset(keys.jobStatus(WS), job1, 'running');
    const reallyRunning = { 'https://encore-a.osaas.io': [job1] };

    // Tick 1: inst-b's listener ingress is still auth-walled (401) => no job.
    globalThis.fetch = stubFetch({
      trustedListeners: [LISTENER_A],
      activeJobsByInstanceUrl: reallyRunning
    }) as unknown as typeof fetch;
    await loop.tick();
    expect(await redis.hget(keys.jobInstance(WS), job2!)).toBeNull();

    // Tick 2 (t=20s, inside the 60s bounded wait): the probe now passes, so the
    // ready instance must take the queued job.
    vi.setSystemTime(20_000);
    globalThis.fetch = stubFetch({
      trustedListeners: [LISTENER_A, LISTENER_B],
      activeJobsByInstanceUrl: reallyRunning
    }) as unknown as typeof fetch;
    await loop.tick();

    expect(await redis.hget(keys.jobInstance(WS), job2!)).toBe('inst-b');
    expect(readInstance(redis, 'inst-b').activeJobs).toBe(1);
  });
});
