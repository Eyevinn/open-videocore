// Integration tests for the total storage cap on URL-PULL ingest (issue #579,
// ADR-020). The worker reserves quota headroom sized by the remote
// Content-Length (openSource().totalBytes) BEFORE streaming, commits the true
// transferred size on success, and releases on failure. Over-cap is a PERMANENT
// job failure (no retry).
//
// Uses an s3:// source with an injected openS3 reader so the test is hermetic
// (no network, no SSRF DNS lookup — only http/https hosts are resolved).

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

import { runPull } from './url-pull-worker.js';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';
import { InMemoryStorageQuotaStore, StorageQuotaGuard } from '../data/storage-quota.js';

function fakeJobs() {
  const updates: Record<string, unknown>[] = [];
  const jobs = {
    create: vi.fn(),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return {} as never;
    }),
    get: vi.fn(),
    list: vi.fn(),
    findByEncoreJobId: vi.fn()
  } as unknown as JobRepository;
  return { jobs, updates };
}

function fakeAssets() {
  const updates: Record<string, unknown>[] = [];
  const assets = {
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return {} as never;
    })
  } as unknown as AssetRepository;
  return { assets, updates };
}

// putStream reports totalBytes as the transferred count (stream fully drained).
function fakeStorage(): WorkspaceStorage {
  return {
    async putStream(_key: string, _src: Readable, opts: { totalBytes?: number }) {
      return { etag: 'e', bytesTransferred: opts.totalBytes ?? 0 };
    }
  } as unknown as WorkspaceStorage;
}

// openS3 yields an empty stream with a declared totalBytes (the remote size).
function openS3For(totalBytes: number) {
  return async () => ({ stream: Readable.from([]), totalBytes });
}

describe('URL-pull ingest — storage cap (issue #579)', () => {
  it('fails the job with quota_exceeded when the pull would exceed the cap (permanent, no retry)', async () => {
    const { jobs, updates: jobUpdates } = fakeJobs();
    const { assets, updates: assetUpdates } = fakeAssets();
    const guard = new StorageQuotaGuard({
      store: new InMemoryStorageQuotaStore({ consumedBytes: 900 }),
      capBytes: () => 1000
    });

    await runPull(
      { jobId: 'j1', assetId: 'a1', objectKey: 'ingest/a1', sourceUrl: 's3://b/clip.mp4' },
      { jobs, assets, storage: fakeStorage(), quota: guard, openS3: openS3For(200) }
    );

    const failed = jobUpdates.find((u) => u['status'] === 'failed');
    expect(failed).toBeDefined();
    expect(String(failed?.['error'])).toMatch(/quota/i);
    expect(assetUpdates.some((u) => u['status'] === 'failed')).toBe(true);
    // Permanent failure => only one attempt recorded (no retries).
    const attempts = jobUpdates.filter((u) => typeof u['attempts'] === 'number');
    expect(attempts).toHaveLength(1);
  });

  it('succeeds under the cap and commits the true transferred size', async () => {
    const { jobs, updates: jobUpdates } = fakeJobs();
    const { assets, updates: assetUpdates } = fakeAssets();
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });

    await runPull(
      { jobId: 'j2', assetId: 'a2', objectKey: 'ingest/a2', sourceUrl: 's3://b/clip.mp4' },
      { jobs, assets, storage: fakeStorage(), quota: guard, openS3: openS3For(300) }
    );

    expect(jobUpdates.some((u) => u['status'] === 'done')).toBe(true);
    expect(assetUpdates.some((u) => u['status'] === 'processing')).toBe(true);
    const c = await store.read();
    expect(c.consumedBytes).toBe(300);
    expect(c.reservedBytes).toBe(0);
  });

  it('no cap configured => pull succeeds unchanged (opt-in)', async () => {
    const { jobs, updates: jobUpdates } = fakeJobs();
    const { assets } = fakeAssets();
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 10 ** 12 });
    const guard = new StorageQuotaGuard({ store, capBytes: () => undefined });

    await runPull(
      { jobId: 'j3', assetId: 'a3', objectKey: 'ingest/a3', sourceUrl: 's3://b/clip.mp4' },
      { jobs, assets, storage: fakeStorage(), quota: guard, openS3: openS3For(5000) }
    );
    expect(jobUpdates.some((u) => u['status'] === 'done')).toBe(true);
    expect((await store.read()).consumedBytes).toBe(10 ** 12 + 5000);
  });

  it('no quota guard wired => pull succeeds unchanged', async () => {
    const { jobs, updates: jobUpdates } = fakeJobs();
    const { assets } = fakeAssets();
    await runPull(
      { jobId: 'j4', assetId: 'a4', objectKey: 'ingest/a4', sourceUrl: 's3://b/clip.mp4' },
      { jobs, assets, storage: fakeStorage(), openS3: openS3For(5000) }
    );
    expect(jobUpdates.some((u) => u['status'] === 'done')).toBe(true);
  });

  it('concurrent race: two pulls that together exceed the cap admit exactly one', async () => {
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });

    const run = (n: number) => {
      const { jobs } = fakeJobs();
      const { assets } = fakeAssets();
      return runPull(
        { jobId: `j${n}`, assetId: `a${n}`, objectKey: `ingest/a${n}`, sourceUrl: 's3://b/c.mp4' },
        { jobs, assets, storage: fakeStorage(), quota: guard, openS3: openS3For(600) }
      );
    };

    await Promise.all([run(1), run(2)]);
    // Exactly one pull's bytes committed; the other was rejected + released.
    expect((await store.read()).consumedBytes).toBe(600);
    expect((await store.read()).reservedBytes).toBe(0);
  });
});
