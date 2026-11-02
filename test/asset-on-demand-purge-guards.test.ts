// Integrity guards on the on-demand purge (issue #837, review follow-up).
//
// The on-demand route (DELETE /api/v1/assets/:id/purge) destroys bytes, so its
// eligibility set must be no weaker than the soft delete's. These tests pin the
// three guards the first cut was missing:
//
//   (1) 409 `has_children` — an archived PARENT with a LIVE (non-archived) child
//       is refused, the route equivalent of the sweep's child-ordering deferral
//       (anyLiveChild, src/pipeline/archived-asset-purge-sweep.ts). Without it
//       the child would be left pointing at a tombstone. An ARCHIVED child does
//       not block (countChildren excludes archived children), and purging the
//       child first unblocks the parent.
//   (2) 409 `shared_objects` — `objectKey` is a client-settable field on
//       POST /api/v1/assets and PATCH /api/v1/assets/{id} (accepted even while
//       the asset is archived), so a caller can aim their own archived asset at
//       another asset's bytes. The purge is refused when any object it would
//       remove is also referenced by another live asset — including when the
//       other asset is delete-locked, whose bytes would otherwise be destroyed
//       through the back door. Nothing is removed on refusal.
//   (3) 409 `delete_blocked` / `referenced_by_job` — an active job still naming
//       the asset as its source blocks the purge exactly as it blocks
//       DELETE /:id (archiving does not cancel jobs).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Route + guard order: src/routes/assets.ts `app.delete('/:id/purge', ...)`
//     (response schema `409: z.union([deleteBlockedSchema, errorSchema])`)
//   - `has_children` envelope: `HasChildrenError` (src/data/asset-repo.ts) mapped
//     to `{ error: 'has_children', message }` in this router's error handler
//   - `countChildren(id)` semantics (non-archived children only):
//     src/data/asset-repo.ts InMemoryAssetRepository.countChildren and
//     src/data/couch-asset-repo.ts countChildren (`state: { $ne: 'archived' }`)
//   - `referenced_by_job` envelope: `ReferencedByJobError` + `findActiveByAssetId`
//     — src/data/asset-repo.ts, src/data/job-repo.ts (`JobRepository`)
//   - `CreateAssetInput.parentId` / `.objectKey`, `UpdateAssetInput.objectKey`:
//     src/data/asset-repo.ts
//   - Removal/tombstone path driven by the route: `purgeArchivedAsset` /
//     `PurgeStorage` — src/pipeline/archived-asset-purge-sweep.ts
//   - openapi.json .paths["/api/v1/assets/{id}/purge"].delete.responses["409"]
//     — the bare `{ error, message? }` arm already covers both new codes, so the
//     documented response set is unchanged (204/404/409/410/501)

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository, type Asset } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { packagedBucket } from '../src/pipeline/packaging.js';
import type { PurgeStorage } from '../src/pipeline/archived-asset-purge-sweep.js';

const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = packagedBucket();

class FakeStorage implements PurgeStorage {
  readonly removed: string[] = [];
  readonly removedPrefixes: string[] = [];
  async removeObject(localKey: string): Promise<void> {
    this.removed.push(localKey);
  }
  async removeObjectsUnderPrefix(prefix: string): Promise<void> {
    this.removedPrefixes.push(prefix);
  }
}

type Harness = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  buckets: Record<string, FakeStorage>;
};

async function buildHarness(): Promise<Harness> {
  const repo = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const buckets: Record<string, FakeStorage> = {
    [SOURCE_BUCKET]: new FakeStorage(),
    [PACKAGED_BUCKET]: new FakeStorage()
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    jobRepository: jobs,
    sourceBucket: SOURCE_BUCKET,
    purgeStorageForBucket: (bucket: string) => buckets[bucket],
    // Retention DISABLED (0 = never purge): the on-demand route is independent
    // of the global window, so the guards are what decide every outcome here.
    retentionMs: () => 0
  });
  await app.ready();
  return { app, repo, jobs, buckets };
}

// Drive an asset through the ordinary lifecycle to `ready`, then optionally to
// `archived` (the only state the purge route accepts).
async function makeAsset(
  repo: InMemoryAssetRepository,
  input: { name: string; objectKey?: string; parentId?: string },
  status: 'ready' | 'archived'
): Promise<Asset> {
  const created = await repo.create({
    name: input.name,
    objectKey: input.objectKey ?? `sources/${input.name}.mp4`,
    parentId: input.parentId
  });
  await repo.update(created.id, { status: 'processing' });
  await repo.update(created.id, { status: 'ready' });
  if (status === 'archived') {
    await repo.update(created.id, { status: 'archived' });
  }
  return (await repo.get(created.id))!;
}

const purge = (h: Harness, id: string) =>
  h.app.inject({ method: 'DELETE', url: `/api/v1/assets/${id}/purge` });

function expectNothingRemoved(h: Harness): void {
  expect(h.buckets[SOURCE_BUCKET]!.removed).toEqual([]);
  expect(h.buckets[PACKAGED_BUCKET]!.removed).toEqual([]);
  expect(h.buckets[SOURCE_BUCKET]!.removedPrefixes).toEqual([]);
  expect(h.buckets[PACKAGED_BUCKET]!.removedPrefixes).toEqual([]);
}

describe('DELETE /api/v1/assets/:id/purge — integrity guards (issue #837 review)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('refuses to purge an archived parent with a LIVE child (409 has_children)', async () => {
    const parent = await makeAsset(h.repo, { name: 'parent-clip' }, 'archived');
    await makeAsset(h.repo, { name: 'child-rendition', parentId: parent.id }, 'ready');

    const res = await purge(h, parent.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('has_children');

    // Nothing destroyed: the child still points at a live parent document.
    expectNothingRemoved(h);
    expect((await h.repo.getState(parent.id)).kind).toBe('asset');
  });

  it('purges the parent once its child is archived, and purging the child first unblocks it', async () => {
    const parent = await makeAsset(h.repo, { name: 'drain-parent' }, 'archived');
    const child = await makeAsset(
      h.repo,
      { name: 'drain-child', parentId: parent.id },
      'archived'
    );

    // An ARCHIVED child does not block (countChildren counts non-archived only),
    // mirroring the sweep's notion of a live child. Children drain first.
    expect((await purge(h, child.id)).statusCode).toBe(204);
    expect((await purge(h, parent.id)).statusCode).toBe(204);
    expect((await h.repo.getState(parent.id)).kind).toBe('tombstone');
    expect((await h.repo.getState(child.id)).kind).toBe('tombstone');
  });

  it('refuses to purge when another live asset references the same objectKey (409 shared_objects)', async () => {
    const shared = 'sources/shared-master.mp4';
    const victim = await makeAsset(h.repo, { name: 'victim', objectKey: shared }, 'ready');
    // The attacker's own asset, archived and re-pointed at the victim's bytes —
    // the PATCH-on-archived path the route can no longer trust.
    const decoy = await makeAsset(h.repo, { name: 'decoy' }, 'archived');
    await h.repo.update(decoy.id, { objectKey: shared });

    const res = await purge(h, decoy.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('shared_objects');
    expect(res.json().message).toContain(victim.id);

    // The victim's bytes are untouched and its document is unchanged.
    expectNothingRemoved(h);
    expect((await h.repo.get(victim.id))?.objectKey).toBe(shared);
    expect((await h.repo.getState(decoy.id)).kind).toBe('asset');
  });

  it('refuses when the shared objectKey belongs to a DELETE-LOCKED asset', async () => {
    const shared = 'sources/legal-hold.mp4';
    const locked = await makeAsset(h.repo, { name: 'under-hold', objectKey: shared }, 'ready');
    await h.repo.setDeleteLock(locked.id, { locked: true, reason: 'legal hold' });
    const decoy = await makeAsset(h.repo, { name: 'hold-decoy' }, 'archived');
    await h.repo.update(decoy.id, { objectKey: shared });

    const res = await purge(h, decoy.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('shared_objects');
    // The lock protects the document; this guard protects its bytes.
    expectNothingRemoved(h);
    expect((await h.repo.get(locked.id))?.deleteLock?.locked).toBe(true);
  });

  it('refuses when another asset references one of this asset’s rendition keys', async () => {
    const renditionKey = `s3://${PACKAGED_BUCKET}/transcode/shared/1080p.mp4`;
    const owner = await makeAsset(h.repo, { name: 'rendition-owner' }, 'archived');
    const other = await makeAsset(h.repo, { name: 'rendition-sharer' }, 'ready');
    // Reach into the store for the rendition arrays (as the sweep tests do):
    // renditions are pipeline-written, not part of the create/patch body.
    for (const id of [owner.id, other.id]) {
      const current = (await h.repo.get(id))!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.repo as any).store.set(id, {
        ...current,
        renditions: [
          { id: 'R1', label: '1080p', width: 1920, height: 1080, objectKey: renditionKey }
        ]
      });
    }

    const res = await purge(h, owner.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('shared_objects');
    expect(res.json().message).toContain(other.id);
    expectNothingRemoved(h);
  });

  it('purges normally when no other asset shares its objects', async () => {
    await makeAsset(h.repo, { name: 'unrelated', objectKey: 'sources/unrelated.mp4' }, 'ready');
    const mine = await makeAsset(h.repo, { name: 'mine', objectKey: 'sources/mine.mp4' }, 'archived');

    expect((await purge(h, mine.id)).statusCode).toBe(204);
    expect(h.buckets[SOURCE_BUCKET]!.removed).toContain('sources/mine.mp4');
    expect(h.buckets[SOURCE_BUCKET]!.removed).not.toContain('sources/unrelated.mp4');
    expect((await h.repo.getState(mine.id)).kind).toBe('tombstone');
  });

  it('refuses to purge while an ACTIVE job still references the asset (409 referenced_by_job)', async () => {
    const asset = await makeAsset(h.repo, { name: 'job-bound' }, 'archived');
    const job = await h.jobs.create({ type: 'transcode', assetId: asset.id });

    const res = await purge(h, asset.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('delete_blocked');
    expect(res.json().reason).toBe('referenced_by_job');
    expect(res.json().blockedBy).toEqual({ jobIds: [job.id], collectionIds: [] });
    expectNothingRemoved(h);
    expect((await h.repo.getState(asset.id)).kind).toBe('asset');

    // Once the job settles the purge proceeds, as on DELETE /:id.
    await h.jobs.update(job.id, { status: 'running' });
    await h.jobs.update(job.id, { status: 'done' });
    expect((await purge(h, asset.id)).statusCode).toBe(204);
    expect((await h.repo.getState(asset.id)).kind).toBe('tombstone');
  });
});
