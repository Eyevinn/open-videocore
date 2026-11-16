// The marker that tells a cancelled run apart from a failed one (issue #1339).
//
// WHY THIS EXISTS
// ---------------
// Cancelling a run settles it as `failed`: every unfinished step becomes
// `failed` and the execution becomes `failed`. A caller polling the run then
// sees exactly what a genuine breakage looks like, with no signal that an
// operator stopped it on purpose — so a dashboard raises an alert, a retry loop
// retries, and an incident gets opened for a deliberate stop. This module
// produces the one distinct, machine-readable marker that separates the two.
//
// WHY `errorDetail.code` AND NOT A NEW STATUS (issue #1339 asks for the least
// breaking of the two)
// ---------------------------------------------------------------------------
// A `cancelled` STATUS would be a new value in enums existing clients already
// branch on, which #1339 forbids without an off-by-default flag; the flag would
// then have to be threaded through both step-status enums, the execution status
// enum, the `?status=` list filter and every completion check that enumerates
// terminal states. `errorDetail` is the field this schema already carries FOR
// machine-readable annotation of a settled step, it is optional, and every
// status value stays exactly as it is — so a client that ignores `errorDetail`
// (every client today) sees no change at all, and one that reads it gets the
// distinction. Same additive shape as `skipReason` (#789) and the `packager_*`
// codes (#1338) before it.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - `STEP_ERROR_CODES` / `StepErrorDetail` — the enum this adds to and the
//     shape returned here: ./step-error-detail.ts (`code` + `message`
//     required, every other member optional). The response schema deriving its
//     enum from that tuple is `stepErrorDetailSchema` in the same file,
//     embedded as the `errorDetail` member of both copies of
//     `stepExecutionSchema` (src/routes/pipelines.ts, src/routes/assets.ts).
//   - `StepStatus` = `pending | running | done | failed | skipped` and
//     `PipelineExecution.status` = `running | done | failed` —
//     src/data/pipeline-repo.ts. Neither has a `cancelled` member, which is
//     what rules out the "status already supports it" option in #1339.
//   - `StepExecution.errorDetail` — the persisted/served field,
//     src/data/pipeline-repo.ts; hydrated through `toStepErrorDetail`
//     (src/data/couch-pipeline-repo.ts), which parses stored values with
//     `stepErrorDetailSchema`, so this code had to join the tuple for a
//     cancelled step to survive a round-trip through CouchDB.
//   - The cancel paths that stamp it: `DELETE /:executionId` in
//     src/routes/pipelines.ts (whole run) and `DELETE /:id` in
//     src/routes/jobs.ts (the `transcode` step of the run behind a cancelled
//     job).
//   - The precedent for a builder shared by every settle path:
//     `packageErrorDetail` (./package-failure-detail.ts).

import type { StepErrorDetail } from './step-error-detail.js';

// The user-safe sentence a cancelled step carries. A FIXED string, like the
// `packager_*` messages: nothing about who cancelled, from which address or
// with which token is interpolated into a field served to API callers. It says
// what happened and what it implies — the step was stopped, it did not fail —
// because that is the whole point of the marker.
export const CANCELLED_STEP_MESSAGE =
  'the run was cancelled before this step finished; it did not fail. The step ' +
  'and its execution report `failed` because that is the terminal status the ' +
  'status enums carry — see `errorDetail.code`.';

// Build the detail for a step settled by a cancellation. `{ code, message }`
// only: a cancel has no storage error, no HTTP status and no source location,
// so every other member of StepErrorDetail is deliberately absent.
//
// The single place a `cancelled` detail is constructed, so both cancel routes
// emit an identical shape and a caller can compare them.
export function buildCancelledStepErrorDetail(): StepErrorDetail {
  return { code: 'cancelled', message: CANCELLED_STEP_MESSAGE };
}
