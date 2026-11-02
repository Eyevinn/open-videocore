// On-demand purge of ONE archived asset (issue #837).
//
// Before #837 the only purge was the timed retention sweep driven by the
// instance-global window that defaults to 0 = never purge, so `archived` was
// terminal. These tests pin the per-asset route that replaces that gap:
//
//   (1) an archived asset is purged on demand — stored objects removed across
//       buckets and the document replaced by a tombstone — with the retention
//       window left at 0 (disabled), proving the purge is independent of policy;
//   (2) a NON-archived asset cannot be purged (409 `not_archived`, bytes intact);
//   (3) a DELETE-LOCKED asset cannot be purged (409 `delete_blocked` /
//       `delete_protected`, bytes intact) — exactly as archiving is refused;
//   (4) after a purge the objects are gone and reads return 410 Gone, consistent
//       with the tombstone machinery of #326;
//   (5) the purge is recorded in the audit log as `asset.purged`.
//
// Driven through the SAME InMemoryAssetRepository the tombstone (#326) and sweep
// (#327) tests use, so purgeToTombstone / getState behave as in production;
// storage is a per-bucket in-memory fake asserting the exact keys and prefixes
// removed (the same fake shape as test/archived-asset-purge-sweep.test.ts).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - openapi.json .paths["/api/v1/assets/{id}/purge"].delete
//       .parameters => `id` (path, required, string); no query parameters
//       .responses  => exactly 204 / 404 / 409 / 410 / 501
//       .responses["409"] => the SAME anyOf as DELETE /api/v1/assets/{id}
//         (`deleteBlockedSchema` arm + the bare `{ error, message? }` arm)
//   - Route + guards: src/routes/assets.ts `app.delete('/:id/purge', ...)`
//   - Shared per-asset purge path: `purgeArchivedAsset` /
//     `PurgeArchivedAssetDeps` / `PurgeStorage` —
//     src/pipeline/archived-asset-purge-sweep.ts
//   - 410 tombstone read semantics: `getState` -> `{ kind: 'tombstone' }`,
//     src/data/asset-repo.ts (InMemoryAssetRepository.getState /
//     purgeToTombstone); route mapping in GET /:id (`{ error: 'gone' }`)
//   - Delete-lock envelope: `deleteBlockedSchema` + `DeleteProtectedError`
//     (src/data/asset-repo.ts) mapped to 409 `delete_blocked` /
//     `delete_protected` with empty `blockedBy` in this router's error handler
//   - Delete-lock write seam: `setDeleteLock(id, { locked, reason? })`,
//     `SetDeleteLockInput` — src/data/asset-repo.ts
//   - Audit emission shape: `emitAudit` / `originActor` / `AuditEmitter.record`
//     — src/data/audit-emit.ts; `RecordAuditInput` — src/data/audit-repo.ts
//   - Packaged prefix + bucket: `outputPrefix(assetId)` / `packagedBucket()` —
//     src/pipeline/packaging.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository, type Asset } from '../src/data/asset-repo.js';
import { outputPrefix, packagedBucket } from '../src/pipeline/packaging.js';
import type { PurgeStorage } from '../src/pipeline/archived-asset-purge-sweep.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = packagedBucket();

// Per-bucket in-memory storage fake recording removals, so the test asserts the
// exact cross-bucket keys + prefixes the purge reaps. Implements the minimal
// PurgeStorage surface (removeObject / removeObjectsUnderPrefix).
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

// A minimal AuditEmitter (src/data/audit-emit.ts): records every entry so the
// test can assert the purge is audited. Emission is fire-and-forget, so tests
// flush microtasks before asserting.
function fakeAudit() {
  const entries: RecordAuditInput[] = [];
  return {
    entries,
    emitter: {
      record: async (input: RecordAuditInput) => {
        entries.push(input);
        return input;
      }
    }
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

type Harness = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  buckets: Record<string, FakeStorage>;
  audit: ReturnType<typeof fakeAudit>;
};

async function buildHarness(): Promise<Harness> {
  const repo = new InMemoryAssetRepository();
  const buckets: Record<string, FakeStorage> = {
    [SOURCE_BUCKET]: new FakeStorage(),
    [PACKAGED_BUCKET]: new FakeStorage()
  };
  const audit = fakeAudit();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    sourceBucket: SOURCE_BUCKET,
    purgeStorageForBucket: (bucket: string) => buckets[bucket],
    audit: audit.emitter,
    // Retention DISABLED (0 = never purge, RETENTION_DISABLED_MS): the on-demand
    // purge must work without widening the global window.
    retentionMs: () => 0
  });
  await app.ready();
  return { app, repo, buckets, audit };
}

// An asset with objects in BOTH buckets: a source object, a plain-key rendition
// (source bucket), an s3:// rendition (packaged bucket), a subtitle track and
// thumbnails. Driven to `archived` through the ordinary lifecycle, then the
// object-bearing fields are set directly on the in-memory store (the same reach-in
// the sweep test uses).
async function makeAsset(
  repo: InMemoryAssetRepository,
  name: string,
  status: 'ready' | 'archived'
): Promise<Asset> {
  const created = await repo.create({ name, objectKey: `sources/${name}.mp4` });
  await repo.update(created.id, { status: 'processing' });
  await repo.update(created.id, { status: 'ready' });
  if (status === 'archived') {
    await repo.update(created.id, { status: 'archived' });
  }
  const current = (await repo.get(created.id))!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).store.set(created.id, {
    ...current,
    renditions: [
      {
        id: 'R1',
        label: '1080p',
        width: 1920,
        height: 1080,
        objectKey: `s3://${PACKAGED_BUCKET}/transcode/${name}/1080p.mp4`
      },
      { id: 'R2', label: '720p', width: 1280, height: 720, objectKey: `renditions/${name}-720p.mp4` }
    ],
    subtitleTracks: [{ id: 'S1', language: 'en', format: 'vtt', objectKey: `subs/${name}-en.vtt` }],
    thumbnails: [`thumbs/${name}-1.jpg`]
  });
  return (await repo.get(created.id))!;
}

describe('DELETE /api/v1/assets/:id/purge — on-demand purge (issue #837)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('purges an archived asset on demand: objects removed, document tombstoned, 204', async () => {
    const asset = await makeAsset(h.repo, 'old-clip', 'archived');

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    expect(res.statusCode).toBe(204);

    // Source bucket: source object, plain-key rendition, subtitle, thumbnail.
    expect(h.buckets[SOURCE_BUCKET]!.removed.sort()).toEqual(
      [
        'sources/old-clip.mp4',
        'renditions/old-clip-720p.mp4',
        'subs/old-clip-en.vtt',
        'thumbs/old-clip-1.jpg'
      ].sort()
    );
    // Packaged bucket: the s3:// rendition's key AND the whole output prefix.
    expect(h.buckets[PACKAGED_BUCKET]!.removed).toContain('transcode/old-clip/1080p.mp4');
    expect(h.buckets[PACKAGED_BUCKET]!.removedPrefixes).toEqual([outputPrefix(asset.id)]);

    // The document is REPLACED by a tombstone (not merely re-statused).
    const state = await h.repo.getState(asset.id);
    expect(state.kind).toBe('tombstone');
  });

  it('after a purge, reads of the id return 410 Gone and a repeat purge is 410', async () => {
    const asset = await makeAsset(h.repo, 'gone-clip', 'archived');

    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/assets/${asset.id}/purge`,
          headers: A
        })
      ).statusCode
    ).toBe(204);

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}`,
      headers: A
    });
    expect(read.statusCode).toBe(410);
    expect(read.json().error).toBe('gone');

    // Irreversible: restoring a purged asset stays 410, and purging again is 410
    // (gone), never 404 — the tombstone semantics of #326.
    const restore = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/restore`,
      headers: A
    });
    expect(restore.statusCode).toBe(410);

    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe('gone');
  });

  it('refuses to purge a NON-archived asset (409 not_archived) and touches no objects', async () => {
    const asset = await makeAsset(h.repo, 'live-clip', 'ready');

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_archived');

    // Nothing removed, document still a live asset and still readable.
    expect(h.buckets[SOURCE_BUCKET]!.removed).toEqual([]);
    expect(h.buckets[PACKAGED_BUCKET]!.removed).toEqual([]);
    expect(h.buckets[PACKAGED_BUCKET]!.removedPrefixes).toEqual([]);
    expect((await h.repo.getState(asset.id)).kind).toBe('asset');
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}`,
      headers: A
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().status).toBe('ready');
  });

  it('refuses to purge a DELETE-LOCKED archived asset (409 delete_protected) and touches no objects', async () => {
    const asset = await makeAsset(h.repo, 'locked-clip', 'archived');
    await h.repo.setDeleteLock(asset.id, { locked: true, reason: 'legal hold' });

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('delete_blocked');
    expect(body.reason).toBe('delete_protected');
    expect(body.blockedBy).toEqual({ jobIds: [], collectionIds: [] });

    expect(h.buckets[SOURCE_BUCKET]!.removed).toEqual([]);
    expect(h.buckets[PACKAGED_BUCKET]!.removed).toEqual([]);
    expect((await h.repo.getState(asset.id)).kind).toBe('asset');

    // Unlocking makes the SAME asset purgeable — the lock is the only block.
    await h.repo.setDeleteLock(asset.id, { locked: false });
    const after = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    expect(after.statusCode).toBe(204);
    expect((await h.repo.getState(asset.id)).kind).toBe('tombstone');
  });

  it('records the purge in the audit log as asset.purged', async () => {
    const asset = await makeAsset(h.repo, 'audited-clip', 'archived');

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/purge`,
      headers: A
    });
    await flush();

    const purgeEntries = h.audit.entries.filter((e) => e.action === 'asset.purged');
    expect(purgeEntries).toHaveLength(1);
    expect(purgeEntries[0]!.targetType).toBe('asset');
    expect(purgeEntries[0]!.targetId).toBe(asset.id);
    expect(purgeEntries[0]!.actor.origin).toBe('user');
    expect(purgeEntries[0]!.detail).toMatchObject({ from: 'archived', irreversible: true });
  });

  it('emits NO audit entry when the purge is refused', async () => {
    const live = await makeAsset(h.repo, 'unaudited-clip', 'ready');
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${live.id}/purge`,
      headers: A
    });
    await flush();
    expect(h.audit.entries.filter((e) => e.action === 'asset.purged')).toHaveLength(0);
  });

  it('returns 404 for an unknown asset id', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/assets/01HZZZZZZZZZZZZZZZZZZZZZZZ/purge',
      headers: A
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('is documented in openapi.json with the contract the route serves', () => {
    const spec = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'));
    const op = spec.paths['/api/v1/assets/{id}/purge']?.delete;
    expect(op).toBeTruthy();
    expect(Object.keys(op.responses).sort()).toEqual(['204', '404', '409', '410', '501']);
    expect(op.parameters).toEqual([
      { schema: { type: 'string' }, in: 'path', name: 'id', required: true }
    ]);
    // The destructive, one-way nature is stated plainly at the API.
    expect(op.summary).toMatch(/IRREVERSIBLE/);
    expect(op.description).toMatch(/archived/);
    // The 409 arm carries the same delete_blocked envelope as the archive route,
    // so a client can reuse its lock handling unchanged.
    const reasons = op.responses['409'].content['application/json'].schema.anyOf[0].properties.reason
      .enum as string[];
    expect(reasons).toContain('delete_protected');
  });
});
