// The encore-scaler control loop as the SECOND operational-log producer
// (issue #998, parent #985).
//
// Before this, every spawn/dispatch/reap/tick failure in the loop (ADR-006,
// src/encore-scaler/) was reported with `console.error` inside the container and
// nowhere else — no API, no UI, no durable record — and the dispatch failure
// path reported nothing at all (`return false` re-queued the job silently).
// These tests drive each of the four phases' error paths through a real
// EncoreScalerLoop.tick() with a spied log store and assert:
//
//   (a) the failure reaches `append()` on the store (acceptance criterion 1);
//   (b) the entry is DISTINGUISHABLE from a pipeline-step entry and selectable
//       with the EXISTING `q` filter — `q=encore-scaler` finds every scaler
//       entry, `q=encore-scaler/spawn` one phase, and neither matches the
//       pipeline producer's `transcode: ` entries (acceptance criterion 2);
//   (c) instrumentation never changes loop behaviour: the existing
//       `console.error` still fires, the job is still re-queued, and a store
//       that throws or rejects cannot break the tick.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Write primitive + input shape: `LogStore.append(input: AppendLogInput)`
//     returning `LogRecord`, and `AppendLogInput = { message; level?; category?;
//     timestamp? }` — src/services/log-store.ts (`LogStore.append`,
//     `AppendLogInput`, `LogSink`). The durable implementation answering the
//     same shape as a promise is `CouchLogStore.append` (src/data/
//     couch-log-repo.ts), which is why the sink's return type is `unknown`.
//   - Filter semantics (b) rests on: `applyLogQuery`'s `q` is a
//     case-insensitive substring match on `message` ONLY —
//     `r.message.toLowerCase().includes(q)` in src/services/log-store.ts; there
//     is no `category`/`level` query parameter (src/routes/logs.ts
//     `listLogsQuerySchema`). Hence the message prefix, not just the category.
//   - The other producer the entries must stay distinguishable from:
//     `logPipelineEvent` writes `message: '<stage>: …'` with `category: stage`
//     for `PIPELINE_LOG_STAGES = ['ingest','transcode','package']` —
//     src/services/pipeline-log.ts.
//   - Loop error paths instrumented: `EncoreScalerLoop.start()` tick catch,
//     tick's `reconcileFailedTranscodes` / `resolvePendingSpawns` /
//     `spawnInstance` catches, `reapOrphansIfDue`'s catch, and `dispatch()`'s
//     `!res.ok` / thrown-fetch returns — src/encore-scaler/scaler-loop.ts.
//   - `spawnInstance(config)` / `resolvePendingSpawns(config)` /
//     `reapOrphanedInstances(config)` are the OSC-touching calls those paths
//     make, mocked here so the suite performs no OSC I/O —
//     src/encore-scaler/instance-pool.ts.
//   - Valkey key schema keys.queue / keys.pool / keys.inflight —
//     src/encore-scaler/types.ts (`keys`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import { SCALER_LOG_CATEGORY } from './scaler-log.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig, type QueuedJob } from './types.js';
import { LogStore, type AppendLogInput, type LogRecord } from '../services/log-store.js';
import { logPipelineEvent } from '../services/pipeline-log.js';

// Mock ONLY the three OSC-touching pool calls the instrumented paths make. The
// real listInstances/updateInstance are kept so the pool state the loop reads
// and writes stays honest.
const spawnInstanceMock = vi.hoisted(() => vi.fn());
const resolvePendingSpawnsMock = vi.hoisted(() => vi.fn());
const reapOrphanedInstancesMock = vi.hoisted(() => vi.fn());
vi.mock('./instance-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./instance-pool.js')>();
  return {
    ...actual,
    spawnInstance: spawnInstanceMock,
    resolvePendingSpawns: resolvePendingSpawnsMock,
    reapOrphanedInstances: reapOrphanedInstancesMock
  };
});

// In-memory stand-in for the subset of ioredis tick()/dispatch() use, mirroring
// scaledown-interruption.test.ts: strings, hashes, lists and the few set
// commands the packaging-pin check calls.
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  private set_(key: string): Set<string> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    return s;
  }
  async sadd(key: string, member: string): Promise<number> {
    const s = this.set_(key);
    const isNew = !s.has(member);
    s.add(member);
    return isNew ? 1 : 0;
  }
  async srem(key: string, member: string): Promise<number> {
    return this.set_(key).delete(member) ? 1 : 0;
  }
  async scard(key: string): Promise<number> {
    return this.set_(key).size;
  }
  async pexpire(_key: string, _ms: number): Promise<number> {
    return 1;
  }
  async set(key: string, val: string): Promise<'OK'> {
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
    const h = this.hash(key);
    const isNew = !h.has(field);
    h.set(field, val);
    return isNew ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async hdel(key: string, field: string): Promise<number> {
    return this.hash(key).delete(field) ? 1 : 0;
  }
  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
  async lpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(val);
    this.lists.set(key, l);
    return l.length;
  }
  async rpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    const end = stop === -1 ? l.length - 1 : stop;
    return l.slice(start, end + 1);
  }
  async lrem(key: string, _count: number, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    const idx = l.indexOf(val);
    if (idx >= 0) {
      l.splice(idx, 1);
      this.lists.set(key, l);
      return 1;
    }
    return 0;
  }
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const s = this.lists.get(src) ?? [];
    const val = s.pop();
    if (val === undefined) return null;
    this.lists.set(src, s);
    const d = this.lists.get(dst) ?? [];
    d.unshift(val);
    this.lists.set(dst, d);
    return val;
  }
}

const WS = 'ws-logs';

// A REAL in-memory LogStore (the implementation the no-Couch paths use) behind a
// `vi.fn()` spy, so a test can assert on the exact append() input AND query the
// resulting records through the same `applyLogQuery` the HTTP read path uses.
function makeSpiedStore(): {
  store: LogStore;
  append: ReturnType<typeof vi.fn>;
  sink: { append: (input: AppendLogInput) => LogRecord };
} {
  const store = new LogStore();
  const append = vi.fn((input: AppendLogInput): LogRecord => store.append(input));
  return { store, append, sink: { append } };
}

function makeConfig(
  redis: FakeRedis,
  overrides?: Partial<EncoreScalerConfig>
): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    ...overrides
  };
}

// A findByStatus HATEOAS page (the shape fetchRealActiveState parses).
function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Answers the reconcile/scale-down status queries as "nothing active", and the
// dispatch POST /encoreJobs with whatever `dispatchResponder` models.
function fetchMock(dispatchResponder: () => Response | Promise<Response>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=')) return encorePage([]);
    if (url.includes('/encoreJobs')) return dispatchResponder();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedQueuedJob(redis: FakeRedis, jobId: string): Promise<void> {
  const job: QueuedJob = {
    jobId,
    payload: { externalId: jobId, profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] },
    enqueuedAt: Date.now()
  };
  await redis.rpush(keys.queue(WS), JSON.stringify(job));
}

async function seedReadyInstance(redis: FakeRedis, instanceId: string): Promise<void> {
  const record: EncoreInstanceRecord = {
    instanceId,
    url: 'https://encore.example',
    activeJobs: 0,
    // Freshly idle, so scale-down never selects it and the dispatch step runs.
    lastIdleAt: Date.now(),
    readyAt: Date.now(),
    // Already trust-confirmed, so no probe runs (see ensureCallbackTrust).
    callbackTrustReady: true
  };
  await redis.hset(keys.pool(WS), instanceId, JSON.stringify(record));
}

// Messages of every record the store holds, newest-first (the listing default).
function messages(store: LogStore, q?: string): string[] {
  return store.list(q === undefined ? {} : { q }).items.map((r) => r.message);
}

describe('encore-scaler control-loop errors -> operational log store (#998)', () => {
  beforeEach(() => {
    spawnInstanceMock.mockReset();
    resolvePendingSpawnsMock.mockReset().mockResolvedValue(undefined);
    reapOrphanedInstancesMock.mockReset().mockResolvedValue(undefined);
    // Keep the suite's own stdout clean while still asserting the existing
    // console.error convention is preserved.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('appends a distinguishable error entry when a scale-up spawn fails', async () => {
    const redis = new FakeRedis();
    await seedQueuedJob(redis, 'job-1'); // pending work, empty pool => spawn
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));
    spawnInstanceMock.mockRejectedValue(new Error('OSC refused: quota exceeded'));

    const { store, append, sink } = makeSpiedStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    expect(spawnInstanceMock).toHaveBeenCalledTimes(1);
    // The append went through with the full AppendLogInput contract: an
    // `error` level and the producer's own category.
    expect(append).toHaveBeenCalledTimes(1);
    const input = append.mock.calls[0]![0] as AppendLogInput;
    expect(input.level).toBe('error');
    expect(input.category).toBe(SCALER_LOG_CATEGORY);
    expect(input.message).toMatch(/^encore-scaler\/spawn: /);
    // Carries the cause and the emitting workspace, so the entry says at least
    // as much as the console.error beside it.
    expect(input.message).toContain('OSC refused: quota exceeded');
    expect(input.message).toContain(`[workspace=${WS}]`);
    // Durably readable back through the store's own listing contract.
    expect(store.size()).toBe(1);
    // The pre-existing container-log line is untouched.
    expect(console.error).toHaveBeenCalled();
  });

  it('appends a dispatch-phase entry when an instance rejects the job, and still re-queues it', async () => {
    const redis = new FakeRedis();
    await seedReadyInstance(redis, 'inst-1');
    await seedQueuedJob(redis, 'job-2');
    vi.stubGlobal(
      'fetch',
      fetchMock(() => ({ ok: false, status: 503 }) as unknown as Response)
    );

    const { store, sink } = makeSpiedStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const dispatchEntries = messages(store, 'encore-scaler/dispatch');
    expect(dispatchEntries).toHaveLength(1);
    expect(dispatchEntries[0]).toContain('job-2');
    expect(dispatchEntries[0]).toContain('inst-1');
    expect(dispatchEntries[0]).toContain('503');

    // Behaviour unchanged (#998 is additive): the job is back on the queue for
    // the next tick and nothing is left in inflight.
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    expect((JSON.parse(queued[0]!) as QueuedJob).jobId).toBe('job-2');
    expect(await redis.lrange(keys.inflight(WS), 0, -1)).toHaveLength(0);
  });

  it('appends a dispatch-phase entry when the POST to the instance throws', async () => {
    const redis = new FakeRedis();
    await seedReadyInstance(redis, 'inst-1');
    await seedQueuedJob(redis, 'job-3');
    vi.stubGlobal(
      'fetch',
      fetchMock(() => {
        throw new Error('ECONNRESET');
      })
    );

    const { store, sink } = makeSpiedStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const dispatchEntries = messages(store, 'encore-scaler/dispatch');
    expect(dispatchEntries).toHaveLength(1);
    expect(dispatchEntries[0]).toContain('job-3');
    expect(dispatchEntries[0]).toContain('ECONNRESET');
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
  });

  it('appends a reap-phase entry when the orphan sweep fails', async () => {
    const redis = new FakeRedis();
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));
    reapOrphanedInstancesMock.mockRejectedValue(new Error('OSC list timed out'));

    const { store, sink } = makeSpiedStore();
    await new EncoreScalerLoop(
      // The sweep is opt-in; enable it so this tick runs it.
      makeConfig(redis, { logSink: sink, orphanReapIntervalMs: 1 })
    ).tick();

    expect(reapOrphanedInstancesMock).toHaveBeenCalledTimes(1);
    const reapEntries = messages(store, 'encore-scaler/reap');
    expect(reapEntries).toHaveLength(1);
    expect(reapEntries[0]).toContain('OSC list timed out');
  });

  it('appends a spawn-phase entry when pending-spawn resolution fails', async () => {
    const redis = new FakeRedis();
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));
    resolvePendingSpawnsMock.mockRejectedValue(new Error('instance health unreadable'));

    const { store, sink } = makeSpiedStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const spawnEntries = messages(store, 'encore-scaler/spawn');
    expect(spawnEntries).toHaveLength(1);
    expect(spawnEntries[0]).toContain('instance health unreadable');
  });

  it('appends a tick-phase entry when the per-tick failed-transcode sweep errors', async () => {
    const redis = new FakeRedis();
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));

    const { store, sink } = makeSpiedStore();
    await new EncoreScalerLoop(
      makeConfig(redis, {
        logSink: sink,
        reconcileFailedTranscodes: async () => {
          throw new Error('CouchDB unreachable');
        }
      })
    ).tick();

    const tickEntries = messages(store, 'encore-scaler/tick');
    expect(tickEntries).toHaveLength(1);
    expect(tickEntries[0]).toContain('CouchDB unreachable');
  });

  it('appends a tick-phase entry when the whole tick throws under the interval', async () => {
    const redis = new FakeRedis();
    // The pending-work read is the first thing after reconcile; make it throw so
    // tick() rejects and start()'s catch — the top-level tick guard — runs.
    redis.llen = async () => {
      throw new Error('valkey connection lost');
    };
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));

    const { store, sink } = makeSpiedStore();
    const loop = new EncoreScalerLoop(makeConfig(redis, { logSink: sink }));
    vi.useFakeTimers();
    try {
      loop.start(10);
      await vi.advanceTimersByTimeAsync(25);
    } finally {
      loop.stop();
    }

    const tickEntries = messages(store, 'encore-scaler/tick');
    expect(tickEntries.length).toBeGreaterThanOrEqual(1);
    expect(tickEntries[0]).toContain('valkey connection lost');
  });

  it('keeps scaler entries filterable apart from pipeline-step entries with the existing q filter', async () => {
    const redis = new FakeRedis();
    await seedQueuedJob(redis, 'job-4');
    vi.stubGlobal('fetch', fetchMock(() => encorePage([])));
    spawnInstanceMock.mockRejectedValue(new Error('spawn boom'));

    const { store, sink } = makeSpiedStore();
    // The OTHER producer (#995) writes to the same store.
    logPipelineEvent(sink, {
      stage: 'transcode',
      level: 'error',
      message: 'encode failed for asset a1'
    });
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    expect(store.size()).toBe(2);
    // `q=encore-scaler` selects the scaler producer and ONLY it.
    const scalerOnly = messages(store, SCALER_LOG_CATEGORY);
    expect(scalerOnly).toHaveLength(1);
    expect(scalerOnly[0]).toContain('spawn boom');
    // `q=encore-scaler/dispatch` selects no scaler entry from another phase.
    expect(messages(store, 'encore-scaler/dispatch')).toHaveLength(0);
    // And the pipeline-step filter still selects only the pipeline entry.
    const pipelineOnly = messages(store, 'transcode:');
    expect(pipelineOnly).toHaveLength(1);
    expect(pipelineOnly[0]).toBe('transcode: encode failed for asset a1');
  });

  it('never lets the log store break the loop: a throwing or rejecting append is swallowed', async () => {
    const redis = new FakeRedis();
    await seedReadyInstance(redis, 'inst-1');
    await seedQueuedJob(redis, 'job-5');
    vi.stubGlobal(
      'fetch',
      fetchMock(() => ({ ok: false, status: 500 }) as unknown as Response)
    );

    const throwing = {
      append: vi.fn(() => {
        throw new Error('store down');
      })
    };
    await expect(
      new EncoreScalerLoop(makeConfig(redis, { logSink: throwing })).tick()
    ).resolves.toBeUndefined();
    expect(throwing.append).toHaveBeenCalled();
    // The dispatch failure still took its normal course.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);

    // Same for the DURABLE store's shape, whose append returns a promise
    // (CouchLogStore.append): a rejection must be caught, not surface as an
    // unhandled rejection.
    const rejecting = { append: vi.fn(async () => Promise.reject(new Error('couch down'))) };
    await expect(
      new EncoreScalerLoop(makeConfig(redis, { logSink: rejecting })).tick()
    ).resolves.toBeUndefined();
    expect(rejecting.append).toHaveBeenCalled();
    await Promise.resolve();
  });

  it('is a no-op with no log sink configured (behaviour identical to before #998)', async () => {
    const redis = new FakeRedis();
    await seedReadyInstance(redis, 'inst-1');
    await seedQueuedJob(redis, 'job-6');
    vi.stubGlobal(
      'fetch',
      fetchMock(() => ({ ok: false, status: 502 }) as unknown as Response)
    );

    await expect(new EncoreScalerLoop(makeConfig(redis)).tick()).resolves.toBeUndefined();
    // Still re-queued, and still reported on the container log.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });
});
