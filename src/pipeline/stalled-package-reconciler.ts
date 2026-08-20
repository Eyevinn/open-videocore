// Stalled-package reconciliation sweep (issue #336).
//
// A pipeline `package` step is advanced to `done` (or `failed`) ONLY by the
// packager's completion callback — POST /api/v1/internal/packagerCallback/
// success|failure, handled by PackagingService.handleSuccess/handleFailure
// (src/pipeline/packaging.ts). The step is set to `running` at enqueue time
// (src/routes/assets.ts startPipelineExecution, and the transcode->package
// handoff in src/pipeline/encore-callback-poller.ts) and then relies entirely on
// that callback arriving.
//
// If the callback never arrives — no packager instance was ever provisioned to
// consume the queued job, the packager instance died mid-job, or the completion
// callback was simply lost in transit — the `package` step stays `running`
// forever. It only becomes `failed` when an operator cancels it by hand (issue
// #336 observed 22 min and 7 min stuck runs). There is no bounded-time failure
// and no error explaining what went wrong.
//
// This sweep closes that gap, mirroring the failed-transcode reconciler (#273,
// src/pipeline/failed-transcode-reconciler.ts): once per tick it scans running
// PipelineExecutions for a `package` step that has been `running` longer than a
// configurable bound (`stallTimeoutMs`, measured from the step's `startedAt`)
// and, if so, transitions that step — and the execution — to `failed` with a
// diagnostic message.
//
// The diagnostic distinguishes the common causes (issue #336 acceptance):
//   - packager instance PRESENT but no completion signal received: a stalled
//     packager job or a lost/never-delivered callback.
//   - packager instance ABSENT: the queued packaging job has no consumer, so a
//     callback can never arrive.
// The presence check is an injected, best-effort probe (`packagerPresent`) so
// this module stays free of any OSC coupling and is unit-testable; when the
// probe is not wired or itself errors, the message degrades to "unknown" rather
// than failing the sweep.

import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';

// Default bound: a `package` step still `running` after this long is declared
// failed. Generous by default so a genuinely slow packaging job is never cut off
// prematurely — the callback path settles a healthy job long before this fires;
// this only catches steps that are actually stuck (issue #336 observed the
// callback either never arriving or the packager being absent entirely).
// Defaults to 15 minutes.
export const DEFAULT_PACKAGE_STALL_TIMEOUT_MS = 15 * 60 * 1000;

// How many running executions to scan per sweep. Running executions are few
// (one pipeline per asset at a time), so a single generous page is enough to
// make progress each tick.
const SCAN_PAGE_SIZE = 200;

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

export type ReconcileStalledPackagesDeps = {
  pipeline: PipelineRepository;
  // Best-effort probe: does a packager instance currently exist to consume the
  // queued packaging job? Used ONLY to shape the diagnostic message so it names
  // the likely cause. Optional and never trusted for control flow: when absent
  // or it throws, the message degrades to "unknown". Never blocks the timeout.
  packagerPresent?: () => Promise<boolean>;
  // Injectable clock + bound so the timeout path is unit-testable.
  now?: () => number;
  stallTimeoutMs?: number;
  logger?: Logger;
};

export type ReconcileStalledPackagesResult = {
  scanned: number;
  failed: number;
};

// Sweep running pipeline executions and fail any whose `package` step has been
// `running` past the bound. Best-effort per execution: one execution's error
// never aborts the sweep for the rest.
export async function reconcileStalledPackages(
  deps: ReconcileStalledPackagesDeps
): Promise<ReconcileStalledPackagesResult> {
  const now = deps.now ?? (() => Date.now());
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_PACKAGE_STALL_TIMEOUT_MS;

  const { items } = await deps.pipeline.listAll({
    status: 'running',
    limit: SCAN_PAGE_SIZE,
    offset: 0
  });

  let scanned = 0;
  let failed = 0;

  for (const execution of items) {
    const idx = execution.steps.findIndex(
      (s) => s.name === 'package' && s.status === 'running'
    );
    if (idx < 0) continue;

    scanned += 1;

    const step = execution.steps[idx];
    // Measure the running window from the step's startedAt (set when the step
    // was advanced to `running`). A missing/invalid startedAt cannot be aged, so
    // we skip it rather than fail a step we cannot bound — the next sweep with a
    // valid timestamp will catch it. (This should not happen: both advance
    // paths set startedAt, but we never fail a step on ambiguous data.)
    const startedAtMs = step.startedAt ? Date.parse(step.startedAt) : NaN;
    if (Number.isNaN(startedAtMs)) continue;

    const ageMs = now() - startedAtMs;
    if (ageMs <= stallTimeoutMs) continue;

    const minutes = Math.round(stallTimeoutMs / 60000);
    const present = await probePackagerPresent(deps);
    const message = buildDiagnostic(minutes, present);

    try {
      const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
      steps[idx] = {
        ...steps[idx],
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString()
      };
      await deps.pipeline.update(execution.id, { steps, status: 'failed' });
      failed += 1;
      deps.logger?.info?.(
        '[stalled-package-reconciler] failed stalled package step for execution %s (asset %s): %s',
        execution.id,
        execution.assetId,
        message
      );
    } catch (err) {
      deps.logger?.warn?.(
        '[stalled-package-reconciler] failed to settle stalled package step for execution %s: %o',
        execution.id,
        err
      );
    }
  }

  return { scanned, failed };
}

// Run the (best-effort) packager presence probe. Returns undefined when the
// probe is not wired or it throws — the diagnostic then says "unknown" rather
// than asserting a cause we cannot verify. Never rejects.
async function probePackagerPresent(
  deps: ReconcileStalledPackagesDeps
): Promise<boolean | undefined> {
  if (!deps.packagerPresent) return undefined;
  try {
    return await deps.packagerPresent();
  } catch (err) {
    deps.logger?.warn?.(
      '[stalled-package-reconciler] packager presence probe threw: %o',
      err
    );
    return undefined;
  }
}

// Build the timeout diagnostic. It always states the bound and the probed
// presence, and distinguishes the two common causes (issue #336 acceptance):
//   - present=false -> no packager instance to consume the job; a callback can
//     never arrive.
//   - present=true  -> the packager exists but never signalled completion (a
//     stalled packager job or a lost/never-delivered callback).
//   - present=unknown -> presence could not be determined; we still fail the
//     step within the bound but name the ambiguity.
function buildDiagnostic(minutes: number, present: boolean | undefined): string {
  const base = `packager never signalled completion within ${minutes} minutes`;
  if (present === false) {
    return (
      `${base}; packager instance present=false — no packager instance to ` +
      'consume the packaging job, so no completion callback can arrive'
    );
  }
  if (present === true) {
    return (
      `${base}; packager instance present=true — no completion signal received ` +
      '(stalled packager job or lost completion callback)'
    );
  }
  return `${base}; packager instance present=unknown — completion signal not received`;
}
