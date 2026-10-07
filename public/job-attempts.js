/**
 * open-videocore ops dashboard — job-attempts.js
 *
 * Issue #963: make a RESCUED transcode run readable without opening the raw
 * JSON. A job that failed once on a transient transport blip, waited out a
 * backoff and succeeded on the next dispatch used to look exactly like a plain
 * slow success in the detail panel — the evidence was in `encodeAttemptLog`,
 * which only an operator reading JSON ever saw.
 *
 * This module is the pure derivation (what the attempts say) plus one renderer
 * (how it reads). Pure so a unit test can assert the derivation without a DOM
 * or a network call, and so the wording lives in exactly one place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * Every field read below was verified against the live route source and the
 * generated spec in this repo — none is guessed.
 *
 * `GET /api/v1/jobs/{id}` — openapi.json:15658 (path key "/api/v1/jobs/{id}",
 * method `get`; this spec assigns no operationId to the operation). Its 200
 * response schema is `jobSchema`, src/routes/jobs.ts:50-145. Fields used here:
 *
 *   encodeAttempts?: number           src/routes/jobs.ts:107  | openapi.json:15751
 *       Count of Encore DISPATCHES of a transcode job (1 on the first dispatch,
 *       incremented per re-dispatch). OPTIONAL — absent until a dispatch is
 *       recorded. Explicitly DISTINCT from `attempts` (src/routes/jobs.ts:78),
 *       which counts ingest/URL-pull attempts, and which this module never
 *       reads.
 *
 *   encodeAttemptLog?: EncodeAttempt[] src/routes/jobs.ts:112  | openapi.json:15754
 *       Append-only, in dispatch order.
 *
 *   EncodeAttempt                      src/routes/jobs.ts:43-48 (`encodeAttemptSchema`)
 *                                      src/data/job-repo.ts:43-48 (the type)
 *                                      openapi.json:15754-15779 (items schema)
 *       { index: number;              REQUIRED
 *         startedAt: string;          REQUIRED (ISO; stamped at dispatch)
 *         endedAt?: string;           optional (stamped on completion)
 *         classification?: 'transport' | 'io-retryable' | 'deterministic' }
 *       `classification` is the MESSAGE-DERIVED failure class only
 *       (`MessageFailureClass`, src/encore-scaler/retry-policy.ts:96; mirrored
 *       as `FAILURE_CLASSES` with a compile-time drift guard at
 *       src/routes/jobs.ts:30-39). 'interrupted_by_scaledown' is deliberately
 *       NOT in this enum (src/data/job-repo.ts:39-42), so it is not handled as
 *       an attempt classification here.
 *
 *   status: 'pending'|'queued'|'running'|'done'|'failed'|'cancelled'
 *       All six members of JOB_STATUSES (src/data/job-repo.ts:56), surfaced by
 *       `jobSchema` as `z.enum(JOB_STATUSES)` (src/routes/jobs.ts:53) and by the
 *       GET /api/v1/jobs/{id} 200 schema (openapi.json:15691-15698). Three are
 *       terminal — `done`, `failed`, `cancelled` (TERMINAL_JOB_STATUSES,
 *       src/data/job-repo.ts:64) — and three are active: `pending`, `queued`,
 *       `running` (ACTIVE_JOB_STATUSES, src/data/job-repo.ts:65-67).
 *
 * WHAT "SUCCEEDED" MEANS ON AN ATTEMPT. The contract has no success flag per
 * attempt. The completion path records, on success, ONLY `endedAt` and no
 * classification — src/pipeline/encore-callback-poller.ts:735-744 ("On success
 * the attempt records only endedAt (no failure classification)"); on a settled
 * failure it records the classification too (same call site, and
 * src/pipeline/encore-callback-poller.ts:580-587 for the pre-retry close-out).
 * So: classification present => that attempt failed; `endedAt` with no
 * classification => it ended with no failure recorded; no `endedAt` => still
 * open. This module says exactly that and claims "succeeded" only for the LAST
 * attempt of a job whose own `status` is already `done`.
 *
 * WHY BACKOFF IS DERIVED, NOT READ. There is NO backoff field on the job
 * contract: `backoffMs` exists only inside the server's retry decision
 * (src/encore-scaler/retry-store.ts:248) and is applied as a `notBefore`
 * timestamp on the re-queued job (src/encore-scaler/retry-store.ts:330-336) —
 * it is never persisted onto the job record or exposed by `jobSchema` (checked
 * against the full property list, src/routes/jobs.ts:50-145, and the GET 200
 * schema, openapi.json:15689-15813). The wait between two dispatches is
 * therefore computed from the timestamps the contract DOES carry — the gap
 * between attempt N's `endedAt` and attempt N+1's `startedAt` — and labelled as
 * the observed wait, not as a configured policy value. (For scale: the policy
 * ladder is 15s then 60s, src/encore-scaler/retry-policy.ts:126.)
 *
 * SECURITY: the renderer writes every server-provided string with textContent.
 * ACCESSIBILITY: the timeline is a real <table> with a caption and column
 * headers, so it is navigable as tabular data rather than a visual-only layout
 * (WCAG 2.1 SC 1.3.1); the summary line is plain text, and no state is conveyed
 * by colour alone (SC 1.4.1).
 */

import { sectionTitle } from './detail-sections.js';

// Operator-facing copy for each message-derived failure class. Keys are the
// exact enum values from FAILURE_CLASSES (src/routes/jobs.ts:30); an unknown
// value (a future class this UI has not learned yet) falls back to the raw
// string, so a new class is never silently dropped.
export const ATTEMPT_CLASSIFICATION_COPY = {
  transport: 'transport failure — transient, safe to re-dispatch',
  'io-retryable': 'I/O failure — retryable',
  deterministic: 'deterministic failure — a re-run would fail the same way'
};

/**
 * Elapsed-time wording. Floors, so the row never claims a second that has not
 * fully passed. Mirrors humanDuration() in public/app.js deliberately rather
 * than importing it: that one is private to app.js, and this module must stay
 * importable on its own (standalone detail window, unit test).
 */
export function humanMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const sec = Math.floor(n / 1000);
  if (sec < 60) return sec + ' second' + (sec === 1 ? '' : 's');
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hour' + (hr === 1 ? '' : 's');
  const day = Math.floor(hr / 24);
  return day + ' day' + (day === 1 ? '' : 's');
}

function epochMs(iso) {
  if (iso == null) return undefined;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The attempt log as the UI needs it: one row per recorded dispatch, in
 * dispatch order (the log is append-only and already ordered —
 * src/routes/jobs.ts:109-112 — so it is NOT re-sorted; `index` is shown as the
 * server recorded it).
 *
 * @param {object|null|undefined} job a job as returned by GET /api/v1/jobs/{id}
 * @returns {Array<{
 *   index: number|undefined,
 *   startedAt: string|undefined,
 *   endedAt: string|undefined,
 *   classification: string|undefined,
 *   classificationCopy: string|undefined,
 *   durationMs: number|undefined,
 *   backoffMs: number|undefined,
 *   outcome: 'failed'|'succeeded'|'ended'|'open'
 * }>} empty array when the job carries no attempt log
 */
export function buildAttemptTimeline(job) {
  const log = job && Array.isArray(job.encodeAttemptLog) ? job.encodeAttemptLog : [];
  return log.map(function (entry, i) {
    const e = entry || {};
    const started = epochMs(e.startedAt);
    const ended = epochMs(e.endedAt);
    const isLast = i === log.length - 1;

    // Observed wait before the NEXT dispatch (see the header: no contract field
    // carries it). Only computed when both ends of the gap are known and the
    // gap is forwards in time.
    let backoffMs;
    if (!isLast) {
      const nextStarted = epochMs((log[i + 1] || {}).startedAt);
      if (ended !== undefined && nextStarted !== undefined && nextStarted >= ended) {
        backoffMs = nextStarted - ended;
      }
    }

    let outcome;
    if (e.classification) outcome = 'failed';
    else if (ended === undefined) outcome = 'open';
    else if (isLast && job && job.status === 'done') outcome = 'succeeded';
    else outcome = 'ended';

    return {
      index: typeof e.index === 'number' ? e.index : i + 1,
      startedAt: e.startedAt == null ? undefined : String(e.startedAt),
      endedAt: e.endedAt == null ? undefined : String(e.endedAt),
      classification: e.classification == null ? undefined : String(e.classification),
      classificationCopy: e.classification
        ? ATTEMPT_CLASSIFICATION_COPY[e.classification] || String(e.classification)
        : undefined,
      durationMs:
        started !== undefined && ended !== undefined && ended >= started
          ? ended - started
          : undefined,
      backoffMs: backoffMs,
      outcome: outcome
    };
  });
}

/**
 * Should the panel show an attempt timeline at all?
 *
 * Only when there is more than one recorded dispatch. A job dispatched once has
 * nothing to compare and would get an empty, noisy section for no information
 * (issue #963 acceptance criterion).
 */
export function hasAttemptHistory(job) {
  return !!(job && Array.isArray(job.encodeAttemptLog) && job.encodeAttemptLog.length > 1);
}

// Closing sentence of the attempt summary line, keyed on the exact JOB_STATUSES
// enum values (src/data/job-repo.ts:56; the same six members are surfaced by
// src/routes/jobs.ts:53 and openapi.json:15691-15698). Every member has its own
// entry — including the terminal `cancelled`, which must never be described as
// in-flight — so a status added to the enum later resolves to `undefined` here
// and simply gets no closing claim, rather than silently inheriting another
// state's sentence. Same drift-proofing intent as ATTEMPT_CLASSIFICATION_COPY.
//
// Values are functions because the `done` wording depends on what evidence the
// attempt log actually carries; the rest ignore their argument.
export const JOB_STATUS_SUMMARY_COPY = {
  // Active (ACTIVE_JOB_STATUSES, src/data/job-repo.ts:65-67). One wording that
  // is true of all three: a `queued` or `pending` job is not yet "running".
  pending: function () { return ' — still in progress.'; },
  queued: function () { return ' — still in progress.'; },
  running: function () { return ' — still in progress.'; },
  // Terminal (TERMINAL_JOB_STATUSES, src/data/job-repo.ts:64).
  done: function (ctx) {
    // Name the attempt only when the attempt log actually recorded it. With no
    // log rows the dispatch COUNT is all we have, and it is not an attempt
    // index — claiming "recovered on attempt N" from it would be an assertion
    // the UI has no evidence for.
    return ctx.recoveredAttemptIndex === undefined
      ? ' — recovered after ' + ctx.count + ' dispatches.'
      : ' — recovered on attempt ' + ctx.recoveredAttemptIndex + '.';
  },
  failed: function () { return ' — the job then failed.'; },
  cancelled: function () { return ' — the job was cancelled.'; }
};

/**
 * One line that answers "was this job retried, and did it recover?".
 *
 * Shown ONLY when `encodeAttempts > 1` (issue #963), so a first-time success is
 * never annotated. Returns undefined otherwise. `encodeAttempts` is the count
 * of Encore dispatches (src/routes/jobs.ts:107) — never `attempts`, which is
 * the ingest/URL-pull counter (src/routes/jobs.ts:78).
 *
 * @param {object|null|undefined} job
 * @returns {string|undefined}
 */
export function attemptSummaryLine(job) {
  const count = job && typeof job.encodeAttempts === 'number' ? job.encodeAttempts : undefined;
  if (count === undefined || count <= 1) return undefined;

  const rows = buildAttemptTimeline(job);
  const failed = rows.filter(function (r) { return r.outcome === 'failed'; });
  const classes = [];
  failed.forEach(function (r) {
    if (r.classification && classes.indexOf(r.classification) === -1) classes.push(r.classification);
  });

  let line = 'Dispatched to Encore ' + count + ' times';
  if (failed.length > 0) {
    line +=
      ', ' + failed.length + ' attempt' + (failed.length === 1 ? '' : 's') +
      ' failed (' + classes.join(', ') + ')';
  }
  // Own-property lookup only: a server status that happens to name an inherited
  // Object.prototype member ('constructor', 'toString') must not resolve to a
  // callable and get stringified into operator-facing copy.
  const closing = Object.prototype.hasOwnProperty.call(JOB_STATUS_SUMMARY_COPY, job.status)
    ? JOB_STATUS_SUMMARY_COPY[job.status]
    : undefined;
  if (closing) {
    line += closing({
      count: count,
      recoveredAttemptIndex: rows.length > 0 ? rows[rows.length - 1].index : undefined
    });
  } else {
    // Status this UI has not learned yet: state the dispatch facts and stop,
    // rather than guessing whether the job is still in flight.
    line += '.';
  }
  return line;
}

/**
 * Per-row outcome wording: a short label plus the detail beneath it.
 * Kept separate from the renderer so a test can assert the copy directly.
 */
export function describeAttemptOutcome(row) {
  if (!row) return { label: '—', detail: undefined };
  if (row.outcome === 'failed') {
    return { label: 'Failed', detail: row.classificationCopy };
  }
  if (row.outcome === 'open') {
    return { label: 'In flight', detail: 'Dispatched; no end recorded yet.' };
  }
  if (row.outcome === 'succeeded') {
    return { label: 'Succeeded', detail: undefined };
  }
  // Ended with no classification on a job that is not (yet) `done`: the
  // contract records no failure class, and this UI will not invent one.
  return { label: 'Ended', detail: 'No failure recorded for this attempt.' };
}

/**
 * Render the attempt history section for a job.
 *
 * Returns a detached element containing the section title, the summary line
 * (when `encodeAttempts > 1`) and the per-attempt table (when there is more
 * than one recorded attempt) — or null when the job has neither, so the caller
 * appends nothing at all rather than an empty heading.
 *
 * @param {object} job
 * @param {object} [opts]
 * @param {(v: unknown) => string} [opts.fmtDate] timestamp formatter; defaults to
 *        the browser locale string. app.js passes its own fmtDate so timestamps
 *        read identically across the panel.
 * @returns {HTMLElement|null}
 */
export function renderAttemptHistory(job, opts) {
  const options = opts || {};
  const fmtDate =
    typeof options.fmtDate === 'function'
      ? options.fmtDate
      : function (v) {
          if (!v) return '—';
          try {
            return new Date(v).toLocaleString();
          } catch (_) {
            return String(v);
          }
        };

  const summary = attemptSummaryLine(job);
  const showTable = hasAttemptHistory(job);
  if (!summary && !showTable) return null;

  const wrap = document.createElement('div');
  wrap.className = 'attempt-history';
  wrap.appendChild(sectionTitle('Encode attempts'));

  if (summary) {
    const line = document.createElement('p');
    line.className = 'attempt-summary';
    line.setAttribute('data-attempt-summary', '1');
    line.textContent = summary;
    wrap.appendChild(line);
  }

  if (!showTable) return wrap;

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap attempt-timeline';
  const table = document.createElement('table');

  const caption = document.createElement('caption');
  caption.className = 'visually-hidden';
  caption.textContent = 'Encore dispatch attempts for this job, in dispatch order';
  table.appendChild(caption);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Attempt', 'Started', 'Ran for', 'Outcome'].forEach(function (label) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  buildAttemptTimeline(job).forEach(function (row) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-attempt-index', String(row.index));

    const idx = document.createElement('th');
    idx.scope = 'row';
    idx.className = 'attempt-index';
    idx.textContent = '#' + row.index;
    tr.appendChild(idx);

    const started = document.createElement('td');
    started.textContent = fmtDate(row.startedAt);
    tr.appendChild(started);

    const ran = document.createElement('td');
    ran.textContent = row.durationMs === undefined ? '—' : humanMs(row.durationMs);
    tr.appendChild(ran);

    const outcome = document.createElement('td');
    const described = describeAttemptOutcome(row);
    const label = document.createElement('span');
    label.className = 'attempt-outcome attempt-outcome-' + row.outcome;
    label.textContent = described.label;
    outcome.appendChild(label);
    if (described.detail) {
      const detail = document.createElement('div');
      detail.className = 'attempt-outcome-detail';
      detail.textContent = described.detail;
      outcome.appendChild(detail);
    }
    if (row.backoffMs !== undefined) {
      const wait = document.createElement('div');
      wait.className = 'attempt-outcome-detail attempt-backoff';
      // Worded as an observation, because it IS one: the gap between this
      // attempt's end and the next one's start (see the header's note on why
      // backoff is derived rather than read).
      wait.textContent = 'Waited ' + humanMs(row.backoffMs) + ' before the next attempt.';
      outcome.appendChild(wait);
    }
    tr.appendChild(outcome);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  return wrap;
}
