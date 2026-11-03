// Transcode stall detection (issue #1218).
//
// The defect: a source connection dropped mid-encode can freeze the Encore job's
// ffmpeg SILENTLY — progress stops advancing, no error is raised, Encore keeps
// reporting IN_PROGRESS and our Job record stays `running` forever, so no retry
// ever fires. The same drop sometimes errors fast ("Stream ends prematurely …")
// and IS retried (#727); only the silent hang had no observer.
//
// These tests pin both halves of the fix:
//   1. the detector reports a job whose progress is frozen past the bound, and
//      does NOT report a job that is still moving (or one that is merely within
//      the bound / seen for the first time);
//   2. the text it synthesizes lands on the EXISTING retry path — it classifies
//      retryable through the same classifyEncoreFailure/isRetryableFailureClass
//      the fast-error case uses, rather than through a parallel policy;
//   3. the poller's IN_PROGRESS sweep raises a stall through the
//      onTranscodeStalled hook (which main.ts wires to the SAME handler the
//      scaler's onJobsDropped uses) and stays silent while progress advances.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7):
//   - `EntityModelEncoreJob.progress` (int32, default 0, "The EncoreJob
//     progress") and `EntityModelEncoreJob.externalId` ("External id - for
//     external backreference") on `PagedModelEntityModelEncoreJob` returned by
//     `GET /encoreJobs/search/findByStatus?status=IN_PROGRESS` (operationId
//     `executeSearch-encorejob-get`) — Encore's own OpenAPI document as recorded
//     in src/pipeline/encore-callback-poller.ts:1269-1288.
//   - `classifyEncoreFailure(message): MessageFailureClass` and
//     `isRetryableFailureClass(cls): boolean` — src/encore-scaler/retry-policy.ts.
//   - `DroppedJob = { encoreJobId: string; reason?: string }` —
//     src/encore-scaler/types.ts:45, the shape main.ts's
//     settleOrRetryEncoreJobDrops consumes.
//   - `syncInProgressJobProgress(deps, record, sat, { pageSize, now })` —
//     src/pipeline/encore-callback-poller.ts.
//   - `EncoreInstanceRecord` — src/encore-scaler/types.ts.

import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_TRANSCODE_STALL_TIMEOUT_MS,
  buildStallFailureMessage,
  recordProgressAndDetectStalls,
  type StallTrackerEntry,
  type StalledTranscode
} from './transcode-stall-detector.js';
import {
  classifyEncoreFailure,
  isRetryableFailureClass,
  TRANSCODE_STALL_SIGNATURE
} from '../encore-scaler/retry-policy.js';
import { syncInProgressJobProgress, type PollerDeps } from './encore-callback-poller.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import type { EncoreInstanceRecord } from '../encore-scaler/types.js';

const TIMEOUT_MS = 10 * 60_000;
const EXTERNAL_ID = 'ws-stall__job-stall';

function tracker(): Map<string, StallTrackerEntry> {
  return new Map();
}

describe('transcode stall detector (#1218)', () => {
  it('does not report a job on first sight (no evidence about the past)', () => {
    const state = tracker();
    const stalls = recordProgressAndDetectStalls(
      state,
      [{ externalId: EXTERNAL_ID, progress: 42 }],
      { now: 1_000, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(stalls).toEqual([]);
    expect(state.get(EXTERNAL_ID)).toMatchObject({ progress: 42, advancedAt: 1_000 });
  });

  it('reports a job whose progress has been frozen past the timeout', () => {
    const state = tracker();
    const t0 = 1_000_000;
    // Frozen at 42% from t0 onwards.
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 42 }], {
      now: t0,
      stallTimeoutMs: TIMEOUT_MS
    });
    // Still 42% just inside the bound: not yet stalled.
    expect(
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 42 }], {
        now: t0 + TIMEOUT_MS,
        stallTimeoutMs: TIMEOUT_MS
      })
    ).toEqual([]);
    // Still 42% past the bound: stalled.
    const stalls = recordProgressAndDetectStalls(
      state,
      [{ externalId: EXTERNAL_ID, progress: 42 }],
      { now: t0 + TIMEOUT_MS + 1_000, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(stalls.map((s) => s.encoreJobId)).toEqual([EXTERNAL_ID]);
    expect(stalls[0]!.reason).toContain(TRANSCODE_STALL_SIGNATURE);
    expect(stalls[0]!.reason).toContain('42%');
  });

  it('never reports a job that keeps making progress, however long it runs', () => {
    const state = tracker();
    let now = 500_000;
    const seen: StalledTranscode[] = [];
    // One percent per full timeout window, for twenty windows — a legitimately
    // slow but healthy encode. The clock resets on every advance, so no sample
    // may ever be reported stalled.
    for (let progress = 1; progress <= 20; progress++) {
      now += TIMEOUT_MS + 5_000;
      seen.push(
        ...recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress }], {
          now,
          stallTimeoutMs: TIMEOUT_MS
        })
      );
    }
    expect(seen).toEqual([]);
  });

  it('resets the clock when progress advances after a long pause', () => {
    const state = tracker();
    const t0 = 2_000_000;
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 10 }], {
      now: t0,
      stallTimeoutMs: TIMEOUT_MS
    });
    // Advanced right before the bound would have expired.
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 11 }], {
      now: t0 + TIMEOUT_MS - 1,
      stallTimeoutMs: TIMEOUT_MS
    });
    // Unchanged again, but measured from the ADVANCE, not from t0.
    expect(
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 11 }], {
        now: t0 + TIMEOUT_MS + 10_000,
        stallTimeoutMs: TIMEOUT_MS
      })
    ).toEqual([]);
  });

  it('reports one hang once, not on every sweep tick', () => {
    const state = tracker();
    const t0 = 3_000_000;
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 7 }], {
      now: t0,
      stallTimeoutMs: TIMEOUT_MS
    });
    const first = recordProgressAndDetectStalls(
      state,
      [{ externalId: EXTERNAL_ID, progress: 7 }],
      { now: t0 + TIMEOUT_MS + 1, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(first).toHaveLength(1);
    // The next tick re-starts the clock (rule 1), so the same hang is not raised
    // again immediately.
    const second = recordProgressAndDetectStalls(
      state,
      [{ externalId: EXTERNAL_ID, progress: 7 }],
      { now: t0 + TIMEOUT_MS + 2, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(second).toEqual([]);
  });

  it('ignores samples with no usable progress number', () => {
    const state = tracker();
    const stalls = recordProgressAndDetectStalls(
      state,
      [
        { externalId: '', progress: 5 },
        { externalId: EXTERNAL_ID, progress: Number.NaN }
      ],
      { now: 10, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(stalls).toEqual([]);
    expect(state.size).toBe(0);
  });

  it('has a positive default bound well above a sweep interval', () => {
    expect(DEFAULT_TRANSCODE_STALL_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});

describe('stall failure text feeds the EXISTING retry policy (#1218 / #727)', () => {
  it('classifies as a retryable failure class, like the fast-error path', () => {
    const message = buildStallFailureMessage({
      progress: 42,
      stalledForMs: TIMEOUT_MS + 1_000,
      stallTimeoutMs: TIMEOUT_MS
    });
    const cls = classifyEncoreFailure(message);
    expect(cls).toBe('transport');
    expect(isRetryableFailureClass(cls)).toBe(true);
    // Same verdict for the fast-error signature the retry path already handles,
    // so the two converge on one bounded-retry policy.
    expect(isRetryableFailureClass(classifyEncoreFailure('Stream ends prematurely'))).toBe(true);
  });

  it('still classifies retryable once main.ts prefixes the drop wording', () => {
    // src/main.ts settleOrRetryEncoreJobDrops builds
    // `dropped by Encore: ${reason}` before calling decideRetry, and the
    // classifier matches on a case-insensitive substring, so the prefix must not
    // change the verdict.
    const message = `dropped by Encore: ${buildStallFailureMessage({
      progress: 3,
      stalledForMs: TIMEOUT_MS * 2,
      stallTimeoutMs: TIMEOUT_MS
    })}`;
    expect(isRetryableFailureClass(classifyEncoreFailure(message))).toBe(true);
  });

  it('leaves an unrelated deterministic failure deterministic', () => {
    expect(classifyEncoreFailure('Could not find location for profile program!')).toBe(
      'deterministic'
    );
  });
});

const INSTANCE_RECORD: EncoreInstanceRecord = {
  instanceId: 'inst-stall',
  url: 'https://encore-stall.example',
  activeJobs: 1,
  lastIdleAt: 0
};

// Answer findByStatus: the IN_PROGRESS page returns the supplied documents, any
// other status an empty page. Same stub shape as encore-progress-sweep.test.ts.
function makeFetch(inProgress: () => Array<{ externalId: string; progress?: number }>) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const jobs = url.includes('status=IN_PROGRESS') ? inProgress() : [];
    return {
      ok: true,
      status: 200,
      async json() {
        return { _embedded: { encoreJobs: jobs }, page: { totalElements: jobs.length } };
      }
    } as unknown as Response;
  });
}

// Only the surface syncInProgressJobProgress touches. The local job deliberately
// does not exist in the repository: the progress WRITE then no-ops, which isolates
// the stall observation (built from the Encore samples alone) from the #830 write
// path this test is not about.
function makeDeps(onTranscodeStalled: PollerDeps['onTranscodeStalled']): PollerDeps {
  return {
    jobRepository: new InMemoryJobRepository(),
    logger: { info() {}, warn() {}, error() {} },
    transcodeStallTimeoutMs: TIMEOUT_MS,
    onTranscodeStalled
  } as unknown as PollerDeps;
}

describe('IN_PROGRESS sweep raises a stalled transcode (#1218)', () => {
  it('routes a frozen job to the failure/retry hook with a retryable reason', async () => {
    const raised: StalledTranscode[] = [];
    const deps = makeDeps(async (stalls) => {
      raised.push(...stalls);
    });
    vi.stubGlobal('fetch', makeFetch(() => [{ externalId: EXTERNAL_ID, progress: 42 }]));
    try {
      const t0 = 4_000_000;
      await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'test-sat', {
        pageSize: 100,
        now: () => t0
      });
      expect(raised).toEqual([]);
      await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'test-sat', {
        pageSize: 100,
        now: () => t0 + TIMEOUT_MS + 1_000
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(raised).toHaveLength(1);
    expect(raised[0]!.encoreJobId).toBe(EXTERNAL_ID);
    // The hook's payload is DroppedJob-shaped, and its reason must reach the
    // retryable class so decideRetry re-dispatches instead of hanging.
    expect(isRetryableFailureClass(classifyEncoreFailure(raised[0]!.reason))).toBe(true);
  });

  it('does not raise a job that is still advancing', async () => {
    const raised: StalledTranscode[] = [];
    const deps = makeDeps(async (stalls) => {
      raised.push(...stalls);
    });
    let progress = 10;
    vi.stubGlobal('fetch', makeFetch(() => [{ externalId: EXTERNAL_ID, progress }]));
    try {
      let now = 5_000_000;
      for (let tick = 0; tick < 5; tick++) {
        await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'test-sat', {
          pageSize: 100,
          now: () => now
        });
        now += TIMEOUT_MS + 30_000;
        progress += 1;
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(raised).toEqual([]);
  });
});
