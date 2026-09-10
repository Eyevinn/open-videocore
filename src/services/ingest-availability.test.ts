import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { computeIngestAvailability } from './ingest-availability.js';

// WATCH_FOLDER_ENABLED is read via watchFolderEnabled() only when the caller
// omits watchFolderFlag; saved + restored so the fallback-path test does not
// leak env state (mirrors resolver-health.test.ts).
const SAVED = { flag: process.env['WATCH_FOLDER_ENABLED'] };

beforeEach(() => {
  delete process.env['WATCH_FOLDER_ENABLED'];
});

afterEach(() => {
  if (SAVED.flag === undefined) delete process.env['WATCH_FOLDER_ENABLED'];
  else process.env['WATCH_FOLDER_ENABLED'] = SAVED.flag;
});

describe('computeIngestAvailability (issue #644)', () => {
  it('reports direct upload + URL pull available when storage is configured', () => {
    const a = computeIngestAvailability({
      storageAvailable: true,
      hasEnvMinio: true,
      watchFolderFlag: false
    });
    expect(a.directUpload).toEqual({ available: true });
    expect(a.urlPull).toEqual({ available: true });
  });

  it('reports direct upload + URL pull unavailable with a machine-readable reason when no storage endpoint', () => {
    const a = computeIngestAvailability({
      storageAvailable: false,
      hasEnvMinio: false,
      watchFolderFlag: false
    });
    expect(a.directUpload).toEqual({
      available: false,
      reason: 'no-storage-endpoint'
    });
    expect(a.urlPull).toEqual({
      available: false,
      reason: 'no-storage-endpoint'
    });
  });

  it('reports watch folder unavailable (not-enabled) when the opt-in flag is off', () => {
    const a = computeIngestAvailability({
      storageAvailable: true,
      hasEnvMinio: true,
      watchFolderFlag: false
    });
    expect(a.watchFolder).toEqual({
      available: false,
      reason: 'not-enabled'
    });
  });

  it('reports watch folder unavailable (missing-storage-endpoint) when enabled but no MINIO_URL', () => {
    const a = computeIngestAvailability({
      // A provisioned-stack-only deployment: storage exists for uploads via the
      // param store, but there is no single global MinIO endpoint to watch.
      storageAvailable: true,
      hasEnvMinio: false,
      watchFolderFlag: true
    });
    expect(a.watchFolder).toEqual({
      available: false,
      reason: 'missing-storage-endpoint'
    });
  });

  it('reports watch folder available only when enabled AND a MINIO_URL endpoint exists', () => {
    const a = computeIngestAvailability({
      storageAvailable: true,
      hasEnvMinio: true,
      watchFolderFlag: true
    });
    expect(a.watchFolder).toEqual({ available: true });
  });

  it('falls back to the WATCH_FOLDER_ENABLED env flag when watchFolderFlag is omitted', () => {
    process.env['WATCH_FOLDER_ENABLED'] = 'true';
    const enabled = computeIngestAvailability({
      storageAvailable: true,
      hasEnvMinio: true
    });
    expect(enabled.watchFolder).toEqual({ available: true });

    delete process.env['WATCH_FOLDER_ENABLED'];
    const disabled = computeIngestAvailability({
      storageAvailable: true,
      hasEnvMinio: true
    });
    expect(disabled.watchFolder).toEqual({
      available: false,
      reason: 'not-enabled'
    });
  });
});
