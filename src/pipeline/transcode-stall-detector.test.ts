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
  MIN_ARMED_PROGRESS,
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

// Review follow-up on #1318: a stall report is not advisory — it cancels the
// attempt and re-dispatches, and it reproduces itself on every attempt, so a
// healthy job misread as stalled becomes a GUARANTEED terminal `failed` once
// MAX_ENCODE_ATTEMPTS is exhausted. These pin the two guards that keep a
// slow-but-healthy encode out of that path.
describe('progress floor: the analyze window is not a freeze (#1218 review)', () => {
  it('never reports a job that has not reported any progress, however long it sits', () => {
    const state = tracker();
    const t0 = 6_000_000;
    const seen: StalledTranscode[] = [];
    // Encore's `progress` is declared `default: 0`, so an IN_PROGRESS job that
    // has not emitted a number yet — exactly what the pre-encode analyze step
    // looks like from here — reads as 0 for its whole duration. Ten full bounds
    // of that must not produce a single report.
    for (let tick = 0; tick < 10; tick++) {
      seen.push(
        ...recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 0 }], {
          now: t0 + tick * (TIMEOUT_MS + 1_000),
          stallTimeoutMs: TIMEOUT_MS
        })
      );
    }
    expect(seen).toEqual([]);
  });

  it('does not arm a clock at all for a sub-floor sample', () => {
    const state = tracker();
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 0 }], {
      now: 7_000_000,
      stallTimeoutMs: TIMEOUT_MS
    });
    // No entry means the long analyze window cannot later be counted as elapsed
    // stall time against the first real sample.
    expect(state.size).toBe(0);
  });

  it('arms the clock on the first sample at or above the floor, measured from THAT sample', () => {
    const state = tracker();
    const t0 = 8_000_000;
    // A long analyze window at 0 …
    for (let tick = 0; tick < 5; tick++) {
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 0 }], {
        now: t0 + tick * TIMEOUT_MS,
        stallTimeoutMs: TIMEOUT_MS
      });
    }
    // … then the encode starts. The clock starts HERE, not at t0.
    const armedAt = t0 + 5 * TIMEOUT_MS;
    expect(
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: MIN_ARMED_PROGRESS }], {
        now: armedAt,
        stallTimeoutMs: TIMEOUT_MS
      })
    ).toEqual([]);
    expect(state.get(EXTERNAL_ID)).toMatchObject({
      progress: MIN_ARMED_PROGRESS,
      advancedAt: armedAt
    });
    // Still within one bound OF THE ARM: not stalled, even though far more than
    // one bound has passed since the job first appeared.
    expect(
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: MIN_ARMED_PROGRESS }], {
        now: armedAt + TIMEOUT_MS,
        stallTimeoutMs: TIMEOUT_MS
      })
    ).toEqual([]);
  });

  it('still reports a genuine freeze once the encode has started', () => {
    const state = tracker();
    const t0 = 9_000_000;
    // The floor must not disable detection: a job that reached 1% and then froze
    // is the real #1218 defect and has to be reported.
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 1 }], {
      now: t0,
      stallTimeoutMs: TIMEOUT_MS
    });
    const stalls = recordProgressAndDetectStalls(
      state,
      [{ externalId: EXTERNAL_ID, progress: 1 }],
      { now: t0 + TIMEOUT_MS + 1, stallTimeoutMs: TIMEOUT_MS }
    );
    expect(stalls.map((s) => s.encoreJobId)).toEqual([EXTERNAL_ID]);
  });

  it('ignores a sub-floor sample without disturbing an already-armed clock', () => {
    const state = tracker();
    const t0 = 9_500_000;
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 40 }], {
      now: t0,
      stallTimeoutMs: TIMEOUT_MS
    });
    // A spurious 0 (an unreported value re-read as the schema default) must not
    // count as "progress changed" and reset the stall clock — that would be a
    // false NEGATIVE, hiding a real freeze.
    recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 0 }], {
      now: t0 + 1_000,
      stallTimeoutMs: TIMEOUT_MS
    });
    expect(state.get(EXTERNAL_ID)).toMatchObject({ progress: 40, advancedAt: t0 });
    expect(
      recordProgressAndDetectStalls(state, [{ externalId: EXTERNAL_ID, progress: 40 }], {
        now: t0 + TIMEOUT_MS + 1,
        stallTimeoutMs: TIMEOUT_MS
      }).map((s) => s.encoreJobId)
    ).toEqual([EXTERNAL_ID]);
  });

  it('defaults the bound high enough that a one-percent step cannot trip it', () => {
    // The bound is derived from the reporting granularity: Encore reports INTEGER
    // percent, so a healthy job holds one value for at most total/100. A bound of
    // B therefore only misfires on an encode longer than 100 x B. Pin that the
    // default tolerates an encode far longer than anything this API dispatches.
    const longestToleratedEncodeMs = DEFAULT_TRANSCODE_STALL_TIMEOUT_MS * 100;
    const ninetySixHoursMs = 96 * 60 * 60_000;
    expect(longestToleratedEncodeMs).toBeGreaterThan(ninetySixHoursMs);
    // And still bounded: a hang cannot cost more than one bound per attempt.
    expect(DEFAULT_TRANSCODE_STALL_TIMEOUT_MS).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(MIN_ARMED_PROGRESS).toBeGreaterThan(0);
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

  // Review follow-up on #1318: the same false positive, seen end-to-end through
  // the sweep rather than against the detector directly.
  it('stays silent across many bounds while Encore reports progress 0', async () => {
    const raised: StalledTranscode[] = [];
    const deps = makeDeps(async (stalls) => {
      raised.push(...stalls);
    });
    // A job in its pre-encode analyze window: IN_PROGRESS on the page, progress
    // still at the schema default of 0.
    vi.stubGlobal('fetch', makeFetch(() => [{ externalId: EXTERNAL_ID, progress: 0 }]));
    try {
      let now = 10_000_000;
      for (let tick = 0; tick < 6; tick++) {
        await syncInProgressJobProgress(deps, INSTANCE_RECORD, 'test-sat', {
          pageSize: 100,
          now: () => now
        });
        now += TIMEOUT_MS + 60_000;
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(raised).toEqual([]);
  });
});
