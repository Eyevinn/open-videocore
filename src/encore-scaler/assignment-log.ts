// Per-tick job-assignment trail for the encore-scaler control loop (issue #1172,
// broken out of #1168).
//
// THE GAP. An operator looking at a workspace with two ready instances and a
// non-empty queue could not tell from any log why the second instance had no
// work. The three things that decide it were each visible somewhere else, or not
// at all:
//   - queue depth was exposed only as a NUMBER on GET /api/v1/scaler/status and
//     in the Transcoders summary (`workspaceSchema.queueDepth`, src/routes/
//     scaler.ts, surfaced by #1132) — a gauge, with no per-instance detail and
//     no history;
//   - the callback-trust gate that withholds an instance's first job
//     (`ensureCallbackTrust`, src/encore-scaler/scaler-loop.ts) logged ONLY its
//     two terminal outcomes (quarantine, sweep-only fallback) via the #1136
//     failure path. The common case — "still probing, ineligible this tick" —
//     returned false silently;
//   - the assignment itself (which instance a job was posted to) was never
//     logged on success at all.
//
// So this module owns the ONE line that puts them together: for a tick, the
// queue depth it saw, every instance it considered, the probe outcome for each,
// and the job ids each instance was actually given.
//
// NOT A DUPLICATE of the two PRs it builds on (issue #1172 explicitly):
//   - #1136 (src/encore-scaler/scaler-log.ts) owns ERROR reporting for the loop:
//     one `error`-level entry per failing (workspace, phase), throttled, with a
//     redacted cause. This module adds no error entry and re-reports no failure
//     it already covers — it reuses #1136's producer (`logScalerEvent`), its
//     category and its message-prefix filter contract, under a phase of its own
//     (`assign`) so `q=encore-scaler/dispatch` keeps selecting exactly the
//     failure entries it selected before.
//   - #1132 owns the queue-depth GAUGE on the status endpoint/UI. This module
//     neither re-reads nor re-derives it: the tick's existing `llen` of
//     `keys.queue(workspaceId)` (step 1 of `tick`, the same key
//     `workspaceSchema.queueDepth` reports) is passed in. No extra Valkey round
//     trip, and the two can never disagree.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Instance fields read for readiness: `EncoreInstanceRecord.instanceId`,
//     `.activeJobs`, `.draining`, `.pendingReadySince`, `.callbackTrustReady`,
//     `.callbackTrustQuarantinedAt`, `.callbackPathUnusableAt`,
//     `.callbackPathUnusableStatus`, `.callbackListenerUrl` —
//     src/encore-scaler/types.ts (`EncoreInstanceRecord`).
//   - Job identity logged per assignment: `QueuedJob.jobId` ("our correlation id
//     (encoreJobId / externalId)") — src/encore-scaler/types.ts (`QueuedJob`).
//   - Probe outcome vocabulary: `CallbackTrustProbeResult` — the union
//     `{ ok: true; state: 'trusted'; status }` |
//     `{ ok: false; state: 'callback-unusable'; status; detail }` |
//     `{ ok: false; state: 'probe-failed'; errorClass: 'tls-trust' | 'timeout'
//     | 'connection'; detail }` — src/encore-scaler/callback-trust-probe.ts.
//   - Queue depth semantics: `keys.queue(workspaceId)` =
//     `encore:queue:${workspaceId}` (src/encore-scaler/types.ts `keys`), read as
//     `redis.llen` in `EncoreScalerLoop.tick` step 1 and reported as
//     `queueDepth` by src/routes/scaler.ts.
//   - Per-instance capacity bound: `JOBS_PER_INSTANCE` —
//     src/encore-scaler/instance-pool.ts.

import type { CallbackTrustProbeResult } from './callback-trust-probe.js';

// Why an instance did, or did not, receive a job on this tick. Exactly one
// outcome per instance per tick: the reason it STOPPED taking work, which is the
// question the issue asks ("why a ready second instance had no work").
//
// The first four are decided before the trust gate runs and mean the instance
// was never a candidate; `trust-probe-pending` is the gate withholding a first
// job; the last four are post-gate, i.e. the instance WAS eligible.
export const ASSIGNMENT_OUTCOMES = [
  // Marked draining for teardown (#513) — new jobs are deliberately withheld.
  'draining',
  // OSC has never reported it `running` (#1071): `pendingReadySince` is set.
  'pending-spawn',
  // Already at JOBS_PER_INSTANCE before the queue was consulted.
  'at-capacity',
  // The callback-trust gate did not clear it this tick (#463) — ineligible for a
  // first job, re-probed on a later tick. THE case that was previously silent.
  'trust-probe-pending',
  // Eligible, and at least one job was posted to it. `assignedJobIds` says which.
  'assigned',
  // Eligible with spare capacity, but the queue was empty when it was asked.
  'queue-empty',
  // Eligible, but the only claimable job is held by a retry backoff (#295,
  // `QueuedJob.notBefore`) that is not yet due.
  'retry-backoff',
  // Eligible, but the POST failed and the job was re-queued (the cause itself is
  // reported by the #1136 dispatch-phase error entry — never re-reported here).
  'dispatch-failed'
] as const;
export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

// The probe outcome for ONE instance on this tick (issue #1172: "Include the
// probe outcome per instance"). Either the state already recorded on the
// instance record, or the live result of the probe this tick ran.
export const PROBE_OUTCOMES = [
  // `callbackTrustReady` — confirmed by an earlier tick, so no probe ran (warm
  // instances incur no added latency, and that is WHY there is no live result).
  'confirmed-earlier',
  // `callbackListenerUrl` is unknown (an instance reconciled from OSC), so there
  // is nothing to probe and the gate fails open.
  'none-to-probe',
  // `callbackTrustQuarantinedAt` — the bounded wait was exceeded on an earlier
  // tick and the instance is held out of job assignment.
  'quarantined',
  // `callbackPathUnusableAt` — reachable but rejecting (#813); jobs are
  // dispatched anyway and completion falls back to the terminal-job sweep.
  'sweep-only-fallback',
  // A probe ran THIS tick and confirmed the callback path.
  'trusted-now',
  // A probe ran THIS tick and did not confirm it. The reason is appended as
  // `probe-failed:<errorClass>` / `callback-unusable:<status>`, so the trail
  // distinguishes a PKIX race from a timeout from an auth-walled ingress.
  'probe-failed',
  'callback-unusable',
  // The gate was never reached on this tick (the instance was skipped earlier,
  // for draining or an unresolved spawn), so nothing was probed and nothing is
  // yet resolved on the record — see recordedProbeOutcome.
  'not-probed'
] as const;
export type ProbeOutcomeKind = (typeof PROBE_OUTCOMES)[number];

export type ProbeOutcome = {
  kind: ProbeOutcomeKind;
  // Short qualifier rendered after the kind: the `errorClass` of a failed probe
  // or the HTTP status of a rejecting ingress. Never free-form error text — a
  // probe `detail` can echo a URL, and the failure paths that publish detail do
  // it through the #1136 redaction (`describeScalerError`), not through here.
  detail?: string;
};

// Describe the probe state the gate resolved for an instance. Takes the LIVE
// result when one exists (a probe ran this tick) and falls back to the state
// persisted on the record, so the trail never says "trusted" about an instance
// that was merely never probed.
export function describeProbeResult(result: CallbackTrustProbeResult): ProbeOutcome {
  if (result.ok) return { kind: 'trusted-now' };
  if (result.state === 'callback-unusable') {
    return { kind: 'callback-unusable', detail: String(result.status) };
  }
  return { kind: 'probe-failed', detail: result.errorClass };
}

// The probe state an instance ALREADY carries, for the skips decided before the
// trust gate is reached (draining, pending-spawn) — no probe runs for those, and
// the trail must not imply one did. Reads only the persisted callback-trust
// fields of `EncoreInstanceRecord` (src/encore-scaler/types.ts).
export function recordedProbeOutcome(inst: {
  callbackTrustReady?: boolean;
  callbackTrustQuarantinedAt?: number;
  callbackPathUnusableAt?: number;
  callbackPathUnusableStatus?: number;
  callbackListenerUrl?: string;
  callbackTrustFirstProbeAt?: number;
}): ProbeOutcome {
  if (inst.callbackTrustReady) return { kind: 'confirmed-earlier' };
  if (inst.callbackTrustQuarantinedAt !== undefined) return { kind: 'quarantined' };
  if (inst.callbackPathUnusableAt !== undefined) {
    return {
      kind: 'sweep-only-fallback',
      detail:
        inst.callbackPathUnusableStatus === undefined
          ? undefined
          : String(inst.callbackPathUnusableStatus)
    };
  }
  if (!inst.callbackListenerUrl) return { kind: 'none-to-probe' };
  // A listener exists and nothing is resolved yet: the gate would probe (or
  // re-probe) this instance, it just never got that far on this tick.
  return { kind: 'not-probed' };
}

export function renderProbeOutcome(probe: ProbeOutcome): string {
  return probe.detail === undefined ? probe.kind : `${probe.kind}:${probe.detail}`;
}

// One instance's decision for one tick.
export type AssignmentDecision = {
  instanceId: string;
  // Was the instance eligible to be given a job at the moment it was asked?
  // `true` for every post-gate outcome (including `queue-empty` and
  // `dispatch-failed`), `false` for draining / pending-spawn /
  // trust-probe-pending. `at-capacity` is ready but full, so it is `true`:
  // "ready, no spare capacity" and "not ready" are different answers.
  ready: boolean;
  outcome: AssignmentOutcome;
  probe: ProbeOutcome;
  // `QueuedJob.jobId` of every job posted to this instance on this tick, in
  // dispatch order. Empty for every outcome other than `assigned`.
  assignedJobIds: string[];
  // Tracked in-flight jobs on the instance when it was asked, and the per-
  // instance bound — so "at-capacity" is self-explanatory in the trail.
  activeJobs: number;
  capacity: number;
};

export type AssignmentTrail = {
  // The tick's queue depth: `llen encore:queue:{workspaceId}` as read in step 1
  // of the tick, i.e. accepted-but-not-yet-dispatched jobs — the same quantity
  // GET /api/v1/scaler/status reports as `queueDepth`.
  queueDepth: number;
  decisions: AssignmentDecision[];
  // Consecutive earlier ticks whose decision picture was identical to this one
  // and were therefore not logged (see shouldLogAssignmentTrail). 0 => this
  // entry stands for its own tick only.
  unchangedTicks?: number;
};

// The message body of the trail entry — WITHOUT the `encore-scaler/assign: `
// prefix and the `[workspace=…]` suffix, both of which `scalerLogMessage`
// (src/encore-scaler/scaler-log.ts) adds for every phase alike.
//
// One line, because the acceptance criterion is "one log trail explains why an
// instance did or did not receive a job" and a reader should not have to
// correlate entries by timestamp to get the answer. The per-instance clauses are
// `;`-separated and each names the instance, so a long pool stays greppable by
// instance id.
export function formatAssignmentTrail(trail: AssignmentTrail): string {
  const { queueDepth, decisions } = trail;
  const assigned = decisions.reduce((n, d) => n + d.assignedJobIds.length, 0);
  const ready = decisions.filter((d) => d.ready).length;
  const remaining = Math.max(0, queueDepth - assigned);
  const head =
    `queueDepth=${queueDepth} instances=${decisions.length} ready=${ready} ` +
    `assigned=${assigned} stillQueued=${remaining}`;
  const perInstance = decisions.map((d) => {
    const jobs = d.assignedJobIds.length > 0 ? ` jobs=${d.assignedJobIds.join(',')}` : '';
    return (
      `${d.instanceId} ${d.ready ? 'ready' : 'not-ready'} ` +
      `outcome=${d.outcome} probe=${renderProbeOutcome(d.probe)} ` +
      `activeJobs=${d.activeJobs}/${d.capacity}${jobs}`
    );
  });
  const unchanged =
    trail.unchangedTicks && trail.unchangedTicks > 0
      ? ` (unchanged for the previous ${trail.unchangedTicks} tick` +
        `${trail.unchangedTicks === 1 ? '' : 's'}, not logged separately)`
      : '';
  return `${head}${unchanged}; ${perInstance.join('; ')}`;
}

// A stable identity for the DECISION PICTURE of a tick, deliberately coarser
// than the message itself.
//
// The loop ticks every 10s, and the operational log store retains a bounded,
// oldest-first window (LOG_STORE_MAX_RECORDS, src/services/log-store.ts) — the
// same constraint that made #1136's error entries throttled. An unconditional
// per-tick info entry would be ~8,600 records a day per workspace and would
// evict the history this trail exists to provide, so the trail is emitted when
// the picture CHANGES (an instance became ready, started or stopped getting
// work, its probe resolved differently, the queue emptied or stopped being
// empty) and only periodically while it does not.
//
// Excluded from the fingerprint on purpose: the exact queue depth and the job
// ids. Both change on almost every tick of a busy workspace without changing the
// answer to "why did this instance get work or not" — including them would
// defeat the suppression exactly when the pool is at its busiest. Both are still
// in the message of every entry that IS emitted.
export function assignmentTrailFingerprint(trail: AssignmentTrail): string {
  const instances = trail.decisions
    .map(
      (d) =>
        `${d.instanceId}:${d.ready ? 'r' : 'n'}:${d.outcome}:${renderProbeOutcome(d.probe)}`
    )
    .join('|');
  return `q${trail.queueDepth > 0 ? '+' : '0'}|${instances}`;
}

// How long an unchanged decision picture goes without being re-stated. Matches
// the #1136 error throttle window (SCALER_LOG_THROTTLE_WINDOW_MS) so the two
// producers' cadences are the same, and keeps a permanently steady workspace at
// 12 trail entries an hour.
export const ASSIGNMENT_TRAIL_REPEAT_MS = 5 * 60_000;

// Decide whether this tick's trail is appended.
//
// Pure, so the policy is testable without a loop: returns the number of
// collapsed unchanged ticks to report alongside the entry when it should be
// written, or `undefined` when it should not.
export function shouldLogAssignmentTrail(state: {
  fingerprint: string;
  lastFingerprint: string | undefined;
  lastLoggedAt: number;
  unchangedTicks: number;
  now: number;
  repeatMs?: number;
}): number | undefined {
  const repeatMs = state.repeatMs ?? ASSIGNMENT_TRAIL_REPEAT_MS;
  // A changed picture is new information: always log it, immediately, so the
  // tick on which an instance became ready (or stopped getting work) is the tick
  // the operator can see.
  if (state.fingerprint !== state.lastFingerprint) return 0;
  // Unchanged: re-state it at most once per window, carrying the count of the
  // ticks that were not logged so the entry is not mistaken for a one-off.
  if (state.now - state.lastLoggedAt >= repeatMs) return state.unchangedTicks;
  return undefined;
}
