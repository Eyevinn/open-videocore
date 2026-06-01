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
// not write to CouchDB on every chunk.

import type { AssetRepository } from '../data/asset-repo.js';
import type { JobRepository } from '../data/job-repo.js';
import { SourceTooLargeError, type WorkspaceStorage } from '../data/storage.js';
import {
  assertPublicHost,
  openSource,
  parseSource,
  SourceValidationError,
  type SourceDeps
} from './source.js';

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
  return err instanceof SourceTooLargeError || err instanceof SourceValidationError;
}

export type PullParams = {
  workspaceId: string;
  jobId: string;
  assetId: string;
  objectKey: string;
  sourceUrl: string;
};

// Run one pull job to a terminal state. Resolves when the job is done/failed;
// it never throws (failures are recorded on the job), so it is safe to invoke
// detached with `void runPull(...)`.
export async function runPull(
  params: PullParams,
  deps: {
    jobs: JobRepository;
    assets: AssetRepository;
    storage: WorkspaceStorage;
  } & PullDeps
): Promise<void> {
  const { workspaceId, jobId, assetId, objectKey, sourceUrl } = params;
  const sleep = deps.sleep ?? defaultSleep;
  const baseBackoff = deps.baseBackoffMs ?? BASE_BACKOFF_MS;
  const cap = deps.maxBytes ?? maxSourceBytes();

  await deps.jobs.update(workspaceId, jobId, { status: 'running' });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await deps.jobs.update(workspaceId, jobId, { attempts: attempt });
    try {
      const parsed = parseSource(sourceUrl);
      if (parsed.scheme === 'http' || parsed.scheme === 'https') {
        await assertPublicHost(parsed.url.hostname);
      }
      const opened = await openSource(parsed, deps);

      let lastWrite = 0;
      const { bytesTransferred } = await deps.storage.putStream(objectKey, opened.stream, {
        maxBytes: cap,
        totalBytes: opened.totalBytes,
        onProgress: (transferred, total) => {
          const now = Date.now();
          if (now - lastWrite < PROGRESS_INTERVAL_MS) return;
          lastWrite = now;
          const progress = total && total > 0 ? (transferred / total) * 100 : 0;
          void deps.jobs.update(workspaceId, jobId, {
            bytesTransferred: transferred,
            totalBytes: total,
            progress
          });
        }
      });

      // Success: finalize job at 100% and advance the asset to processing.
      await deps.jobs.update(workspaceId, jobId, {
        status: 'done',
        bytesTransferred,
        totalBytes: opened.totalBytes ?? bytesTransferred,
        progress: 100
      });
      await deps.assets.update(workspaceId, assetId, { status: 'processing' });
      return;
    } catch (err) {
      lastError = err;
      deps.onAttemptError?.(attempt, err);
      if (isPermanent(err) || attempt === MAX_ATTEMPTS) {
        break;
      }
      // Exponential backoff: base * 2^(attempt-1).
      await sleep(baseBackoff * 2 ** (attempt - 1));
    }
  }

  // Terminal failure: record the error on the job and move the asset to failed.
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await deps.jobs.update(workspaceId, jobId, { status: 'failed', error: message });
  await deps.assets.update(workspaceId, assetId, { status: 'failed' });
}
