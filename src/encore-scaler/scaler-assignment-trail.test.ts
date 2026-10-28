// Per-tick readiness / job-assignment trail (issue #1172, broken out of #1168).
//
// The gap these tests pin: with two ready instances and a non-empty queue,
// nothing in any log said why the second instance had no work. Queue depth was a
// gauge on GET /api/v1/scaler/status (#1132), the callback-trust gate's
// "ineligible this tick" branch returned false silently, and a SUCCESSFUL
// assignment was never logged at all. Acceptance: one log trail explains why an
// instance did or did not receive a job.
//
// Additive to the two PRs #1172 builds on, which these tests also guard:
//   - #1136 (loop error logging) keeps its phases and its filters: a dispatch
//     FAILURE is still exactly one `encore-scaler/dispatch` error entry, and the
//     trail is a separate `encore-scaler/assign` info entry.
//   - #1132's queue depth is not re-read: the trail reports the depth the tick
//     already had.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - `EncoreInstanceRecord` fields seeded/asserted here — `instanceId`, `url`,
//     `activeJobs`, `lastIdleAt`, `readyAt`, `draining`, `pendingReadySince`,
//     `callbackTrustReady`, `callbackListenerUrl` — src/encore-scaler/types.ts.
//   - `QueuedJob` = `{ jobId; payload; enqueuedAt; notBefore?; attempts? }` —
//     src/encore-scaler/types.ts.
//   - `keys.queue` / `keys.pool` / `keys.inflight` — src/encore-scaler/types.ts.
//   - `probeCallbackTrust(url, timeoutMs): Promise<CallbackTrustProbeResult>`,
//     the union `{ ok: true; state: 'trusted'; status }` | `{ ok: false; state:
//     'callback-unusable'; status; detail }` | `{ ok: false; state:
//     'probe-failed'; errorClass; detail }` —
//     src/encore-scaler/callback-trust-probe.ts.
//   - `LogStore.append(input: AppendLogInput): LogRecord` and `applyLogQuery`'s
//     `q` as a case-insensitive substring match on `message` only —
//     src/services/log-store.ts.
//   - `JOBS_PER_INSTANCE` (per-instance capacity) and the mocked OSC-touching
//     pool calls `spawnInstance` / `resolvePendingSpawns` /
//     `reapOrphanedInstances` — src/encore-scaler/instance-pool.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import { SCALER_LOG_CATEGORY, SCALER_LOG_PHASES } from './scaler-log.js';
import {
  ASSIGNMENT_TRAIL_REPEAT_MS,
  assignmentTrailFingerprint,
  describeProbeResult,
  formatAssignmentTrail,
  recordedProbeOutcome,
  renderProbeOutcome,
  shouldLogAssignmentTrail,
  type AssignmentDecision
} from './assignment-log.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig, type QueuedJob } from './types.js';
import { LogStore, type AppendLogInput, type LogRecord } from '../services/log-store.js';

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

// The trust probe is the one remaining OSC/network touch in the dispatch path;
// mocked so a probe outcome can be modelled exactly.
const probeMock = vi.hoisted(() => vi.fn());
vi.mock('./callback-trust-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./callback-trust-probe.js')>();
  return { ...actual, probeCallbackTrust: probeMock };
});

// In-memory stand-in for the subset of ioredis the tick uses (same shape as
// scaler-loop-log-store.test.ts / scaledown-interruption.test.ts).
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
  async pexpire(): Promise<number> {
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

const WS = 'ws-assign';

function makeStore(): { store: LogStore; sink: { append: (input: AppendLogInput) => LogRecord } } {
  const store = new LogStore();
  return { store, sink: { append: (input: AppendLogInput): LogRecord => store.append(input) } };
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

function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Answers the reconcile/scale-down status queries as "nothing active" and every
// dispatch POST as accepted.
function fetchMock(dispatchResponder?: () => Response | Promise<Response>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=')) return encorePage([]);
    if (url.includes('/encoreJobs')) {
      return dispatchResponder
        ? dispatchResponder()
        : ({ ok: true, json: async () => ({ id: 'encore-uuid' }) } as unknown as Response);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedQueuedJob(
  redis: FakeRedis,
  jobId: string,
  extra?: Partial<QueuedJob>
): Promise<void> {
  const job: QueuedJob = {
    jobId,
    payload: { externalId: jobId, profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] },
    enqueuedAt: Date.now(),
    ...extra
  };
  await redis.rpush(keys.queue(WS), JSON.stringify(job));
}

async function seedInstance(
  redis: FakeRedis,
  instanceId: string,
  extra?: Partial<EncoreInstanceRecord>
): Promise<void> {
  const record: EncoreInstanceRecord = {
    instanceId,
    url: `https://${instanceId}.encore.example`,
    activeJobs: 0,
    lastIdleAt: Date.now(),
    readyAt: Date.now(),
    callbackTrustReady: true,
    ...extra
  };
  await redis.hset(keys.pool(WS), instanceId, JSON.stringify(record));
}

// Trail entries only (the #1172 phase), newest-first.
function trails(store: LogStore): string[] {
  return store.list({ q: `${SCALER_LOG_CATEGORY}/assign` }).items.map((r) => r.message);
}

describe('encore-scaler per-tick assignment trail (#1172)', () => {
  beforeEach(() => {
    spawnInstanceMock.mockReset();
    resolvePendingSpawnsMock.mockReset().mockResolvedValue(undefined);
    reapOrphanedInstancesMock.mockReset().mockResolvedValue(undefined);
    probeMock.mockReset().mockResolvedValue({ ok: true, state: 'trusted', status: 200 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('declares the new assign phase alongside the #1136 failure phases', () => {
    // The trail must be selectable on its own AND must not dilute the failure
    // phases' existing filters.
    expect(SCALER_LOG_PHASES).toContain('assign');
    for (const phase of ['spawn', 'dispatch', 'reap', 'tick']) {
      expect(SCALER_LOG_PHASES).toContain(phase);
    }
  });

  it('names the queue depth, the instance and the job it was assigned to', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    await seedQueuedJob(redis, 'job-1');
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const entries = trails(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^encore-scaler\/assign: /);
    expect(entries[0]).toContain('queueDepth=1');
    expect(entries[0]).toContain('instances=1');
    expect(entries[0]).toContain('ready=1');
    expect(entries[0]).toContain('assigned=1');
    expect(entries[0]).toContain('inst-a ready outcome=assigned');
    expect(entries[0]).toContain('jobs=job-1');
    expect(entries[0]).toContain(`[workspace=${WS}]`);
    // A normal outcome is reported at info level, never as a failure.
    const record = store.list({ q: 'outcome=assigned' }).items[0];
    expect(record?.level).toBe('info');
    expect(record?.category).toBe(SCALER_LOG_CATEGORY);
  });

  it('explains a ready second instance that got no work because the queue ran out', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    await seedInstance(redis, 'inst-b');
    await seedQueuedJob(redis, 'job-1'); // one job, two ready instances
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const entry = trails(store)[0] ?? '';
    // The exact #1168/#1172 question, answered in one line: both instances are
    // ready, one took the job, the other found nothing left to take.
    expect(entry).toContain('ready=2');
    expect(entry).toContain('assigned=1');
    expect(entry).toContain('stillQueued=0');
    expect(entry).toMatch(/inst-a ready outcome=assigned[^;]*jobs=job-1/);
    expect(entry).toContain('inst-b ready outcome=queue-empty');
  });

  it('explains an instance held back by its callback-trust probe, with the probe outcome', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a', {
      callbackTrustReady: undefined,
      callbackListenerUrl: 'https://listener-a.example'
    });
    await seedQueuedJob(redis, 'job-1');
    probeMock.mockResolvedValue({
      ok: false,
      state: 'probe-failed',
      errorClass: 'tls-trust',
      detail: 'unable to verify the first certificate'
    });
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const entry = trails(store)[0] ?? '';
    expect(entry).toContain('queueDepth=1');
    expect(entry).toContain('ready=0');
    expect(entry).toContain('assigned=0');
    expect(entry).toContain('stillQueued=1');
    expect(entry).toContain('inst-a not-ready outcome=trust-probe-pending');
    // The probe outcome per instance (#1172), not just "not ready".
    expect(entry).toContain('probe=probe-failed:tls-trust');
    // Behaviour unchanged: the job stays queued for a later tick.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(1);
  });

  it('distinguishes a draining instance and an unresolved spawn from a ready one', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-drain', { draining: true });
    await seedInstance(redis, 'inst-pending', { pendingReadySince: Date.now() });
    await seedInstance(redis, 'inst-ok');
    await seedQueuedJob(redis, 'job-1');
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    // minInstances pins the pool, so scale-down never tears the draining
    // instance down inside this tick and the dispatch step still sees all three.
    await new EncoreScalerLoop(
      makeConfig(redis, { logSink: sink, maxInstances: 3, minInstances: 3 })
    ).tick();

    const entry = trails(store)[0] ?? '';
    expect(entry).toContain('inst-drain not-ready outcome=draining');
    expect(entry).toContain('inst-pending not-ready outcome=pending-spawn');
    expect(entry).toContain('inst-ok ready outcome=assigned');
    expect(entry).toContain('instances=3');
    expect(entry).toContain('ready=1');
  });

  it('reports an instance that stopped taking work without re-reporting the #1136 failure', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    await seedQueuedJob(redis, 'job-1');
    vi.stubGlobal(
      'fetch',
      fetchMock(() => ({ ok: false, status: 503 }) as unknown as Response)
    );

    const { store, sink } = makeStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    // The trail records WHY the instance stopped...
    const entry = trails(store)[0] ?? '';
    expect(entry).toContain('inst-a ready outcome=dispatch-failed');
    expect(entry).toContain('assigned=0');
    // ...and the cause stays exactly where #1136 put it: one dispatch-phase
    // error entry, not two, and the trail is not one of them.
    const dispatchEntries = store
      .list({ q: `${SCALER_LOG_CATEGORY}/dispatch` })
      .items.map((r) => r.message);
    expect(dispatchEntries).toHaveLength(1);
    expect(dispatchEntries[0]).toContain('503');
    expect(dispatchEntries[0]).not.toContain('outcome=');
  });

  it('names a retry backoff as the reason a queued job was not assigned', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    await seedQueuedJob(redis, 'job-1', { notBefore: Date.now() + 60_000 });
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    await new EncoreScalerLoop(makeConfig(redis, { logSink: sink })).tick();

    const entry = trails(store)[0] ?? '';
    expect(entry).toContain('inst-a ready outcome=retry-backoff');
    expect(entry).toContain('stillQueued=1');
  });

  it('logs a changed picture at once and suppresses an unchanged one, with the tick count', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    vi.stubGlobal('fetch', fetchMock());

    const { store, sink } = makeStore();
    const loop = new EncoreScalerLoop(makeConfig(redis, { logSink: sink }));

    // Tick 1: idle pool, empty queue — new picture, logged.
    await loop.tick();
    expect(trails(store)).toHaveLength(1);
    // Tick 2: identical picture — not logged again (a 10s loop must not fill the
    // bounded retained window).
    await loop.tick();
    expect(trails(store)).toHaveLength(1);
    // Tick 3: a job arrives and is assigned — the picture CHANGED, so the trail
    // appears on the very tick an operator needs it.
    await seedQueuedJob(redis, 'job-1');
    await loop.tick();
    const entries = trails(store);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('outcome=assigned');
  });

  it('writes no trail at all when no log sink is configured', async () => {
    const redis = new FakeRedis();
    await seedInstance(redis, 'inst-a');
    await seedQueuedJob(redis, 'job-1');
    vi.stubGlobal('fetch', fetchMock());

    await expect(new EncoreScalerLoop(makeConfig(redis)).tick()).resolves.toBeUndefined();
    // The job was still dispatched: the trail is instrumentation only.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });
});

describe('assignment-trail formatting and suppression policy (#1172)', () => {
  const decision = (over: Partial<AssignmentDecision>): AssignmentDecision => ({
    instanceId: 'inst-a',
    ready: true,
    outcome: 'assigned',
    probe: { kind: 'confirmed-earlier' },
    assignedJobIds: ['job-1'],
    activeJobs: 0,
    capacity: 1,
    ...over
  });

  it('renders one line carrying depth, readiness, probe outcome and job ids', () => {
    const line = formatAssignmentTrail({
      queueDepth: 3,
      decisions: [
        decision({}),
        decision({
          instanceId: 'inst-b',
          ready: false,
          outcome: 'trust-probe-pending',
          probe: { kind: 'callback-unusable', detail: '401' },
          assignedJobIds: []
        })
      ]
    });
    expect(line).toContain('queueDepth=3 instances=2 ready=1 assigned=1 stillQueued=2');
    expect(line).toContain('inst-a ready outcome=assigned probe=confirmed-earlier activeJobs=0/1 jobs=job-1');
    expect(line).toContain('inst-b not-ready outcome=trust-probe-pending probe=callback-unusable:401');
    // No commercial product naming, and no raw probe detail text.
    expect(line).not.toContain('unable to verify');
  });

  it('states how many unchanged ticks a re-stated entry stands for', () => {
    const line = formatAssignmentTrail({
      queueDepth: 0,
      decisions: [decision({ outcome: 'queue-empty', assignedJobIds: [] })],
      unchangedTicks: 29
    });
    expect(line).toContain('unchanged for the previous 29 ticks');
  });

  it('fingerprints the decision picture, not the exact depth or job ids', () => {
    const a = {
      queueDepth: 12,
      decisions: [decision({ assignedJobIds: ['job-1'] })]
    };
    const b = {
      queueDepth: 7,
      decisions: [decision({ assignedJobIds: ['job-2', 'job-3'] })]
    };
    // Same answer to "why did this instance get work" => same fingerprint, so a
    // busy pool does not log on every tick.
    expect(assignmentTrailFingerprint(a)).toBe(assignmentTrailFingerprint(b));
    // A different probe outcome, readiness or outcome IS a different picture.
    expect(
      assignmentTrailFingerprint({
        queueDepth: 12,
        decisions: [decision({ probe: { kind: 'trusted-now' } })]
      })
    ).not.toBe(assignmentTrailFingerprint(a));
    expect(
      assignmentTrailFingerprint({ queueDepth: 0, decisions: a.decisions })
    ).not.toBe(assignmentTrailFingerprint(a));
  });

  it('admits a changed picture immediately and an unchanged one once per window', () => {
    const base = {
      fingerprint: 'fp-1',
      lastFingerprint: 'fp-0',
      lastLoggedAt: 1_000,
      unchangedTicks: 4,
      now: 1_500
    };
    // Changed: logged now, standing for itself only.
    expect(shouldLogAssignmentTrail(base)).toBe(0);
    // Unchanged inside the window: suppressed.
    expect(shouldLogAssignmentTrail({ ...base, lastFingerprint: 'fp-1' })).toBeUndefined();
    // Unchanged past the window: re-stated, carrying the suppressed tick count.
    expect(
      shouldLogAssignmentTrail({
        ...base,
        lastFingerprint: 'fp-1',
        now: 1_000 + ASSIGNMENT_TRAIL_REPEAT_MS
      })
    ).toBe(4);
  });

  it('maps every probe result and recorded callback-trust state to a stated outcome', () => {
    expect(describeProbeResult({ ok: true, state: 'trusted', status: 200 })).toEqual({
      kind: 'trusted-now'
    });
    expect(
      renderProbeOutcome(
        describeProbeResult({
          ok: false,
          state: 'callback-unusable',
          status: 403,
          detail: 'rejected'
        })
      )
    ).toBe('callback-unusable:403');
    expect(
      renderProbeOutcome(
        describeProbeResult({
          ok: false,
          state: 'probe-failed',
          errorClass: 'timeout',
          detail: 'probe timed out'
        })
      )
    ).toBe('probe-failed:timeout');
    // Pre-gate skips report what the record already carries — never a probe that
    // did not run.
    expect(recordedProbeOutcome({ callbackTrustReady: true }).kind).toBe('confirmed-earlier');
    expect(recordedProbeOutcome({ callbackTrustQuarantinedAt: 1 }).kind).toBe('quarantined');
    expect(
      renderProbeOutcome(
        recordedProbeOutcome({ callbackPathUnusableAt: 1, callbackPathUnusableStatus: 401 })
      )
    ).toBe('sweep-only-fallback:401');
    expect(recordedProbeOutcome({}).kind).toBe('none-to-probe');
    expect(recordedProbeOutcome({ callbackListenerUrl: 'https://l.example' }).kind).toBe(
      'not-probed'
    );
  });
});
