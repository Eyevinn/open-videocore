// Asset comments survive a restart when CouchDB is configured (issue #1046).
//
// Regression for: the only comment store was an in-memory Map
// (InMemoryCommentRepository), so every review comment was lost when the
// process restarted. These tests drive the HTTP surface through the assets
// router wired to CouchCommentRepository, then throw away the whole Fastify
// instance AND the repository object (a process restart) and rebuild both
// against the same CouchDB documents.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - CommentRepository.create / listByAsset — src/data/comment-repo.ts:29-33.
//   - Comment = { id, assetId, body, createdAt } — src/data/comment-repo.ts:17-22,
//     matching the published 201 response for POST /api/v1/assets/{id}/comments
//     in openapi.json.
//   - CouchCommentRepository(couchFor: () => StackCouch) — mirrors
//     CouchCollectionRepository / CouchPipelineRepository
//     (src/data/couch-collection-repo.ts:29-31, src/data/couch-pipeline-repo.ts:30-31).
//   - StackCouch put/get/find contract — src/data/couchdb.ts:29,39,66.
//   - FakeCouch shape mirrors test/audit-repo.test.ts:26-80.
//   - assetsRouter option `commentRepository?: CommentRepository` —
//     src/routes/assets.ts:1052.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

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
import { InMemoryAssetRepository, type AssetRepository } from '../src/data/asset-repo.js';
import { CouchCommentRepository } from '../src/data/couch-comment-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

// Minimal StackCouch fake standing in for the stack's CouchDB. The documents it
// holds OUTLIVE every repository and Fastify instance built on top of it, which
// is exactly what "the database is still there after a restart" means.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...body,
      _id: localId,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? 'asset')
    } as StoredDoc);
    return { id: localId, rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const d = this.docs.get(localId);
    return d ? { ...d } : undefined;
  }

  // Mango-style equality selector over the stored fields, with CouchDB's default
  // ascending `_id` scan order so skip/limit paging is stable across pages.
  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = [...this.docs.values()]
      .filter((d) => Object.entries(selector).every(([k, v]) => d[k] === v))
      .map((d) => ({ ...d }))
      .sort((a, b) => a._id.localeCompare(b._id));
    const skip = opts.skip ?? 0;
    const limit = opts.limit ?? 50;
    return all.slice(skip, skip + limit);
  }

  async count(): Promise<number> {
    return 0;
  }

  async remove(localId: string): Promise<void> {
    this.docs.delete(localId);
  }

  docCount(): number {
    return this.docs.size;
  }
}

const A = { authorization: 'Bearer token-a' };

// Build a fresh API process against a persistent CouchDB and a given asset
// store. The comment repository is reconstructed on every call — nothing is
// carried over in process memory except the Couch documents themselves.
async function buildApp(couch: FakeCouch, assets: AssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    commentRepository: new CouchCommentRepository(() => couch as unknown as StackCouch)
  });
  await app.ready();
  return app;
}

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  expect(res.statusCode).toBe(201);
  return res.json()['id'] as string;
}

async function postComment(app: FastifyInstance, assetId: string, body: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/comments`,
    headers: A,
    payload: { body }
  });
  expect(res.statusCode).toBe(201);
}

async function getComments(
  app: FastifyInstance,
  assetId: string
): Promise<Array<{ id: string; assetId: string; body: string; createdAt: string }>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${assetId}/comments`,
    headers: A
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('asset comments survive a restart on CouchDB (issue #1046)', () => {
  it('POST -> restart -> GET returns the comment', async () => {
    const couch = new FakeCouch();
    // The asset store is shared across the restart so the 404 guard on the
    // comments routes still resolves the asset; only the comment repository and
    // the Fastify instance are rebuilt.
    const assets = new InMemoryAssetRepository();

    const before = await buildApp(couch, assets);
    const assetId = await createAsset(before);
    await postComment(before, assetId, 'looks good to me');
    await before.close();

    // --- process restart: every in-memory comment Map is gone ---
    const after = await buildApp(couch, assets);
    const items = await getComments(after, assetId);
    await after.close();

    expect(items).toHaveLength(1);
    expect(items[0].body).toBe('looks good to me');
    expect(items[0].assetId).toBe(assetId);
    expect(items[0].id).toBeTruthy();
    expect(typeof items[0].createdAt).toBe('string');
  });

  it('keeps oldest-first ordering across the restart and scopes by asset', async () => {
    const couch = new FakeCouch();
    const assets = new InMemoryAssetRepository();

    const before = await buildApp(couch, assets);
    const assetA = await createAsset(before);
    const assetB = await createAsset(before);
    for (const text of ['first', 'second', 'third']) {
      await postComment(before, assetA, text);
    }
    await postComment(before, assetB, 'for B');
    await before.close();

    const after = await buildApp(couch, assets);
    const itemsA = await getComments(after, assetA);
    const itemsB = await getComments(after, assetB);
    await after.close();

    expect(itemsA.map((c) => c.body)).toEqual(['first', 'second', 'third']);
    expect(itemsB.map((c) => c.body)).toEqual(['for B']);
  });
});

describe('CouchCommentRepository (issue #1046)', () => {
  it('orders oldest-first with the ULID tie-break when createdAt collides', async () => {
    const couch = new FakeCouch();
    const repo = new CouchCommentRepository(() => couch as unknown as StackCouch);
    // Freeze the clock so all three comments share a createdAt to the
    // millisecond: ordering then rests entirely on the monotonic ULID id.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      await repo.create({ assetId: 'a1', body: 'one' });
      await repo.create({ assetId: 'a2', body: 'other-asset' });
      await repo.create({ assetId: 'a1', body: 'two' });
      await repo.create({ assetId: 'a1', body: 'three' });
    } finally {
      vi.useRealTimers();
    }

    const items = await repo.listByAsset('a1');
    expect(items.map((c) => c.body)).toEqual(['one', 'two', 'three']);
    expect(items.every((c) => c.assetId === 'a1')).toBe(true);
    const ids = items.map((c) => c.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
    expect(new Set(items.map((c) => c.createdAt)).size).toBe(1);
  });

  it('returns an empty list for an asset with no comments', async () => {
    const couch = new FakeCouch();
    const repo = new CouchCommentRepository(() => couch as unknown as StackCouch);
    await repo.create({ assetId: 'a1', body: 'one' });
    expect(await repo.listByAsset('a2')).toEqual([]);
  });

  it('ignores documents of other resource types sharing the database', async () => {
    const couch = new FakeCouch();
    const repo = new CouchCommentRepository(() => couch as unknown as StackCouch);
    await couch.put('not-a-comment', {
      resourceType: 'collection',
      localId: 'not-a-comment',
      assetId: 'a1'
    });
    await repo.create({ assetId: 'a1', body: 'only me' });
    const items = await repo.listByAsset('a1');
    expect(items.map((c) => c.body)).toEqual(['only me']);
    expect(couch.docCount()).toBe(2);
  });

  it('returns every comment past the StackCouch default find limit of 50', async () => {
    const couch = new FakeCouch();
    const repo = new CouchCommentRepository(() => couch as unknown as StackCouch);
    for (let i = 0; i < 120; i += 1) {
      await repo.create({ assetId: 'a1', body: `comment-${i}` });
    }
    const items = await repo.listByAsset('a1');
    expect(items).toHaveLength(120);
    expect(items[0].body).toBe('comment-0');
    expect(items[119].body).toBe('comment-119');
  });
});
