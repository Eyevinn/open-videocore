// Integration test for the #463 first-job callback-listener TLS-trust gate.
//
// Acceptance criterion under test (verbatim from the issue):
//   "an instance whose callback-ingress trust is not yet ready receives no job
//    until the probe passes."
//
// Two layers:
//   1. probeCallbackTrust — the classification of a handshake outcome (a 404
//      still proves trust; a PKIX/handshake error is 'tls-trust'; a bounded
//      timeout is 'timeout').
//   2. EncoreScalerLoop.tick() over a minimal in-memory Valkey fake with a
//      stubbed fetch: an instance whose trust probe is not yet ready receives
//      NO job; once the probe passes it becomes eligible and the queued job is
//      dispatched. The gate is a bounded WAIT across re-probes (#463): an early
//      PKIX/handshake failure does NOT quarantine — the instance stays
//      ineligible and a later successful probe makes it eligible. Only a probe
//      that keeps failing PAST the bounded-wait deadline quarantines the
//      instance, which then also receives no job.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { EncoreScalerLoop } from './scaler-loop.js';
import { probeCallbackTrust } from './callback-trust-probe.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Layer 1: probe classification
// ---------------------------------------------------------------------------

describe('probeCallbackTrust (#463 handshake classification)', () => {
  const URL = 'https://listener-abc.auto.prod-se.osaas.io';

  it('treats any completed HTTP response (even 404) as trust confirmed', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404 }));
    const r = await probeCallbackTrust(URL, 5_000, fetchImpl);
    expect(r.ok).toBe(true);
    // Probes the ingress ORIGIN with a HEAD.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://listener-abc.auto.prod-se.osaas.io',
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  it('classifies a PKIX/handshake failure as tls-trust (the #463 race)', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = Object.assign(
        new Error('unable to verify the first certificate'),
        { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
      );
      throw err;
    });
    const r = await probeCallbackTrust(URL, 5_000, fetchImpl);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errorClass).toBe('tls-trust');
  });

  it('classifies an aborted (bounded-timeout) probe as timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const r = await probeCallbackTrust(URL, 10, fetchImpl);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errorClass).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Valkey fake — only the commands tick()/dispatch use.
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
  async set(key: string, val: string): Promise<'OK'> {
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

const WS = 'ws1';
const LISTENER_URL = 'https://listener-abc.auto.prod-se.osaas.io';

function seedInstance(redis: FakeRedis, record: EncoreInstanceRecord): void {
  const h = redis.hashes.get(keys.pool(WS)) ?? new Map<string, string>();
  h.set(record.instanceId, JSON.stringify(record));
  redis.hashes.set(keys.pool(WS), h);
}

function readInstance(redis: FakeRedis, id: string): EncoreInstanceRecord {
  const raw = redis.hashes.get(keys.pool(WS))!.get(id)!;
  return JSON.parse(raw) as EncoreInstanceRecord;
}

// Build a scaler config whose Encore POST (dispatch) always "succeeds" so the
// ONLY thing that can withhold a job is the trust gate. The trust probe uses
// global fetch; we stub globalThis.fetch to control BOTH the probe origin call
// and the Encore /encoreJobs POST.
function makeConfig(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 1,
    idleTimeoutMs: 5 * 60 * 1000,
    redisUrl: 'redis://x',
    // callbackTrustTimeoutMs left default.
    // oscContext/getToken are only exercised on the dispatch path (POST) which
    // we short-circuit via the fetch stub; provide minimal stand-ins.
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: asRedis(redis),
    getToken: async () => 'tkn'
  };
}

describe('EncoreScalerLoop first-job callback-trust gate (#463)', () => {
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

  function queueOneJob(): void {
    const job = { jobId: `${WS}__job-1`, payload: { externalId: `${WS}__job-1` }, enqueuedAt: Date.now() };
    // Queue is consumed via rpoplpush (pop from the tail): put it there.
    redis.lists.set(keys.queue(WS), [JSON.stringify(job)]);
  }

  it('an early PKIX failure does NOT quarantine (bounded wait) — instance stays ineligible, then becomes eligible once a later probe passes', async () => {
    // Fake timers so we can advance time WITHIN the bounded wait between ticks
    // (an early PKIX probe fails ~1s after spawn; the ingress cert becomes
    // trusted ~35s later — well inside the default 60_000ms deadline).
    vi.useFakeTimers();
    vi.setSystemTime(0);

    seedInstance(redis, {
      instanceId: 'inst-1',
      url: 'https://encore-1.osaas.io',
      callbackListenerUrl: LISTENER_URL,
      activeJobs: 0,
      lastIdleAt: Date.now()
    });
    queueOneJob();

    // --- Tick 1 (t=0): probe FAILS with a PKIX handshake error (the #463 race).
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === LISTENER_URL) {
        // Trust probe: certificate not yet trusted (the #463 race).
        const err = new Error('fetch failed');
        (err as Error & { cause?: unknown }).cause = Object.assign(
          new Error('unable to verify the first certificate'),
          { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
        );
        throw err;
      }
      throw new Error(`unexpected fetch to ${url} before trust confirmed`);
    }) as unknown as typeof fetch;

    await loop.tick();

    // The job stayed in the queue: no dispatch happened.
    expect(await redis.llen(keys.queue(WS))).toBe(1);
    // The instance is NOT quarantined (still inside the bounded wait) and NOT
    // trust-ready — it simply gets no job this tick. The first-probe deadline
    // was stamped and persisted so a later tick re-probes against it.
    let inst = readInstance(redis, 'inst-1');
    expect(inst.callbackTrustReady).toBeFalsy();
    expect(inst.callbackTrustQuarantinedAt).toBeFalsy();
    expect(inst.callbackTrustFirstProbeAt).toBe(0);
    // No job-instance mapping recorded (nothing was dispatched).
    expect(await redis.hget(keys.jobInstance(WS), `${WS}__job-1`)).toBeNull();

    // --- Tick 2 (t=35s, still inside the 60s window): probe now SUCCEEDS and
    // the Encore POST succeeds -> dispatch. The SAME instance record (with its
    // persisted callbackTrustFirstProbeAt) is re-probed; nothing was reset.
    vi.setSystemTime(35_000);
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === LISTENER_URL) {
        // Handshake completes: trust confirmed.
        return { status: 200, ok: true } as unknown as Response;
      }
      // Encore /encoreJobs POST.
      if (url.endsWith('/encoreJobs') && init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'encore-uuid-1' })
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    await loop.tick();

    // The job was dispatched: queue drained and mapping recorded.
    expect(await redis.llen(keys.queue(WS))).toBe(0);
    expect(await redis.hget(keys.jobInstance(WS), `${WS}__job-1`)).toBe('inst-1');
    // The instance is now marked trust-ready and stamped.
    inst = readInstance(redis, 'inst-1');
    expect(inst.callbackTrustReady).toBe(true);
    expect(inst.callbackTrustConfirmedAt).toBeTruthy();
    expect(inst.callbackTrustQuarantinedAt).toBeFalsy();
    expect(inst.activeJobs).toBe(1);
  });

  it('an instance whose probe keeps failing PAST the bounded wait IS quarantined and stays ineligible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    seedInstance(redis, {
      instanceId: 'inst-slow',
      url: 'https://encore-slow.osaas.io',
      callbackListenerUrl: LISTENER_URL,
      activeJobs: 0,
      lastIdleAt: Date.now()
    });
    queueOneJob();

    // The probe fails with a PKIX handshake error on every tick.
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === LISTENER_URL) {
        const err = new Error('fetch failed');
        (err as Error & { cause?: unknown }).cause = Object.assign(
          new Error('unable to verify the first certificate'),
          { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
        );
        throw err;
      }
      throw new Error(`unexpected fetch to ${url} before trust confirmed`);
    }) as unknown as typeof fetch;

    // --- Tick 1 (t=0): stamps the first-probe deadline, stays ineligible but
    // NOT yet quarantined.
    await loop.tick();
    let inst = readInstance(redis, 'inst-slow');
    expect(inst.callbackTrustFirstProbeAt).toBe(0);
    expect(inst.callbackTrustQuarantinedAt).toBeFalsy();
    expect(await redis.llen(keys.queue(WS))).toBe(1);

    // --- Tick 2 (t=61s > default 60_000ms deadline): now quarantined. ---
    vi.setSystemTime(61_000);
    await loop.tick();

    inst = readInstance(redis, 'inst-slow');
    expect(inst.callbackTrustReady).toBeFalsy();
    expect(inst.callbackTrustQuarantinedAt).toBeTruthy();
    // Still no dispatch — the job remains queued and no mapping was recorded.
    expect(await redis.llen(keys.queue(WS))).toBe(1);
    expect(await redis.hget(keys.jobInstance(WS), `${WS}__job-1`)).toBeNull();

    // --- Tick 3: a quarantined instance stays ineligible (terminal skip). ---
    vi.setSystemTime(120_000);
    await loop.tick();
    expect(await redis.llen(keys.queue(WS))).toBe(1);
    expect(await redis.hget(keys.jobInstance(WS), `${WS}__job-1`)).toBeNull();
  });

  it('an already-warm (trust-ready) instance is NOT re-probed — no added latency', async () => {
    seedInstance(redis, {
      instanceId: 'inst-warm',
      url: 'https://encore-warm.osaas.io',
      callbackListenerUrl: LISTENER_URL,
      callbackTrustReady: true,
      callbackTrustConfirmedAt: Date.now() - 60_000,
      activeJobs: 0,
      lastIdleAt: Date.now()
    });
    queueOneJob();

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // If the probe ran it would hit LISTENER_URL — assert it does NOT.
      if (url === LISTENER_URL) throw new Error('warm instance was re-probed (regression)');
      if (url.endsWith('/encoreJobs') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'u' }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await loop.tick();

    // Dispatched with no probe call to the listener origin.
    expect(await redis.llen(keys.queue(WS))).toBe(0);
    expect(await redis.hget(keys.jobInstance(WS), `${WS}__job-1`)).toBe('inst-warm');
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toBe(LISTENER_URL);
    }

    globalThis.fetch = realFetch;
  });
});
