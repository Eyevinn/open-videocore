// @vitest-environment happy-dom
//
// Unit tests for public/job-attempts.js — the encode-attempt derivation and its
// renderer (issue #963). These are the tests the PR review for #1125 asked for:
// the implementation is unchanged, this file only pins its behaviour.
//
// The derivation is pure, so most of this file needs no DOM; renderAttemptHistory
// builds detached elements, which is why the suite still runs under happy-dom
// (same harness pragma as test/jobs-table.test.ts, test/detach-buttons.test.ts).
//
// ─── Contract grounding (CLAUDE.md rule 7 — verified, not guessed) ───────────
// Every job field asserted below was read from this repo's generated spec and
// route source before the assertions were written:
//
//   openapi.json .paths["/api/v1/jobs/{id}"].get — this spec assigns NO
//   operationId to the operation (checked: `op.operationId === undefined`), so
//   the path key + method is the citable identity. Its 200 response schema
//   (src/routes/jobs.ts:50-145, `jobSchema`) carries:
//     - status: enum ["pending","queued","running","done","failed","cancelled"]
//       — all six JOB_STATUSES members (src/data/job-repo.ts:56), confirmed
//       against openapi.json .properties.status.enum.
//     - encodeAttempts: { type: "number" } — OPTIONAL (absent from `required`);
//       the count of Encore DISPATCHES (src/routes/jobs.ts:107). Distinct from
//       `attempts` (the ingest/URL-pull counter, src/routes/jobs.ts:78), which
//       this module never reads and these tests therefore never set.
//     - encodeAttemptLog: { type: "array", items: { index: number,
//       startedAt: string, endedAt?: string,
//       classification?: enum ["transport","io-retryable","deterministic"] },
//       required ["index","startedAt"], additionalProperties: false } — verified
//       against openapi.json items schema and `encodeAttemptSchema`
//       (src/routes/jobs.ts:43-48).
//
//   There is NO backoff field anywhere on that response schema, which is why
//   `backoffMs` is derived from the gap between one attempt's endedAt and the
//   next attempt's startedAt. The "not computed" cases below exist because that
//   gap is not always knowable.

import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_CLASSIFICATION_COPY,
  JOB_STATUS_SUMMARY_COPY,
  attemptSummaryLine,
  buildAttemptTimeline,
  describeAttemptOutcome,
  hasAttemptHistory,
  humanMs,
  renderAttemptHistory,
} from '../public/job-attempts.js';

// The six JOB_STATUSES members, spelled out here rather than imported so a drift
// in the enum fails this file loudly instead of silently re-deriving itself.
const JOB_STATUSES = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'];

const T0 = '2026-03-01T10:00:00.000Z';

function at(offsetSeconds: number): string {
  return new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();
}

// A rescued transcode: attempt 1 fails on a transport blip, a 15s wait, attempt 2
// succeeds. This is the shape issue #963 exists for.
function rescuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-rescued',
    type: 'transcode',
    status: 'done',
    encodeAttempts: 2,
    encodeAttemptLog: [
      { index: 1, startedAt: at(0), endedAt: at(30), classification: 'transport' },
      { index: 2, startedAt: at(45), endedAt: at(105) },
    ],
    ...overrides,
  };
}

// ─── humanMs ─────────────────────────────────────────────────────────────────

describe('humanMs', () => {
  it('floors to whole units and singularises exactly one', () => {
    expect(humanMs(0)).toBe('0 seconds');
    expect(humanMs(1000)).toBe('1 second');
    expect(humanMs(1999)).toBe('1 second');
    expect(humanMs(90_000)).toBe('1 minute');
    expect(humanMs(3 * 60_000)).toBe('3 minutes');
    expect(humanMs(60 * 60_000)).toBe('1 hour');
    expect(humanMs(25 * 60 * 60_000)).toBe('1 day');
  });

  it('returns undefined for non-finite or negative input', () => {
    expect(humanMs(-1)).toBeUndefined();
    expect(humanMs(Number.NaN)).toBeUndefined();
    expect(humanMs(undefined)).toBeUndefined();
    expect(humanMs('not a number')).toBeUndefined();
  });
});

// ─── buildAttemptTimeline: outcomes ──────────────────────────────────────────

describe('buildAttemptTimeline — outcomes', () => {
  it('returns an empty array when the job carries no attempt log', () => {
    expect(buildAttemptTimeline(undefined)).toEqual([]);
    expect(buildAttemptTimeline(null)).toEqual([]);
    expect(buildAttemptTimeline({ id: 'j' })).toEqual([]);
    // A non-array value on the field must not throw either.
    expect(buildAttemptTimeline({ encodeAttemptLog: 'nope' })).toEqual([]);
  });

  it("marks an attempt with a classification as 'failed' and carries operator copy", () => {
    const rows = buildAttemptTimeline(rescuedJob());
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].classification).toBe('transport');
    expect(rows[0].classificationCopy).toBe(ATTEMPT_CLASSIFICATION_COPY.transport);
  });

  it("marks the LAST attempt of a done job as 'succeeded'", () => {
    const rows = buildAttemptTimeline(rescuedJob());
    expect(rows[1].outcome).toBe('succeeded');
    expect(rows[1].classification).toBeUndefined();
  });

  it("marks an attempt with no endedAt as 'open' regardless of job status", () => {
    const rows = buildAttemptTimeline({
      status: 'running',
      encodeAttemptLog: [{ index: 1, startedAt: at(0) }],
    });
    expect(rows[0].outcome).toBe('open');
    expect(rows[0].endedAt).toBeUndefined();
  });

  it("marks an ended, unclassified attempt on a NON-done job as 'ended', not 'succeeded'", () => {
    // `failed` job whose last attempt recorded endedAt but no classification: the
    // contract records no failure class, so the UI must not claim success.
    const rows = buildAttemptTimeline({
      status: 'failed',
      encodeAttemptLog: [{ index: 1, startedAt: at(0), endedAt: at(10) }],
    });
    expect(rows[0].outcome).toBe('ended');
  });

  it("marks a non-last ended attempt as 'ended' even when the job is done", () => {
    const rows = buildAttemptTimeline({
      status: 'done',
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(10) },
        { index: 2, startedAt: at(20), endedAt: at(30) },
      ],
    });
    expect(rows.map((r) => r.outcome)).toEqual(['ended', 'succeeded']);
  });

  it('prefers a classification over any end-state inference', () => {
    // endedAt present AND last AND job done — classification still wins.
    const rows = buildAttemptTimeline({
      status: 'done',
      encodeAttemptLog: [{ index: 1, startedAt: at(0), endedAt: at(5), classification: 'deterministic' }],
    });
    expect(rows[0].outcome).toBe('failed');
  });

  it('falls back to the raw classification string for a class this UI does not know', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [{ index: 1, startedAt: at(0), endedAt: at(5), classification: 'future-class' }],
    });
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].classificationCopy).toBe('future-class');
  });

  it('preserves dispatch order and the server-recorded index, filling it in when absent', () => {
    const rows = buildAttemptTimeline({
      // Deliberately out of numeric order: the log is append-only and already
      // ordered (src/routes/jobs.ts:109-112), so it must NOT be re-sorted.
      encodeAttemptLog: [{ index: 7, startedAt: at(0) }, { startedAt: at(10) }, null],
    });
    expect(rows.map((r) => r.index)).toEqual([7, 2, 3]);
    expect(rows[2].startedAt).toBeUndefined();
  });
});

// ─── buildAttemptTimeline: durationMs ────────────────────────────────────────

describe('buildAttemptTimeline — durationMs', () => {
  it('is endedAt − startedAt when both ends are known', () => {
    const rows = buildAttemptTimeline(rescuedJob());
    expect(rows[0].durationMs).toBe(30_000);
    expect(rows[1].durationMs).toBe(60_000);
  });

  it('is undefined while the attempt is still open', () => {
    const rows = buildAttemptTimeline({ encodeAttemptLog: [{ index: 1, startedAt: at(0) }] });
    expect(rows[0].durationMs).toBeUndefined();
  });

  it('is undefined for an unparseable or backwards pair', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [
        { index: 1, startedAt: 'not-a-date', endedAt: at(10) },
        { index: 2, startedAt: at(60), endedAt: at(30) },
      ],
    });
    expect(rows[0].durationMs).toBeUndefined();
    expect(rows[1].durationMs).toBeUndefined();
  });

  it('is zero (not undefined) for an attempt that started and ended on the same instant', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [{ index: 1, startedAt: at(0), endedAt: at(0) }],
    });
    expect(rows[0].durationMs).toBe(0);
  });
});

// ─── buildAttemptTimeline: derived backoffMs ─────────────────────────────────

describe('buildAttemptTimeline — derived backoffMs', () => {
  it('is the observed gap between this attempt ending and the next starting', () => {
    const rows = buildAttemptTimeline(rescuedJob());
    expect(rows[0].backoffMs).toBe(15_000);
  });

  it('is NOT computed for the last row — there is no next dispatch', () => {
    const rows = buildAttemptTimeline(rescuedJob());
    expect(rows[1].backoffMs).toBeUndefined();
  });

  it('is NOT computed when this attempt has no endedAt — one end of the gap is unknown', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [
        { index: 1, startedAt: at(0) },
        { index: 2, startedAt: at(45) },
      ],
    });
    expect(rows[0].backoffMs).toBeUndefined();
  });

  it('is NOT computed when the next attempt has no parseable startedAt', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(30) },
        { index: 2, startedAt: 'nonsense' },
      ],
    });
    expect(rows[0].backoffMs).toBeUndefined();
  });

  it('is NOT computed for a backwards gap (next dispatch stamped before this end)', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(60) },
        { index: 2, startedAt: at(30) },
      ],
    });
    expect(rows[0].backoffMs).toBeUndefined();
  });

  it('is zero for a back-to-back re-dispatch with no observable wait', () => {
    const rows = buildAttemptTimeline({
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(30) },
        { index: 2, startedAt: at(30) },
      ],
    });
    expect(rows[0].backoffMs).toBe(0);
  });
});

// ─── hasAttemptHistory ───────────────────────────────────────────────────────

describe('hasAttemptHistory', () => {
  it('is true only when more than one dispatch was recorded', () => {
    expect(hasAttemptHistory(rescuedJob())).toBe(true);
    expect(hasAttemptHistory({ encodeAttemptLog: [{ index: 1, startedAt: at(0) }] })).toBe(false);
    expect(hasAttemptHistory({ encodeAttemptLog: [] })).toBe(false);
    expect(hasAttemptHistory({})).toBe(false);
    expect(hasAttemptHistory(null)).toBe(false);
  });
});

// ─── attemptSummaryLine ──────────────────────────────────────────────────────

describe('attemptSummaryLine — suppression', () => {
  it('is suppressed when encodeAttempts <= 1 (a first-time success is never annotated)', () => {
    expect(attemptSummaryLine(rescuedJob({ encodeAttempts: 1 }))).toBeUndefined();
    expect(attemptSummaryLine(rescuedJob({ encodeAttempts: 0 }))).toBeUndefined();
  });

  it('is suppressed when encodeAttempts is absent or not a number (an OPTIONAL field)', () => {
    expect(attemptSummaryLine({ status: 'done' })).toBeUndefined();
    expect(attemptSummaryLine(rescuedJob({ encodeAttempts: undefined }))).toBeUndefined();
    expect(attemptSummaryLine(rescuedJob({ encodeAttempts: '2' }))).toBeUndefined();
    expect(attemptSummaryLine(null)).toBeUndefined();
  });
});

describe('attemptSummaryLine — one line per JOB_STATUSES member', () => {
  it('covers every status in the enum with its own closing claim', () => {
    // Guards against a status silently inheriting another state's sentence.
    expect(Object.keys(JOB_STATUS_SUMMARY_COPY).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it('pending: dispatch facts + still in progress', () => {
    expect(attemptSummaryLine(rescuedJob({ status: 'pending' }))).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — still in progress.'
    );
  });

  it('queued: dispatch facts + still in progress', () => {
    expect(attemptSummaryLine(rescuedJob({ status: 'queued' }))).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — still in progress.'
    );
  });

  it('running: dispatch facts + still in progress', () => {
    expect(attemptSummaryLine(rescuedJob({ status: 'running' }))).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — still in progress.'
    );
  });

  it('done: names the attempt it recovered on when the log records one', () => {
    expect(attemptSummaryLine(rescuedJob())).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — recovered on attempt 2.'
    );
  });

  it('done: falls back to the dispatch COUNT when there is no attempt log to name', () => {
    // encodeAttempts is a count, not an attempt index — claiming "recovered on
    // attempt N" from it would be unevidenced.
    expect(attemptSummaryLine({ status: 'done', encodeAttempts: 3 })).toBe(
      'Dispatched to Encore 3 times — recovered after 3 dispatches.'
    );
  });

  it('failed: says the job then failed', () => {
    expect(attemptSummaryLine(rescuedJob({ status: 'failed' }))).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — the job then failed.'
    );
  });

  it('cancelled: says cancelled, never in-flight', () => {
    const line = attemptSummaryLine(rescuedJob({ status: 'cancelled' }));
    expect(line).toBe(
      'Dispatched to Encore 2 times, 1 attempt failed (transport) — the job was cancelled.'
    );
    expect(line).not.toContain('in progress');
  });

  it('pluralises the failure count and de-duplicates the classification list', () => {
    const job = {
      status: 'failed',
      encodeAttempts: 3,
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(10), classification: 'transport' },
        { index: 2, startedAt: at(20), endedAt: at(30), classification: 'transport' },
        { index: 3, startedAt: at(40), endedAt: at(50), classification: 'deterministic' },
      ],
    };
    expect(attemptSummaryLine(job)).toBe(
      'Dispatched to Encore 3 times, 3 attempts failed (transport, deterministic) — the job then failed.'
    );
  });

  it('omits the failure clause when no attempt recorded a classification', () => {
    expect(
      attemptSummaryLine({
        status: 'running',
        encodeAttempts: 2,
        encodeAttemptLog: [
          { index: 1, startedAt: at(0), endedAt: at(10) },
          { index: 2, startedAt: at(20) },
        ],
      })
    ).toBe('Dispatched to Encore 2 times — still in progress.');
  });
});

describe('attemptSummaryLine — own-property guard', () => {
  it("does not resolve an inherited Object.prototype member for status 'constructor'", () => {
    const line = attemptSummaryLine(rescuedJob({ status: 'constructor' }));
    // States the dispatch facts and stops: no closing claim, no stringified
    // function body leaking into operator-facing copy.
    expect(line).toBe('Dispatched to Encore 2 times, 1 attempt failed (transport).');
    expect(line).not.toContain('function');
    expect(line).not.toContain('Object');
  });

  it('also holds for other inherited names and for an unknown future status', () => {
    for (const status of ['toString', 'hasOwnProperty', '__proto__', 'archived']) {
      const line = attemptSummaryLine(rescuedJob({ status }));
      expect(line).toBe('Dispatched to Encore 2 times, 1 attempt failed (transport).');
    }
  });
});

// ─── describeAttemptOutcome ──────────────────────────────────────────────────

describe('describeAttemptOutcome', () => {
  it('labels each outcome and only invents detail where the contract supports it', () => {
    expect(describeAttemptOutcome({ outcome: 'failed', classificationCopy: 'boom' })).toEqual({
      label: 'Failed',
      detail: 'boom',
    });
    expect(describeAttemptOutcome({ outcome: 'open' })).toEqual({
      label: 'In flight',
      detail: 'Dispatched; no end recorded yet.',
    });
    expect(describeAttemptOutcome({ outcome: 'succeeded' })).toEqual({
      label: 'Succeeded',
      detail: undefined,
    });
    expect(describeAttemptOutcome({ outcome: 'ended' })).toEqual({
      label: 'Ended',
      detail: 'No failure recorded for this attempt.',
    });
    expect(describeAttemptOutcome(undefined)).toEqual({ label: '—', detail: undefined });
  });
});

// ─── renderAttemptHistory ────────────────────────────────────────────────────

describe('renderAttemptHistory', () => {
  it('returns null for a single-attempt job, so the caller appends no empty heading', () => {
    const single = {
      status: 'done',
      encodeAttempts: 1,
      encodeAttemptLog: [{ index: 1, startedAt: at(0), endedAt: at(60) }],
    };
    expect(renderAttemptHistory(single)).toBeNull();
  });

  it('returns null for a job with no attempt information at all', () => {
    expect(renderAttemptHistory({ id: 'job-1', status: 'running' })).toBeNull();
  });

  it('renders the summary line alone when the count says retried but no log was recorded', () => {
    const el = renderAttemptHistory({ status: 'done', encodeAttempts: 2 });
    expect(el).not.toBeNull();
    expect(el!.querySelector('[data-attempt-summary]')!.textContent).toBe(
      'Dispatched to Encore 2 times — recovered after 2 dispatches.'
    );
    // No table: there are no rows to compare.
    expect(el!.querySelector('table')).toBeNull();
  });

  it('emits a real table with a <caption> and scoped column headers', () => {
    const el = renderAttemptHistory(rescuedJob())!;
    const table = el.querySelector('table')!;

    const caption = table.querySelector('caption')!;
    expect(caption).not.toBeNull();
    expect(caption.textContent).toBe('Encore dispatch attempts for this job, in dispatch order');

    const colHeaders = Array.from(table.querySelectorAll('thead th'));
    expect(colHeaders.map((th) => th.textContent)).toEqual([
      'Attempt',
      'Started',
      'Ran for',
      'Outcome',
    ]);
    // WCAG 2.1 SC 1.3.1: every header declares its scope.
    for (const th of colHeaders) expect(th.getAttribute('scope')).toBe('col');

    // Each row's attempt number is a row header, not a plain cell.
    const rowHeaders = Array.from(table.querySelectorAll('tbody th'));
    expect(rowHeaders).toHaveLength(2);
    for (const th of rowHeaders) expect(th.getAttribute('scope')).toBe('row');
    expect(rowHeaders.map((th) => th.textContent)).toEqual(['#1', '#2']);
  });

  it('renders one row per recorded dispatch, keyed by the attempt index', () => {
    const el = renderAttemptHistory(rescuedJob())!;
    const rows = Array.from(el.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(rows.map((tr) => tr.getAttribute('data-attempt-index'))).toEqual(['1', '2']);
  });

  it('shows the failure copy, the observed wait, and the duration per row', () => {
    const el = renderAttemptHistory(rescuedJob())!;
    const [first, second] = Array.from(el.querySelectorAll('tbody tr'));

    expect(first.querySelector('.attempt-outcome-failed')!.textContent).toBe('Failed');
    expect(first.textContent).toContain(ATTEMPT_CLASSIFICATION_COPY.transport);
    expect(first.querySelector('.attempt-backoff')!.textContent).toBe(
      'Waited 15 seconds before the next attempt.'
    );
    expect(first.textContent).toContain('30 seconds');

    expect(second.querySelector('.attempt-outcome-succeeded')!.textContent).toBe('Succeeded');
    // Last row: no next dispatch, so no observed-wait line.
    expect(second.querySelector('.attempt-backoff')).toBeNull();
    expect(second.textContent).toContain('1 minute');
  });

  it('uses an em-dash for an attempt whose duration is unknown', () => {
    const el = renderAttemptHistory({
      status: 'running',
      encodeAttempts: 2,
      encodeAttemptLog: [
        { index: 1, startedAt: at(0), endedAt: at(10) },
        { index: 2, startedAt: at(20) },
      ],
    })!;
    const cells = Array.from(el.querySelectorAll('tbody tr')[1].querySelectorAll('td'));
    expect(cells[1].textContent).toBe('—');
    expect(el.textContent).toContain('In flight');
  });

  it('formats timestamps with the caller-supplied fmtDate', () => {
    const seen: unknown[] = [];
    const el = renderAttemptHistory(rescuedJob(), {
      fmtDate: (v: unknown) => {
        seen.push(v);
        return 'FMT:' + String(v);
      },
    })!;
    expect(seen).toEqual([at(0), at(45)]);
    expect(el.textContent).toContain('FMT:' + at(0));
  });

  it('writes server strings as text, never as markup', () => {
    const el = renderAttemptHistory({
      status: 'failed',
      encodeAttempts: 2,
      encodeAttemptLog: [
        {
          index: 1,
          startedAt: at(0),
          endedAt: at(10),
          classification: '<img src=x onerror=alert(1)>',
        },
        { index: 2, startedAt: at(20), endedAt: at(30), classification: 'deterministic' },
      ],
    })!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('titles the section and stays detached until the caller appends it', () => {
    const el = renderAttemptHistory(rescuedJob())!;
    expect(el.querySelector('.section-title')!.textContent).toBe('Encode attempts');
    expect(el.parentNode).toBeNull();
  });
});
