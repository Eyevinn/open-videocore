// Reclaiming the instance of a job the operator cancelled that Encore will not
// stop (issue #1219).
//
// THE PART OF #1219 DELIVERING THE CANCEL DOES NOT FIX
//
// Resolving the right Encore job URL and POSTing `/cancel` to it (see
// cancel-target.ts) fixes the half of #1219 where Videocore recorded CANCELLED
// having POSTed nothing. It does NOT fix the half the issue reproduces by hand:
//
//   4. Send POST /encoreJobs/<id>/cancel to the Encore instance.
//   5. The request returns 200 "Ok", but ffmpeg keeps running and frame lines
//      keep coming.
//
// A FROZEN encode (the source connection cut mid-encode) has an ffmpeg process
// blocked in a read that never returns. The cancel is accepted and recorded,
// but nothing interrupts that process, so the job stays in Encore's
// QUEUED+IN_PROGRESS set indefinitely. That is upstream behaviour we cannot fix
// from this side; it is logged as OSC friction in
// docs/osc-feedback/incoming-issue1219-encore-cancel-not-honoured-by-frozen-job.md.
//
// What it costs us is NOT just a stale status. The scaler reads the same active
// set as the authoritative "real in-flight work" signal before it tears an
// instance down (scaler-loop.ts step 4, drain-don't-kill #513), and correctly
// refuses to destroy an instance with real work. A frozen job therefore pins
// its instance FOREVER: `real.count` never reaches 0, the instance is drained
// on every tick and never torn down, it still counts towards maxInstances, and
// the ffmpeg keeps burning CPU. The issue's "the only thing that stopped it was
// deleting the Encore instance" is precisely this state — the operator doing by
// hand the teardown the scaler had disqualified itself from doing.
//
// THE DISTINCTION THIS MODULE ADDS
//
// "Real in-flight work" means work somebody still wants. An Encore job the
// operator EXPLICITLY CANCELLED is, by definition, not that — whether or not
// Encore ever stops reporting it active. So a cancelled job stops protecting
// its instance from teardown, and the existing scale-down path reclaims the
// instance (destroying it, which is what actually stops the frozen ffmpeg)
// instead of draining it forever. Every other active job keeps its full
// protection: the exclusion is per-externalId, never per-instance.
//
// Deliberately NOT a bypass of drain-don't-kill. The two guards that make that
// policy safe still apply in full:
//   - an instance whose real state could not be CONFIRMED is never destroyed
//     (fetchRealActiveState returning undefined, scaler-loop.ts);
//   - a truncated active page leaves `count` exact while the id set is partial
//     (EncoreActiveState.truncated), so subtracting the cancelled ids we can
//     SEE still leaves the unseen ones counted — the instance drains. The
//     subtraction can only ever shrink the protected set by jobs positively
//     identified as cancelled.
//
// And it is gated on a GRACE WINDOW. A cancel Encore honours normally takes
// effect in seconds; destroying the instance under it would be a far worse
// failure than the one being fixed (it would turn every routine cancel into an
// instance churn). Only a job still active CANCEL_RECLAIM_GRACE_MS after the
// cancel was requested — i.e. one that has demonstrably ignored it — stops
// protecting its instance.
//
// That window is what the TEARDOWN is gated on, not merely what the reclaim
// path consults. Recording a cancel marks the host instance `draining` (keeping
// new work off an instance whose job may be stuck), but a drain with a
// `cancelDrainingSince` stamp is explicitly NOT evidence for teardown: with no
// abandoned job past the window and no idle-and-aged condition, scale-down
// keeps the instance and releases the stamp, so a cancel Encore honours leaves
// its host exactly as long-lived as any other instance that just finished a
// job. See recordOperatorCancel below and scaler-loop.ts tick() step 4.
import type { Redis } from 'ioredis';
import { keys, type EncoreInstanceRecord } from './types.js';

type ReclaimRedis = Pick<Redis, 'get' | 'set' | 'hget' | 'hgetall' | 'hset'>;

// How long an operator-cancelled job keeps protecting its instance from
// teardown while Encore still reports it active. Sized well above a healthy
// cancel (Encore stops a responsive job and drops it from the active set within
// a tick or two) and well below the idle timeout, so the window only ever
// catches a job that is genuinely ignoring its cancel.
export const CANCEL_RECLAIM_GRACE_MS = 60_000;

// Same 24h TTL as the other dispatch-time job keys (jobUuid/jobEncoreUrl/
// jobTerminalInstance, scaler-loop.ts:2290-2301): the marker is only meaningful
// while the job URL and instance mapping it refers to are still resolvable.
const CANCEL_MARKER_TTL_SECONDS = 86_400;

// Record that an operator cancelled this (already dispatched) job, and stop the
// scaler routing new work to the instance holding it.
//
// Marking the host instance `draining` here is what makes the reclaim reachable
// for the #1219 case specifically: a frozen job's LIVE mapping may already be
// gone, and scale-down only considers an instance that is either idle-and-aged
// or already draining. An instance pinned by a frozen job is never idle, so
// without this it would never become a teardown candidate at all. Draining is
// also the correct state on its own terms — an instance whose only job is a
// cancelled one that will not die must not be handed anybody's next transcode.
//
// The drain is stamped `cancelDrainingSince` so scale-down can tell it apart
// from a drain IT wrote. That distinction is load-bearing, and the reason this
// write is not a teardown on its own: scale-down's own drain means "already a
// teardown candidate, held only until its real work clears", so a cleared
// instance is destroyed at once. A cancel means no such thing — the host is
// usually a warm, healthy instance whose cancel Encore honours in seconds, and
// destroying it would bypass idleTimeoutMs and turn every routine cancel into
// instance churn (the failure the GRACE WINDOW note below promises to avoid).
// So scale-down requires positive evidence — an abandoned job past its grace
// window, or the ordinary idle-and-aged condition — before destroying an
// instance whose only candidacy reason is this stamp, and RELEASES the stamp
// (returning the instance to service) once Encore confirms no work is left.
// See scaler-loop.ts tick() step 4.
//
// Never overwrites an existing drain: a record already `draining` is left
// exactly as it is (an operator drain via DELETE /scaler/instances/:id, or a
// scale-down drain, keeps its own meaning and must not be released by a cancel).
//
// Best-effort by contract: every failure is swallowed. This runs inside the
// operator's cancel request, and a missing marker must never turn a cancel into
// an error — the reclaim is a cleanup that the next cancel, the idle clock, or
// an operator can still reach.
export async function recordOperatorCancel(
  redis: ReclaimRedis,
  workspaceId: string,
  encoreJobId: string,
  instanceId: string | undefined,
  now: number = Date.now()
): Promise<void> {
  try {
    await redis.set(
      keys.jobCancelRequested(encoreJobId),
      String(now),
      'EX',
      CANCEL_MARKER_TTL_SECONDS
    );
  } catch {
    // Marker unavailable: the cancel itself still stands.
  }
  if (!instanceId) return;
  try {
    const raw = await redis.hget(keys.pool(workspaceId), instanceId);
    if (!raw) return; // instance already gone from the pool — nothing to drain.
    const record = JSON.parse(raw) as EncoreInstanceRecord;
    if (record.draining === true) return;
    await redis.hset(
      keys.pool(workspaceId),
      instanceId,
      JSON.stringify({
        ...record,
        draining: true,
        cancelDrainingSince: now
      } satisfies EncoreInstanceRecord)
    );
  } catch {
    // Unparseable/unwritable pool record: leave the pool exactly as it was.
  }
}

// Of the externalIds Encore still reports ACTIVE on one instance, which ones did
// an operator cancel more than `graceMs` ago? Those are the jobs that have
// ignored their cancel and must stop protecting the instance.
//
// Reads the cancel markers rather than the job-status hash on purpose: a
// terminal CANCELLED status alone does not say WHEN it was recorded, and the
// grace window is the whole point. A job with no marker (cancelled before this
// existed, or marker expired) is treated as normal protected work — the
// conservative direction, costing at most a drain where a teardown was due.
export async function stuckCancelledActiveIds(
  redis: ReclaimRedis,
  activeExternalIds: Set<string>,
  now: number = Date.now(),
  graceMs: number = CANCEL_RECLAIM_GRACE_MS
): Promise<Set<string>> {
  const stuck = new Set<string>();
  for (const externalId of activeExternalIds) {
    let raw: string | null;
    try {
      raw = await redis.get(keys.jobCancelRequested(externalId));
    } catch {
      continue; // cannot confirm a cancel — keep protecting the job.
    }
    if (!raw) continue;
    const cancelledAt = Number(raw);
    if (!Number.isFinite(cancelledAt)) continue;
    if (now - cancelledAt >= graceMs) stuck.add(externalId);
  }
  return stuck;
}

// Instance ids holding at least one job that the operator cancelled more than
// `graceMs` ago and that the scaler still maps to them.
//
// This is the second route into the reclaim, complementing the `draining` mark
// recordOperatorCancel sets: it recovers the case where that mark could not be
// written (pool record momentarily unreadable, a cancel issued by an older
// build, a scaler restart between the two). Cheap — two hash reads per tick
// against hashes the tick already reads — and it only ever makes an instance a
// teardown CANDIDATE. Whether the instance is actually destroyed is still
// decided by the authoritative real-active-state check in scale-down.
export async function instancesHoldingStuckCancelledJobs(
  redis: ReclaimRedis,
  workspaceId: string,
  now: number = Date.now(),
  graceMs: number = CANCEL_RECLAIM_GRACE_MS
): Promise<Set<string>> {
  const hosts = new Set<string>();
  try {
    const mapped = await redis.hgetall(keys.jobInstance(workspaceId));
    const entries = Object.entries(mapped);
    if (entries.length === 0) return hosts;
    const statuses = await redis.hgetall(keys.jobStatus(workspaceId));
    for (const [jobId, instanceId] of entries) {
      if (!instanceId) continue;
      if ((statuses[jobId] ?? '').toUpperCase() !== 'CANCELLED') continue;
      const stuck = await stuckCancelledActiveIds(redis, new Set([jobId]), now, graceMs);
      if (stuck.size > 0) hosts.add(instanceId);
    }
  } catch {
    // Unreadable mapping: no extra candidates this tick.
  }
  return hosts;
}
