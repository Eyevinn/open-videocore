// URL-pull ingest worker (issue #5).
//
// Runs the asynchronous pull of a remote source into MinIO and keeps the
// IngestJob + Asset records in step. It is invoked in-process as a detached
// async task from the route (no separate worker process yet — a Valkey-backed
// queue is a future enhancement, see the OSC friction log). The worker is the
// single owner of a job's lifecycle once created:
//
//   pending --start--> running --(stream ok)--> done   (asset -> processing)
//                              \--(error)------> failed (asset -> failed)
//
// Resilience: transient pull failures are retried up to MAX_ATTEMPTS with
// exponential backoff. A SourceTooLargeError or SourceValidationError is
// permanent and fails the job immediately without retry. Progress events
// (% bytes) are persisted to the job as the stream advances, throttled so we do
// not write to CouchDB on every chunk. Every attempt starts from a clean slate:
// any multipart upload still open for the object key is discarded first, so a
// retry writes a fresh upload instead of resuming the dead one (issue #1088).

import type { AssetRepository } from '../data/asset-repo.js';
import type { JobRepository } from '../data/job-repo.js';
import { SourceTooLargeError, type WorkspaceStorage } from '../data/storage.js';
import { QuotaExceededError, type StorageQuotaGuard } from '../data/storage-quota.js';
import {
  assertPublicHost,
  openSource,
  parseSource,
  SourceValidationError,
  type SourceDeps
} from './source.js';
import {
  logPipelineEvent,
  type PipelineLogErrorLog,
  type PipelineLogSink
} from '../services/pipeline-log.js';

// Default 50 GB cap; configurable via INGEST_MAX_SOURCE_BYTES.
export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024 * 1024;

export function maxSourceBytes(): number {
  const raw = process.env['INGEST_MAX_SOURCE_BYTES'];
  if (!raw) return DEFAULT_MAX_SOURCE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SOURCE_BYTES;
}

export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

// Persist progress at most this often to avoid hammering CouchDB.
const PROGRESS_INTERVAL_MS = 1000;

export type PullDeps = SourceDeps & {
  maxBytes?: number;
  // Injectable sleep for fast tests.
  sleep?: (ms: number) => Promise<void>;
  // Injectable backoff base for fast tests.
  baseBackoffMs?: number;
  // Hook fired after each attempt fails (test observability).
  onAttemptError?: (attempt: number, err: unknown) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermanent(err: unknown): boolean {
  return (
    err instanceof SourceTooLargeError ||
    err instanceof SourceValidationError ||
    err instanceof QuotaExceededError
  );
}

export type PullParams = {
  jobId: string;
  assetId: string;
  objectKey: string;
  sourceUrl: string;
};

// Clear any multipart upload left open for this object key (issue #1088), so a
// write never resumes a half-finished one. Best-effort by design: a cleanup that
// cannot reach storage is reported as a warning on the operational log and
// nothing more, because the pull itself is either about to run (and will fail on
// its own terms if storage is really unreachable) or has already failed with the
// error the job must report. It never throws, which keeps the never-throws
// contract of runPull intact.
async function discardOrphanedUpload(
  deps: {
    storage: WorkspaceStorage;
    pipelineLog?: PipelineLogSink;
    pipelineLogErrors?: PipelineLogErrorLog;
  },
  objectKey: string,
  jobId: string
): Promise<void> {
  try {
    await deps.storage.abortIncompleteMultipartUploads(objectKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logPipelineEvent(
      deps.pipelineLog,
      {
        stage: 'ingest',
        level: 'warn',
        message:
          `could not discard an incomplete multipart upload for ${objectKey} ` +
          `(job ${jobId}): ${message}`
      },
      deps.pipelineLogErrors
    );
  }
}

// Run one pull job to a terminal state. Resolves when the job is done/failed;
// it never throws (failures are recorded on the job), so it is safe to invoke
// detached with `void runPull(...)`.
export async function runPull(
  params: PullParams,
  deps: {
    jobs: JobRepository;
    assets: AssetRepository;
    storage: WorkspaceStorage;
    // Operator-configured total storage cap (issue #579, ADR-020). When
    // provided, the worker reserves quota headroom once the remote source's
    // Content-Length is known (openSource().totalBytes) and commits the TRUE
    // transferred size on success / releases it on failure. An over-cap pull is
    // a PERMANENT failure (QuotaExceededError), recorded on the job without
    // retry. Absent => no cap, behaviour unchanged (opt-in).
    quota?: StorageQuotaGuard;
    // Best-effort operational log emission for the `ingest` stage (issue #995).
    // Optional: when absent no log record is appended and behaviour is unchanged.
    // Wired to the in-memory LogStore that backs GET /api/v1/logs (src/main.ts,
    // `logStore`). `logPipelineEvent` never throws, so this cannot make the
    // never-throws contract of runPull (see the doc comment above) any weaker.
    pipelineLog?: PipelineLogSink;
    pipelineLogErrors?: PipelineLogErrorLog;
  } & PullDeps
): Promise<void> {
  const { jobId, assetId, objectKey, sourceUrl } = params;
  const sleep = deps.sleep ?? defaultSleep;
  const baseBackoff = deps.baseBackoffMs ?? BASE_BACKOFF_MS;
  const cap = deps.maxBytes ?? maxSourceBytes();

  await deps.jobs.update(jobId, { status: 'running' });

  // Operational log: the `ingest` stage started (issue #995). Emitted once the
  // job is `running` — the point from which this worker owns the job's lifecycle
  // — and NOT per retry attempt, so a run appends a bounded number of entries.
  logPipelineEvent(
    deps.pipelineLog,
    {
      stage: 'ingest',
      level: 'info',
      message: `pulling source for asset ${assetId} (job ${jobId})`
    },
    deps.pipelineLogErrors
  );

  let lastError: unknown;
  // Attempts actually consumed, so the terminal-failure log entry reports the
  // real count (a permanent error breaks out at attempt 1 and never reaches
  // MAX_ATTEMPTS).
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    await deps.jobs.update(jobId, { attempts: attempt });
    let reservation;
    try {
      const parsed = parseSource(sourceUrl);
      if (parsed.scheme === 'http' || parsed.scheme === 'https') {
        await assertPublicHost(parsed.url.hostname);
      }
      const opened = await openSource(parsed, deps);

      // Reserve quota headroom sized by the remote Content-Length (when known)
      // BEFORE streaming bytes into MinIO (issue #579). Over-cap throws
      // QuotaExceededError, which isPermanent() treats as a non-retryable
      // terminal failure below. A missing Content-Length reserves 0 and relies
      // on the commit-time true size + reconciliation.
      reservation = deps.quota ? await deps.quota.admit(opened.totalBytes ?? 0) : undefined;

      // Start this write from a clean slate (issue #1088). A source bigger than
      // the storage client's part size is written as a multipart upload, and a
      // transfer that dies part-way leaves that upload open with its staged
      // parts intact. The client does not start fresh on the next write to the
      // same key — it RESUMES the open upload under part numbers that sit one
      // off the numbers the server staged the parts under, so the object can be
      // assembled from a duplicated or wrong-offset part (the full mechanism is
      // in WorkspaceStorage.abortIncompleteMultipartUploads). Discarding the
      // upload here removes the resume path entirely: every attempt gets a
      // fresh uploadId.
      //
      // Deliberately BEFORE the write rather than only after a failed attempt,
      // so it also clears an orphan this run did not create — one left by an
      // earlier job for the same object key, or by an abandoned client-driven
      // multipart session. This worker owns the object key for the asset it was
      // created with, so there is no concurrent writer to disturb. One list
      // call ahead of a potentially multi-gigabyte transfer.
      await discardOrphanedUpload(deps, objectKey, jobId);

      let lastWrite = 0;
      const { bytesTransferred } = await deps.storage.putStream(objectKey, opened.stream, {
        maxBytes: cap,
        totalBytes: opened.totalBytes,
        onProgress: (transferred, total) => {
          const now = Date.now();
          if (now - lastWrite < PROGRESS_INTERVAL_MS) return;
          lastWrite = now;
          const progress = total && total > 0 ? (transferred / total) * 100 : 0;
          void deps.jobs.update(jobId, {
            bytesTransferred: transferred,
            totalBytes: total,
            progress
          });
        }
      });

      // Commit the TRUE transferred size to the running total (issue #579).
      await reservation?.commit(bytesTransferred);

      // Success: finalize job at 100% and advance the asset to processing.
      await deps.jobs.update(jobId, {
        status: 'done',
        bytesTransferred,
        totalBytes: opened.totalBytes ?? bytesTransferred,
        progress: 100
      });
      await deps.assets.update(assetId, { status: 'processing' });
      // Operational log: the `ingest` stage reached terminal success (issue #995).
      logPipelineEvent(
        deps.pipelineLog,
        {
          stage: 'ingest',
          level: 'info',
          message: `asset ${assetId} (job ${jobId}) stored ${bytesTransferred} byte(s) to ${objectKey}`
        },
        deps.pipelineLogErrors
      );
      return;
    } catch (err) {
      // Release any reservation taken this attempt so a failed/retried pull
      // never permanently holds headroom (issue #579).
      await reservation?.release();
      lastError = err;
      deps.onAttemptError?.(attempt, err);
      if (isPermanent(err) || attempt === MAX_ATTEMPTS) {
        break;
      }
      // Exponential backoff: base * 2^(attempt-1).
      await sleep(baseBackoff * 2 ** (attempt - 1));
    }
  }

  // Terminal failure: nothing more will be written to this object key under
  // this job, so give back the multipart upload the last attempt left open
  // (issue #1088). The next write would have discarded it anyway, but a job
  // that is never redriven would otherwise leave staged part bytes sitting in
  // the bucket indefinitely.
  await discardOrphanedUpload(deps, objectKey, jobId);

  // Record the error on the job and move the asset to failed.
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await deps.jobs.update(jobId, { status: 'failed', error: message });
  await deps.assets.update(assetId, { status: 'failed' });
  // Operational log: the `ingest` stage reached terminal failure (issue #995).
  // One entry for the run's terminal outcome — the per-attempt errors stay on
  // `onAttemptError` so the log is not flooded by the retry loop.
  logPipelineEvent(
    deps.pipelineLog,
    {
      stage: 'ingest',
      level: 'error',
      message: `asset ${assetId} (job ${jobId}) failed after ${attemptsUsed} attempt(s): ${message}`
    },
    deps.pipelineLogErrors
  );
}
