// Ingest-method availability for the status/health surface (issue #644).
//
// Operators had no way to tell whether a given ingest method (direct upload,
// URL pull, watch folder) was active, unavailable, or misconfigured in a given
// environment — the watch-folder in particular could silently be off because
// its opt-in flag was set but no object storage endpoint was configured, and
// that only surfaced by reading server logs. This module derives a small,
// machine-readable availability snapshot from the SAME configuration signals
// the wiring in main.ts uses to decide whether each path is enabled, so the
// state is discoverable programmatically via /health.
//
// Signals (verified against src/main.ts):
//   - storageAvailable  = Boolean(MINIO_URL) || Boolean(parameter store)
//                         gates the direct-upload + URL-pull routes
//                         (src/main.ts:485, asset-upload wiring src/main.ts:1398)
//   - envMinioClient    = present only when MINIO_URL is set (src/main.ts:697)
//                         the watch-folder needs a single concrete MinIO client,
//                         so it is only wired for the explicit env-override path
//   - WATCH_FOLDER_ENABLED === 'true'  (watchFolderEnabled(), watch-folder.ts:60)
//                         opt-in flag; the service is off by default
//
// The watch-folder classification mirrors the same signals a sibling task (#642)
// classifies in src/pipeline/watch-folder.ts. That branch is unmerged, so this
// module computes availability independently from the raw signals rather than
// importing an as-yet-nonexistent helper; the watchFolderEnabled() reader IS
// reused so the opt-in semantics stay in one place.

import { watchFolderEnabled } from '../pipeline/watch-folder.js';

// Why an ingest method is unavailable, machine-readable so integrators/support
// can branch on it without parsing prose.
export type IngestUnavailableReason =
  // No object storage endpoint is configured (no MINIO_URL and no parameter
  // store) — the upload/URL-pull routes are wired to 501 and the watch-folder
  // has no bucket to watch.
  | 'no-storage-endpoint'
  // The watch-folder opt-in flag (WATCH_FOLDER_ENABLED) is not set to 'true'.
  | 'not-enabled'
  // The watch-folder opt-in flag is set, but it needs a single concrete MinIO
  // endpoint (MINIO_URL); a provisioned-stack-only deployment has no single
  // bucket to watch, so the flag alone cannot enable it.
  | 'missing-storage-endpoint';

// Availability of one ingest method. `available` is the single boolean an
// integrator checks; `reason` is populated only when unavailable.
export type IngestMethodAvailability = {
  available: boolean;
  reason?: IngestUnavailableReason;
};

// Availability of every ingest method, reported together for consistency so a
// caller sees the whole ingest surface in one read.
export type IngestAvailability = {
  directUpload: IngestMethodAvailability;
  urlPull: IngestMethodAvailability;
  watchFolder: IngestMethodAvailability;
};

// The configuration signals ingest availability is derived from. Injected (not
// read from process.env here) so the classification is pure and unit-testable
// without mutating global env — main.ts passes the values it already computed.
export type IngestAvailabilitySignals = {
  // Whether ANY object storage is reachable (explicit env override OR a
  // provisioned stack). Mirrors `storageAvailable` in main.ts.
  storageAvailable: boolean;
  // Whether a single concrete global MinIO endpoint (MINIO_URL) is present.
  // Mirrors the `envMinioClient` presence check in main.ts.
  hasEnvMinio: boolean;
  // Whether the watch-folder opt-in flag is set. Defaults to reading
  // watchFolderEnabled() so callers may omit it.
  watchFolderFlag?: boolean;
};

// Direct upload and URL pull share the same prerequisite: some object storage
// endpoint must be configured. When it is not, both report the same reason.
function storageGatedMethod(storageAvailable: boolean): IngestMethodAvailability {
  return storageAvailable
    ? { available: true }
    : { available: false, reason: 'no-storage-endpoint' };
}

// Classify the watch folder specifically. Three distinguishable states:
//   - not enabled:   the opt-in flag is off (regardless of storage)
//   - misconfigured: the flag is on but no single MINIO_URL endpoint exists
//   - ready:         the flag is on and a MINIO_URL endpoint exists
function watchFolderMethod(
  hasEnvMinio: boolean,
  flag: boolean
): IngestMethodAvailability {
  if (!flag) return { available: false, reason: 'not-enabled' };
  if (!hasEnvMinio) return { available: false, reason: 'missing-storage-endpoint' };
  return { available: true };
}

// Derive the full ingest-availability snapshot from the configuration signals.
// Pure: no I/O, no env mutation. `watchFolderFlag` falls back to the shared
// watchFolderEnabled() reader when the caller does not supply it.
export function computeIngestAvailability(
  signals: IngestAvailabilitySignals
): IngestAvailability {
  const flag = signals.watchFolderFlag ?? watchFolderEnabled();
  return {
    directUpload: storageGatedMethod(signals.storageAvailable),
    urlPull: storageGatedMethod(signals.storageAvailable),
    watchFolder: watchFolderMethod(signals.hasEnvMinio, flag)
  };
}
