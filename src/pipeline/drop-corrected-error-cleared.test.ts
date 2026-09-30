// A job that recovered from drop-detection ends `done` with NO error (issue #1023).
//
// #709 made the scaler's gone-from-active-set drop settle CONDITIONAL so a genuine
// SUCCESSFUL callback arriving out of order can correct the job to `done`
// (ADR-016). It corrected the STATUS but never cleared the failure text the drop
// had written, so a recovered job settled `done` + `progress: 100` while still
// carrying "dropped by Encore: gone from active set with no completion" — a
// terminal success that reads as a failure to every consumer of `error`, and that
// poisons "find the jobs with an error" triage with drops that recovered.
//
// Cases (the #1023 acceptance criteria):
//   (1) a job that hit drop-detection and then completed successfully ends
//       `status: 'done'`, `progress: 100`, and NO error string at all.
//   (2) the drop stays diagnosable: the corrective completion's audit entry
//       records `correctedConditionalDrop` plus the failure text just cleared.
//   (3) a genuinely failed job is unaffected — `status: 'failed'` with its reason.
//   (4) filtering jobs by "has an error" returns only the jobs that really failed.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - completeTranscode success write (`status: 'done'`, `progress: 100`,
//     `droppedByScaler: false`) and the `isConditionalDropFailed` override gate —
//     src/pipeline/transcode.ts:230-345; CompleteTranscodeParams.conditionalDrop —
//     src/pipeline/transcode.ts:185-198.
//   - Job.error ("Terminal error message when status === 'failed'"), Job.progress,
//     Job.droppedByScaler and UpdateJobInput.clearError (#1023) + applyJobPatch's
//     `delete next.error` — src/data/job-repo.ts:113, 106-110, 178, 236-249, 384.
//   - settleFailedTranscode(deps, job, error, reason?) with SettleReason
//     'gone-from-active-set' | 'encore-error' —
//     src/pipeline/failed-transcode-reconciler.ts:186, 203-208.
//   - AuditEmitter.record(RecordAuditInput) + free-form AuditDetailSchema
//     (z.record(z.string(), z.unknown())) — src/data/audit-emit.ts:28-30,
//     src/data/audit-repo.ts:63-66, 82-91.
//   - Response exposure of `error` on GET /api/v1/jobs/:id (jobSchema.error,
//     z.string().optional()) — src/routes/jobs.ts:64.
//   - InMemoryJobRepository / InMemoryAssetRepository — src/data/job-repo.ts,
//     src/data/asset-repo.ts.

import { describe, expect, it } from 'vitest';

import { completeTranscode, type CallbackRendition } from './transcode.js';
import { settleFailedTranscode } from './failed-transcode-reconciler.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import type { RecordAuditInput } from '../data/audit-repo.js';

// The exact text the scaler's drop path writes when Encore reported no cause
// (src/main.ts:1305 — the generic gone-from-active-set wording).
const DROP_ERROR = 'dropped by Encore: gone from active set with no completion';

const rendition: CallbackRendition = {
  label: 'rendition_x264_3100',
  width: 1920,
  height: 1080,
  objectKey: 'transcode/asset/job/1080.mp4',
  codec: 'h264',
  bitrateBps: 3_100_000
};

// A `running` transcode job over a `processing` source asset — the state the job
// is in when drop detection observes it vanish from Encore's live set.
async function runningTranscode(deps?: {
  jobs: InMemoryJobRepository;
  assets: InMemoryAssetRepository;
}) {
  const jobs = deps?.jobs ?? new InMemoryJobRepository();
  const assets = deps?.assets ?? new InMemoryAssetRepository();

  const asset = await assets.create({ name: 'clip.mov' });
  await assets.update(asset.id, { status: 'processing' });

  const job = await jobs.create({
    type: 'transcode',
    assetId: asset.id,
    profile: 'program',
    encoreJobId: `ws1__${asset.id}`
  });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });

  return { jobs, assets, jobId: job.id, assetId: asset.id };
}

// Collects the fire-and-forget audit entries emitAudit() detaches.
function recordingAudit() {
  const entries: RecordAuditInput[] = [];
  return {
    entries,
    emitter: {
      async record(input: RecordAuditInput) {
        entries.push(input);
        return input;
      }
    }
  };
}

describe('#1023 a job corrected from drop-detection carries no error', () => {
  it('(1) settles done + progress 100 with NO error after a drop it recovered from', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();

    // The scaler's drop detection settles the job CONDITIONALLY failed (#709),
    // stamping the caller-facing failure text.
    await settleFailedTranscode(
      { jobs, assets },
      (await jobs.get(jobId))!,
      DROP_ERROR,
      'gone-from-active-set'
    );
    const dropped = await jobs.get(jobId);
    expect(dropped?.status).toBe('failed');
    expect(dropped?.error).toBe(DROP_ERROR);
    expect(dropped?.droppedByScaler).toBe(true);

    // The encode actually succeeded: the genuine SUCCESSFUL callback lands late.
    const corrected = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );
    expect(corrected.applied).toBe(true);

    const done = await jobs.get(jobId);
    expect(done?.status).toBe('done');
    expect(done?.progress).toBe(100);
    // The point of #1023: no failure string survives on a terminal success, and
    // the field is genuinely ABSENT (not an empty string), so it serialises away
    // in GET /api/v1/jobs/:id exactly as on a job that never failed.
    expect(done?.error).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(done!, 'error')).toBe(false);
    // #709's marker still clears, unchanged.
    expect(done?.droppedByScaler).toBe(false);
  });

  it('(2) keeps the spurious drop diagnosable on the corrective completion audit entry', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();
    const audit = recordingAudit();

    await settleFailedTranscode(
      { jobs, assets },
      (await jobs.get(jobId))!,
      DROP_ERROR,
      'gone-from-active-set'
    );
    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets, audit: audit.emitter }
    );
    // emitAudit is deliberately detached (fire-and-forget): let it land.
    await new Promise((r) => setTimeout(r, 0));

    const completed = audit.entries.find((e) => e.action === 'job.completed');
    expect(completed).toBeDefined();
    expect(completed?.detail?.['correctedConditionalDrop']).toBe(true);
    // The text cleared off the job is preserved here, so a too-short reconcile
    // grace period is still detectable after the fix.
    expect(completed?.detail?.['clearedDropError']).toBe(DROP_ERROR);
  });

  it('(2b) a normal completion records no drop-correction annotation', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();
    const audit = recordingAudit();

    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets, audit: audit.emitter }
    );
    await new Promise((r) => setTimeout(r, 0));

    const completed = audit.entries.find((e) => e.action === 'job.completed');
    expect(completed?.detail?.['correctedConditionalDrop']).toBeUndefined();
    expect(completed?.detail?.['clearedDropError']).toBeUndefined();
    expect((await jobs.get(jobId))?.error).toBeUndefined();
  });

  it('(3) leaves a genuinely failed job failed, with its reason intact', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();

    // Genuine Encore-reported failure: unconditional ('encore-error' default).
    await settleFailedTranscode(
      { jobs, assets },
      (await jobs.get(jobId))!,
      'Job execution failed: could not find location for profile'
    );

    // Even a later SUCCESSFUL callback must not touch it (#709 gate).
    const override = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );
    expect(override.applied).toBe(false);

    const failed = await jobs.get(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Job execution failed: could not find location for profile');
  });

  it('(4) "has an error" filtering returns only the jobs that actually failed', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();

    // Job A: dropped, then completed successfully.
    const a = await runningTranscode({ jobs, assets });
    await settleFailedTranscode({ jobs, assets }, (await jobs.get(a.jobId))!, DROP_ERROR, 'gone-from-active-set');
    await completeTranscode(
      { jobId: a.jobId, sourceAssetId: a.assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );

    // Job B: genuinely failed.
    const b = await runningTranscode({ jobs, assets });
    await settleFailedTranscode({ jobs, assets }, (await jobs.get(b.jobId))!, 'encode failed: bad input');

    const { items } = await jobs.list();
    const withError = items.filter((j) => typeof j.error === 'string' && j.error.length > 0);
    expect(withError.map((j) => j.id)).toEqual([b.jobId]);
    expect(items.find((j) => j.id === a.jobId)?.status).toBe('done');
  });
});
