// Block asset deletion while referenced by an in-flight job (issue #569,
// contract ADR-020).
//
// Verifies the referenced-by-job mechanism end to end against the assets router:
//   - DELETE /:id returns 409 with the shared `delete_blocked` envelope (reason
//     `referenced_by_job`) naming the in-flight job ids in `blockedBy.jobIds`
//     while an active (pending/queued/running) job references the asset.
//   - `?force=true` does NOT bypass an active reference (ADR-020 decision 2:
//     active-job references are a hard block; only settled jobs are forceable).
//   - Once the job settles (done/failed/cancelled) the asset deletes as today.
//   - An asset with no referencing job deletes as today (204 -> archived).
//   - The pre-existing rendition-child block (`has_children`) is unchanged.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { InMemoryAssetRepository, type Asset } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';

async function buildApp(repo: InMemoryAssetRepository, jobs: InMemoryJobRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    jobRepository: jobs
  });
  await app.ready();
  return app;
}

async function createAsset(repo: InMemoryAssetRepository): Promise<Asset> {
  return repo.create({ name: 'source-asset' });
}

describe('block asset deletion while referenced by an in-flight job (issue #569)', () => {
  it('blocks DELETE with 409 referenced_by_job and names the blocking job ids', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo, jobs);

    // An in-flight transcode job referencing the asset as its source (a fresh
    // job starts `pending`, which is in ACTIVE_JOB_STATUSES).
    const job = await jobs.create({ type: 'transcode', assetId: asset.id });

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'referenced_by_job',
      blockedBy: { jobIds: [job.id], collectionIds: [] }
    });

    // Untouched — not archived.
    expect((await repo.get(asset.id))?.status).not.toBe('archived');
  });

  it('blocks a running job reference and does NOT let ?force=true bypass it', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo, jobs);

    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    await jobs.update(job.id, { status: 'running' });

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}?force=true`
    });
    expect(forced.statusCode).toBe(409);
    expect((forced.json() as { reason: string }).reason).toBe('referenced_by_job');
    // force did not archive the asset.
    expect((await repo.get(asset.id))?.status).not.toBe('archived');
  });

  it('allows DELETE once the referencing job has settled (terminal)', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo, jobs);

    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    // Drive to a terminal state (pending -> running -> done).
    await jobs.update(job.id, { status: 'running' });
    await jobs.update(job.id, { status: 'done' });

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('deletes as today when no job references the asset', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo, jobs);

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('only blocks on the asset the job references, not unrelated assets', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const referenced = await repo.create({ name: 'referenced' });
    const unrelated = await repo.create({ name: 'unrelated' });
    const app = await buildApp(repo, jobs);

    await jobs.create({ type: 'transcode', assetId: referenced.id });

    // The unrelated asset deletes fine.
    const okRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${unrelated.id}` });
    expect(okRes.statusCode).toBe(204);

    // The referenced asset is still blocked.
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${referenced.id}` });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { reason: string }).reason).toBe('referenced_by_job');
  });

  it('preserves the rendition-child block (has_children) unchanged', async () => {
    const repo = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const parent = await repo.create({ name: 'parent' });
    // A rendition child referencing the parent triggers the pre-existing block.
    await repo.create({ name: 'rendition', parentId: parent.id });
    const app = await buildApp(repo, jobs);

    // No job references the parent; the child block must still fire.
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${parent.id}` });
    expect(blocked.statusCode).toBe(409);
    // Unchanged legacy envelope: `has_children`, NOT `delete_blocked`.
    expect((blocked.json() as { error: string }).error).toBe('has_children');
  });
});
