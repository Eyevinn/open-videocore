// Asset version-chain read contract (issue #905, ADR-024).
//
// `GET /api/v1/assets/:id/versions` existed before this issue (#118) but its
// contract was never written down: nothing pinned the response envelope, how
// the current version is identified, the ordering, or whether a chain may
// branch. These tests pin all four against the real route + repository, so the
// documented contract in ADR-024 cannot drift from the running code:
//
//   - envelope is { assetId, versionGroupId?, currentVersionId, versions }
//   - `versions` is oldest-first by createdAt, tie-broken by id
//   - `currentVersionId` is SERVER-computed, always names a member, and is NOT
//     simply the last array element (archived members are skipped)
//   - a never-versioned asset is its own single-member chain with no group
//   - chains BRANCH: two versions cut from one source share a group and both
//     point at that source, and the endpoint returns the whole tree
//   - an unknown id is 404

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import {
  InMemoryAssetRepository,
  resolveVersionLinkage,
  type Asset
} from '../data/asset-repo.js';

type VersionsRead = {
  assetId: string;
  versionGroupId?: string;
  currentVersionId: string;
  versions: Asset[];
};

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

async function readVersions(
  app: Awaited<ReturnType<typeof buildApp>>,
  id: string
): Promise<VersionsRead> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/versions` });
  expect(res.statusCode).toBe(200);
  return res.json() as VersionsRead;
}

// Create a new version OF `source`, exactly the way the clip/rewrap pipelines
// do it (src/pipeline/clip.ts:147-164, src/pipeline/rewrap.ts:129-145): resolve
// the linkage, create the output carrying it, then backfill the source's group
// when it had none. Linkage is applied at CREATE deliberately —
// `versionOfAssetId` is immutable after create (asset-repo.ts:649-650), so
// `UpdateAssetInput` cannot set it and a test must not pretend otherwise.
async function createVersionOf(
  repo: InMemoryAssetRepository,
  sourceId: string,
  name: string
): Promise<Asset> {
  const source = (await repo.get(sourceId)) as Asset;
  expect(source).toBeDefined();
  const resolved = resolveVersionLinkage(source);
  const output = await repo.create({
    name,
    versionOfAssetId: resolved.versionOfAssetId,
    versionGroupId: resolved.versionGroupId
  });
  if (resolved.seedSourceGroup) {
    await repo.update(source.id, { versionGroupId: resolved.versionGroupId });
  }
  return output;
}

// createdAt is an ISO instant at millisecond resolution, so assets created in a
// tight loop can share one. Stamp distinct instants where ordering is the thing
// under test, and leave them equal where the id tiebreak is under test.
async function stampCreatedAt(
  repo: InMemoryAssetRepository,
  id: string,
  createdAt: string
): Promise<void> {
  const asset = await repo.get(id);
  expect(asset).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).store.set(id, { ...(asset as Asset), createdAt });
}

describe('GET /:id/versions — envelope and single-member chain', () => {
  it('returns the asset as its own chain, with no group, when it was never versioned', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const solo = await repo.create({ name: 'never-versioned' });

    const body = await readVersions(app, solo.id);

    expect(body.assetId).toBe(solo.id);
    expect(body.versions.map((v) => v.id)).toEqual([solo.id]);
    // No lineage has been seeded, so there is no group id to report.
    expect(body.versionGroupId).toBeUndefined();
    // The chain still has a well-defined current version: the asset itself.
    expect(body.currentVersionId).toBe(solo.id);

    await app.close();
  });

  it('404s an unknown asset id', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/01JQZZZZZZZZZZZZZZZZZZZZZZ/versions'
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });

    await app.close();
  });
});

describe('GET /:id/versions — membership, ordering and group', () => {
  it('returns every member of the lineage, oldest first, for any member queried', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const v1 = await createVersionOf(repo, source.id, 'v1');
    // A version cut FROM v1: linear continuation of the same lineage.
    const v2 = await createVersionOf(repo, v1.id, 'v2');

    await stampCreatedAt(repo, source.id, '2026-01-01T00:00:00.000Z');
    await stampCreatedAt(repo, v1.id, '2026-01-02T00:00:00.000Z');
    await stampCreatedAt(repo, v2.id, '2026-01-03T00:00:00.000Z');

    const expected = [source.id, v1.id, v2.id];

    // The chain is the same set in the same order no matter which member is
    // the entry point — the endpoint is group-scoped, not target-scoped.
    for (const entry of expected) {
      const body = await readVersions(app, entry);
      expect(body.assetId).toBe(entry);
      expect(body.versions.map((v) => v.id)).toEqual(expected);
      // The group is seeded to the original source's own id.
      expect(body.versionGroupId).toBe(source.id);
    }

    // v2 continues from v1, not from the source: linkage records the IMMEDIATE
    // predecessor, while the group spans the whole lineage.
    const body = await readVersions(app, source.id);
    const byId = new Map(body.versions.map((v) => [v.id, v]));
    expect(byId.get(source.id)?.versionOfAssetId).toBeUndefined();
    expect(byId.get(v1.id)?.versionOfAssetId).toBe(source.id);
    expect(byId.get(v2.id)?.versionOfAssetId).toBe(v1.id);

    await app.close();
  });

  it('breaks a createdAt tie by ascending id, so the order is total and stable', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const a = await createVersionOf(repo, source.id, 'a');
    const b = await createVersionOf(repo, source.id, 'b');

    // Every member shares one instant: only the id tiebreak can order them.
    const tie = '2026-02-01T00:00:00.000Z';
    for (const id of [source.id, a.id, b.id]) {
      await stampCreatedAt(repo, id, tie);
    }

    const body = await readVersions(app, source.id);
    const ids = body.versions.map((v) => v.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toHaveLength(3);

    await app.close();
  });
});

describe('GET /:id/versions — chain topology is a branching tree', () => {
  it('returns both branches when two versions are cut from the same source', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const left = await createVersionOf(repo, source.id, 'left-branch');
    // `right` is cut from the SAME source after the group already exists.
    const right = await createVersionOf(repo, source.id, 'right-branch');

    await stampCreatedAt(repo, source.id, '2026-03-01T00:00:00.000Z');
    await stampCreatedAt(repo, left.id, '2026-03-02T00:00:00.000Z');
    await stampCreatedAt(repo, right.id, '2026-03-03T00:00:00.000Z');

    const body = await readVersions(app, source.id);

    // All three are in one group: the chain is NOT strictly linear.
    expect(body.versions.map((v) => v.id)).toEqual([source.id, left.id, right.id]);
    expect(body.versionGroupId).toBe(source.id);

    // Two siblings naming the same predecessor is exactly what a branch looks
    // like, and it is representable — so consumers must treat the chain as a
    // tree rooted at the group id, not as a list.
    const byId = new Map(body.versions.map((v) => [v.id, v]));
    expect(byId.get(left.id)?.versionOfAssetId).toBe(source.id);
    expect(byId.get(right.id)?.versionOfAssetId).toBe(source.id);

    await app.close();
  });
});

describe('GET /:id/versions — current-version identification', () => {
  it('names the newest member, and serves it as a field rather than leaving it to the client', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const v1 = await createVersionOf(repo, source.id, 'v1');

    await stampCreatedAt(repo, source.id, '2026-04-01T00:00:00.000Z');
    await stampCreatedAt(repo, v1.id, '2026-04-02T00:00:00.000Z');

    const body = await readVersions(app, source.id);

    expect(body.currentVersionId).toBe(v1.id);
    // The field is always present and always resolvable within the payload.
    expect(body.versions.some((v) => v.id === body.currentVersionId)).toBe(true);

    await app.close();
  });

  it('skips archived members, so the current version is not the last array element', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const v1 = await createVersionOf(repo, source.id, 'v1');
    const v2 = await createVersionOf(repo, v1.id, 'v2-soft-deleted');

    await stampCreatedAt(repo, source.id, '2026-05-01T00:00:00.000Z');
    await stampCreatedAt(repo, v1.id, '2026-05-02T00:00:00.000Z');
    await stampCreatedAt(repo, v2.id, '2026-05-03T00:00:00.000Z');

    // Soft-delete the newest version.
    await repo.remove(v2.id);

    const body = await readVersions(app, source.id);

    // Archived members stay in the chain: this is lineage history.
    expect(body.versions.map((v) => v.id)).toEqual([source.id, v1.id, v2.id]);
    // ...but the archived head is NOT the current version. This is the case
    // that makes "last element of the array" the wrong client-side heuristic.
    expect(body.versions[body.versions.length - 1].id).toBe(v2.id);
    expect(body.currentVersionId).toBe(v1.id);

    await app.close();
  });

  it('falls back to the newest member when the whole lineage is archived', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const source = await repo.create({ name: 'source' });
    const v1 = await createVersionOf(repo, source.id, 'v1');

    await stampCreatedAt(repo, source.id, '2026-06-01T00:00:00.000Z');
    await stampCreatedAt(repo, v1.id, '2026-06-02T00:00:00.000Z');

    await repo.remove(v1.id);
    await repo.remove(source.id);

    const body = await readVersions(app, source.id);

    // An entirely archived lineage still reports a head rather than omitting
    // the field, so the contract stays non-optional.
    expect(body.currentVersionId).toBe(v1.id);

    await app.close();
  });
});
