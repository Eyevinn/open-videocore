# ADR-012: Encode-attempt data shape

**Status:** PROPOSED 2026-08-22
**Date:** 2026-08-22
**Author agent:** claude-opus-4-8
**Issue:** #379 (design spike; blocks #380 / #381 / #382, forks from #374)

---

## Context

The bounded-retry work (#295) already re-dispatches transport-class encode
failures up to `MAX_ENCODE_ATTEMPTS` (`src/encore-scaler/retry-policy.ts:81`,
value `3`). That machinery counts dispatches in Valkey only — the counter lives
at `keys.jobAttempts(encoreJobId)` (`src/encore-scaler/types.ts:132`), is written
by `recordDispatch` (`src/encore-scaler/retry-store.ts:41`), read by `decideRetry`
(`src/encore-scaler/retry-store.ts:88`), and **deleted** on settle by
`clearRetryState` (`src/encore-scaler/retry-store.ts:53`). It also self-expires
after `PAYLOAD_TTL_SECONDS = 86_400` (24h, `retry-store.ts:36`). So today there is
**no durable, caller-observable record** of how many encode attempts a job made,
nor of when each ran — the moment a job settles the count is gone.

#374 needs to surface that history on the caller-facing job. Two of its forks
disagree on (a) which field the number lives in and (b) where the per-attempt log
is stored, which blocks parallel work on #380/#381/#382. This ADR pins the shape.

## Verified contract sources (CLAUDE.md rule 7)

Every symbol below was read in this branch before citing:

- Caller-facing job type `Job` and its `attempts` field —
  `src/data/job-repo.ts:34-66`. The comment at `job-repo.ts:50` documents
  `attempts` as **"Number of pull attempts made so far (retry tracking)"**, i.e.
  URL-pull *ingest* attempts. It is initialised to `0` at `job-repo.ts:209`
  (`InMemoryJobRepository.create`), is patchable via `UpdateJobInput.attempts`
  (`job-repo.ts:89`), and is copied through by `applyJobPatch` (`job-repo.ts:181`).
- Wire schema (Zod) for the job — `src/routes/jobs.ts:19-38`. `attempts` is a
  required `z.number()` (`jobs.ts:28`); it is returned on **every** job (ingest
  and transcode) by `GET /api/v1/jobs` and `GET /api/v1/jobs/:id`.
- Failure classification enum `FailureClass = 'transport' | 'io-retryable' |
  'deterministic'` — `src/encore-scaler/retry-policy.ts:70`. The retry decision
  that carries it is `RetryDecision` (`retry-store.ts:57-59`), produced by
  `decideRetry` (`retry-store.ts:71`) and consumed at the callback poller's
  `decideRetry(...)` call, `src/pipeline/encore-callback-poller.ts:322`.
- Valkey dispatch counter + TTL + teardown — `retry-store.ts:36,41,48,53`;
  key builder `keys.jobAttempts` — `types.ts:129-132`.
- Pipeline execution + step shapes — `src/data/pipeline-repo.ts:19-58`.
  `StepExecution` (`pipeline-repo.ts:19`) already has `startedAt` / `completedAt`
  and `encoreJobId`; `PipelineExecution` is **in-memory only** — the file header
  (`pipeline-repo.ts:8-10`) states executions are *"ephemeral orchestration
  state, not durable domain records, so no CouchDB backing is required"*. The
  `Job`, by contrast, has a CouchDB backend (`src/data/job-repo.ts:5`,
  `couch-job-repo.ts`).

## Decision 1 — Field disambiguation

**Keep the existing `attempts` field meaning and back-compat intact. Add a
distinct `encodeAttempts` counter and an `encodeAttemptLog` array.**

`attempts` stays exactly what `job-repo.ts:50` documents: URL-pull ingest
attempts. It is already on the wire for every job (`jobs.ts:28`), so renaming or
repurposing it is a breaking change to callers of `GET /api/v1/jobs/:id`. We do
not touch it.

New fields on `Job` (`src/data/job-repo.ts`), both **transcode-only** and
optional so ingest jobs and pre-existing documents are unaffected:

```ts
// Number of times this transcode job was dispatched to an Encore instance,
// inclusive of the first (1 on first dispatch). Mirrors the durable Valkey
// counter keys.jobAttempts but survives settle/TTL. Absent on ingest jobs.
encodeAttempts?: number;

// Per-attempt history for a transcode job (one entry per dispatch). Absent on
// ingest jobs; length always equals encodeAttempts once the job has run.
encodeAttemptLog?: EncodeAttempt[];
```

```ts
export type EncodeAttempt = {
  index: number;                    // 1-based attempt number
  startedAt: string;                // ISO-8601, when this dispatch began
  endedAt?: string;                 // ISO-8601, when it succeeded/failed; absent while running
  classification?: FailureClass;    // set only on a FAILED attempt; imported from retry-policy.ts
};
```

`classification` reuses `FailureClass` from `retry-policy.ts:70` verbatim
(`'transport' | 'io-retryable' | 'deterministic'`) — no new enum. It is `undefined`
for the successful attempt and for an attempt still in flight; it is set from the
`decideRetry` result's `failureClass` (`retry-store.ts:58`) at the poller
(`encore-callback-poller.ts:334-358`).

**Wire schema.** Add to `jobSchema` (`src/routes/jobs.ts:19`):
`encodeAttempts: z.number().optional()` and
`encodeAttemptLog: z.array(z.object({ index: z.number(), startedAt: z.string(),
endedAt: z.string().optional(), classification: z.enum(['transport','io-retryable','deterministic']).optional() })).optional()`.
Both optional, so no existing response validation breaks.

**API back-compat impact:** none removed, only additive optional fields. Existing
callers that read `attempts` continue to see ingest semantics; transcode callers
gain `encodeAttempts` / `encodeAttemptLog`. `UpdateJobInput` (`job-repo.ts:84`)
and `applyJobPatch` (`job-repo.ts:181`) gain the two optional fields the same way
`attempts` is already handled; `create` (`job-repo.ts:198`) leaves both undefined.

## Decision 2 — Placement

**The attempt log lives on the durable job record (`Job`), not on the
`PipelineExecution`.**

Rationale:

1. **Durability.** `PipelineExecution` is explicitly in-memory and ephemeral
   (`pipeline-repo.ts:8-10`); the `Job` is CouchDB-backed (`job-repo.ts:5`). The
   attempt history must outlive the retry window (the Valkey counter is deleted
   on settle, `retry-store.ts:53`, and TTLs at 24h, `retry-store.ts:36`), so it
   must sit on a durable record. Only `Job` qualifies.
2. **Universality.** Every transcode job has a `Job`; not every transcode goes
   through a named `PipelineExecution` (submit-only transcodes do not). Putting
   the log on `Job` gives one read path for all transcodes.
3. **Existing write path.** The poller already resolves `found.job`
   (`encore-callback-poller.ts:291,364`) and calls `completeTranscode` against
   the job repo on settle, and it holds the `decideRetry` result carrying
   `failureClass` in the retry branch (`encore-callback-poller.ts:334`). Writing
   attempt entries there is a local addition, not a new plumbing path.

The `PipelineExecution` transcode step keeps its existing `startedAt`/
`completedAt` (`pipeline-repo.ts:24-26`) as coarse whole-step timing; it is **not**
the source of truth for per-attempt data and is not modified by this ADR.

## Decision 3 — Elapsed time excluding retries (the single documented read)

**Elapsed encode time excluding retries = the last (successful) attempt's
`endedAt − startedAt`.**

Formally, given a settled-successful transcode job `job`:

```
const last = job.encodeAttemptLog.at(-1);            // the successful attempt
const elapsedMs = Date.parse(last.endedAt) - Date.parse(last.startedAt);
```

This deliberately measures only the run that actually produced the renditions,
discarding all wasted transport-class re-runs. (Total wall-clock *including*
retries remains derivable as `firstAttempt.startedAt → lastAttempt.endedAt`, but
the **documented** read for "excluding retries" is the single last-attempt
subtraction above.) This is the one read #380/#381/#382 should target.

## Never-retried job records exactly one attempt (not zero)

An attempt entry is appended **at dispatch time** — the same moment
`recordDispatch` writes the Valkey counter starting at `1` (`retry-store.ts:41`,
`recordDispatch(..., attempts)` with the first dispatch's `attempts = 1`; the
counter comment at `types.ts:130-131` confirms it *"Starts at 1 on first
dispatch"*). So a job that succeeds on its first dispatch and is never retried
has `encodeAttempts === 1` and `encodeAttemptLog.length === 1`, with that single
entry's `classification === undefined`. Zero attempts is only ever the transient
pre-dispatch state (job `pending`/`queued`), never a settled transcode.

## Consequences

- Additive, back-compatible: no field renamed, no wire field removed. Ingest
  jobs are untouched (both new fields absent).
- The durable `encodeAttempts` becomes the caller-facing survivor of the Valkey
  counter that `clearRetryState` (`retry-store.ts:53`) deletes on settle — the
  two must be written in step at dispatch and settle by the implementing issue.
- `FailureClass` is reused, not forked; if the enum changes in `retry-policy.ts`
  the Zod enum in `jobs.ts` must be updated in lockstep (single source of truth
  remains `retry-policy.ts:70`).
- Implementation of the write path (poller + job repo) and the read endpoint is
  out of scope here and is tracked by #380 / #381 / #382.
