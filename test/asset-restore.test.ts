// Restore endpoint + audited restore repo method (issue #328, part of #323).
//
// Covers exactly the acceptance criteria:
//   (a) POST /:id/restore on an archived, non-tombstoned asset transitions it to
//       `ready` when the pre-archive status was `ready`, otherwise `failed`, and
//       appends an audited `archived -> <target>` statusHistory entry;
//   (b) ALLOWED_TRANSITIONS.archived remains `[]` (restore BYPASSES the state
//       machine — no ordinary PATCH can leave `archived`);
//   (c) POST /:id/restore on a tombstone (purged asset) returns 410 Gone;
//   (d) repo-level `restore(id)` parity across the in-memory and CouchDB tiers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import {
  InMemoryAssetRepository,
  applyRestore,
  isValidTransition,
  restoreTargetStatus,
  type StatusTransition
} from '../src/data/asset-repo.js';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

async function buildApp(repo: InMemoryAssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

// Drive a freshly-created asset to `archived`, passing through `ready` (so the
// pre-archive status is `ready`) or `failed` depending on `via`.
async function createArchived(
  repo: InMemoryAssetRepository,
  via: 'ready' | 'failed'
): Promise<string> {
  const created = await repo.create({ name: `to-archive-${via}` });
  if (via === 'ready') {
    await repo.update(created.id, { status: 'processing' });
    await repo.update(created.id, { status: 'ready' });
  } else {
    await repo.update(created.id, { status: 'failed' });
  }
  await repo.update(created.id, { status: 'archived' });
  return created.id;
}

// -------------------------------------------------------------------------
// (b) the state machine stays terminal — restore is the ONLY exit from archived
// -------------------------------------------------------------------------

describe('restore rule + state-machine invariants (issue #328)', () => {
  it('ALLOWED_TRANSITIONS.archived stays [] (no ordinary transition leaves archived)', () => {
    expect(isValidTransition('archived', 'ready')).toBe(false);
    expect(isValidTransition('archived', 'failed')).toBe(false);
    expect(isValidTransition('archived', 'processing')).toBe(false);
    expect(isValidTransition('archived', 'uploading')).toBe(false);
    // Idempotent self-transition is the only "allowed" archived move.
    expect(isValidTransition('archived', 'archived')).toBe(true);
  });

  it('restoreTargetStatus is ready iff the pre-archive status was ready, else failed', () => {
    const readyHistory: StatusTransition[] = [
      { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
      { at: '2026-01-02T00:00:00.000Z', from: 'uploading', to: 'processing' },
      { at: '2026-01-03T00:00:00.000Z', from: 'processing', to: 'ready' },
      { at: '2026-01-04T00:00:00.000Z', from: 'ready', to: 'archived' }
    ];
    expect(restoreTargetStatus(readyHistory)).toBe('ready');

    const failedHistory: StatusTransition[] = [
      { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
      { at: '2026-01-02T00:00:00.000Z', from: 'uploading', to: 'failed' },
      { at: '2026-01-03T00:00:00.000Z', from: 'failed', to: 'archived' }
    ];
    expect(restoreTargetStatus(failedHistory)).toBe('failed');

    // Archived directly from uploading -> failed (not ready).
    const uploadingHistory: StatusTransition[] = [
      { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
      { at: '2026-01-02T00:00:00.000Z', from: 'uploading', to: 'archived' }
    ];
    expect(restoreTargetStatus(uploadingHistory)).toBe('failed');

    // Defensive default: no `-> archived` transition at all.
    expect(restoreTargetStatus([{ at: 'x', from: null, to: 'uploading' }])).toBe('failed');
  });

  it('applyRestore appends an audited archived -> <target> entry (never rewrites)', () => {
    const history: StatusTransition[] = [
      { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
      { at: '2026-01-03T00:00:00.000Z', from: 'processing', to: 'ready' },
      { at: '2026-01-04T00:00:00.000Z', from: 'ready', to: 'archived' }
    ];
    const applied = applyRestore(history, '2026-02-01T00:00:00.000Z');
    expect(applied.status).toBe('ready');
    // Original entries are preserved; one entry is appended.
    expect(applied.statusHistory).toHaveLength(history.length + 1);
    expect(applied.statusHistory.slice(0, history.length)).toEqual(history);
    expect(applied.statusHistory[applied.statusHistory.length - 1]).toEqual({
      at: '2026-02-01T00:00:00.000Z',
      from: 'archived',
      to: 'ready'
    });
  });
});

// -------------------------------------------------------------------------
// (a)/(c) route behaviour — in-memory tier
// -------------------------------------------------------------------------

describe('POST /:id/restore — in-memory tier (issue #328)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    app = await buildApp(repo);
  });

  it('restores a ready-then-archived asset back to ready with an audited entry', async () => {
    const id = await createArchived(repo, 'ready');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/restore`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    const history = body.statusHistory as StatusTransition[];
    expect(history[history.length - 1]).toMatchObject({ from: 'archived', to: 'ready' });
    // The prior `-> archived` entry is still present (append, not rewrite).
    expect(history.some((h) => h.to === 'archived')).toBe(true);
  });

  it('restores a failed-then-archived asset back to failed', async () => {
    const id = await createArchived(repo, 'failed');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/restore`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('failed');
    const history = body.statusHistory as StatusTransition[];
    expect(history[history.length - 1]).toMatchObject({ from: 'archived', to: 'failed' });
  });

  it('a restored asset can be archived again (round-trips through remove)', async () => {
    const id = await createArchived(repo, 'ready');
    await app.inject({ method: 'POST', url: `/api/v1/assets/${id}/restore`, headers: A });
    // Now live again — DELETE re-archives it via the ordinary state machine.
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${id}`, headers: A });
    expect(del.statusCode).toBe(204);
    const state = await repo.getState(id);
    expect(state.kind).toBe('asset');
    if (state.kind === 'asset') expect(state.asset.status).toBe('archived');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/01UNKNOWNUNKNOWNUNKNOWNUNK/restore',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the asset is not currently archived (nothing to restore)', async () => {
    const created = await repo.create({ name: 'live' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${created.id}/restore`,
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 Gone when the asset was already purged (tombstone)', async () => {
    const id = await createArchived(repo, 'ready');
    // Purge in place -> tombstone (issue #326).
    expect(repo.purgeToTombstone(id)).toBe(true);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/restore`,
      headers: A
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('gone');
  });
});

// -------------------------------------------------------------------------
// (d) repo-level parity — CouchDB tier via an in-test StackCouch fake.
// -------------------------------------------------------------------------

// Minimal StackCouch fake mirroring the tombstone-test fake: stores whatever body
// is put and honours _rev on read so the updateWithRetry read-modify-write path
// works end-to-end.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  seed(doc: StoredDoc): void {
    this.docs.set(doc._id, { ...doc, _rev: doc._rev ?? '0-seed' });
  }

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...(body as Record<string, unknown>),
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

  async find(): Promise<StoredDoc[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }

  async remove(): Promise<void> {
    /* unused */
  }
}

// A live archived-asset document as toDoc() would emit it (namespaced body + the
// top-level resourceType/state mirrors). `via` sets the pre-archive status.
function archivedAssetDoc(id: string, via: 'ready' | 'failed'): StoredDoc {
  const preArchive: StatusTransition = {
    at: '2026-01-03T00:00:00.000Z',
    from: via === 'ready' ? 'processing' : 'uploading',
    to: via
  };
  return {
    _id: id,
    _rev: '0-seed',
    resourceType: 'asset',
    localId: id,
    type: 'asset',
    schemaVersion: 1,
    state: 'archived',
    slug: `slug-${id}`,
    descriptive: { title: id, tags: [], custom: {} },
    technical: {},
    administrative: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      source: { method: 'upload' },
      provenance: [],
      statusHistory: [
        { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
        preArchive,
        { at: '2026-01-04T00:00:00.000Z', from: via, to: 'archived' }
      ],
      reviewState: 'draft'
    },
    structural: { renditions: [], collections: [] }
  } as unknown as StoredDoc;
}

describe('restore repo method — CouchDB tier (issue #328)', () => {
  it('restores to ready and appends an audited entry (doc-replace with _rev)', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    couch.seed(archivedAssetDoc('01READYREADYREADYREADYREA', 'ready'));

    const restored = await repo.restore('01READYREADYREADYREADYREA');
    expect(restored?.status).toBe('ready');
    const history = restored!.statusHistory;
    expect(history[history.length - 1]).toMatchObject({ from: 'archived', to: 'ready' });

    // The persisted doc reflects the new live state and is still an asset.
    const raw = await couch.get('01READYREADYREADYREADYREA');
    expect(raw?.resourceType).toBe('asset');
    expect(raw?.state).toBe('ready');
  });

  it('restores to failed when the pre-archive status was not ready', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    couch.seed(archivedAssetDoc('01FAILFAILFAILFAILFAILFAI', 'failed'));

    const restored = await repo.restore('01FAILFAILFAILFAILFAILFAI');
    expect(restored?.status).toBe('failed');
    expect(restored!.statusHistory.at(-1)).toMatchObject({ from: 'archived', to: 'failed' });
  });

  it('returns undefined for an unknown id and for a non-archived asset', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    expect(await repo.restore('01MISSINGMISSINGMISSINGMIS')).toBeUndefined();

    const liveDoc = archivedAssetDoc('01LIVELIVELIVELIVELIVELIV', 'ready');
    (liveDoc as unknown as Record<string, unknown>).state = 'ready';
    ((liveDoc as unknown as Record<string, unknown>).administrative as Record<string, unknown>) = {
      ...((liveDoc as unknown as Record<string, unknown>).administrative as Record<string, unknown>),
      statusHistory: [
        { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
        { at: '2026-01-03T00:00:00.000Z', from: 'processing', to: 'ready' }
      ]
    };
    couch.seed(liveDoc);
    expect(await repo.restore('01LIVELIVELIVELIVELIVELIV')).toBeUndefined();
  });
});
