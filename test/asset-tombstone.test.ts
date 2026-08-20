// Archived-asset tombstone + 410/exclusion semantics (issue #326, part of #323).
//
// Covers exactly the acceptance criteria:
//   (a) the tombstone document shape — retains the enumerated lineage/provenance
//       fields plus a new `purgedAt` and a truncated statusHistory, adds NO new
//       ASSET_STATUSES value;
//   (b) GET /:id on a tombstone returns 410 Gone (not 404, not 200);
//   (c) list() excludes tombstones;
//   (d) search() excludes tombstones on BOTH query tiers — the in-memory/CouchDB
//       Mango list/search AND the SearchRepository (couch-search-repo) tier.
//
// The tombstone marker is a DISTINCT top-level `resourceType` ('asset-tombstone'),
// the same discriminator every Mango selector and read guard already keys on, so
// both query tiers exclude tombstones with no query change. The CouchDB tiers are
// exercised here against a minimal in-test StackCouch fake that implements the
// find/count selector semantics faithfully.

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
  ASSET_STATUSES,
  InMemoryAssetRepository,
  type Asset
} from '../src/data/asset-repo.js';
import {
  ASSET_TOMBSTONE_TYPE,
  AssetTombstoneSchema,
  archivedAtOf,
  isTombstoneDoc,
  toTombstoneDocument
} from '../src/data/asset-tombstone.js';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import { CouchSearchRepository } from '../src/data/couch-search-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// Build a fully-archived asset with the enumerated lineage/provenance fields set,
// so the tombstone builder has every retained field to carry.
function archivedAsset(overrides: Partial<Asset> = {}): Asset {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const archivedAt = '2026-02-01T00:00:00.000Z';
  return {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZZ',
    name: 'Old clip',
    slug: 'brave-river-042',
    status: 'archived',
    parentId: '01PARENTPARENTPARENTPARENT',
    versionOfAssetId: '01SOURCESOURCESOURCESOURCE',
    versionGroupId: '01GROUPGROUPGROUPGROUPGROU',
    objectKey: 'sources/old-clip',
    statusHistory: [
      { at: createdAt, from: null, to: 'uploading' },
      { at: '2026-01-02T00:00:00.000Z', from: 'uploading', to: 'processing' },
      { at: '2026-01-03T00:00:00.000Z', from: 'processing', to: 'ready' },
      { at: archivedAt, from: 'ready', to: 'archived' }
    ],
    sourceMethod: 'url-pull',
    originUri: 'https://example.com/old-clip.mp4',
    metadata: { genre: 'news' },
    tags: ['news'],
    createdAt,
    updatedAt: archivedAt,
    ...overrides
  };
}

// -------------------------------------------------------------------------
// (a) tombstone document shape
// -------------------------------------------------------------------------

describe('tombstone document shape (issue #326)', () => {
  it('retains exactly the enumerated fields, adds purgedAt, adds no status enum', () => {
    const asset = archivedAsset();
    const purgedAt = '2026-03-01T00:00:00.000Z';
    const t = toTombstoneDocument(asset, { purgedAt });

    // Parses against the tombstone schema (structural contract).
    const parsed = AssetTombstoneSchema.parse(t);

    // Distinct discriminator — NOT a new ASSET_STATUSES value.
    expect(parsed.resourceType).toBe(ASSET_TOMBSTONE_TYPE);
    expect(ASSET_TOMBSTONE_TYPE).not.toBe('asset');
    expect((ASSET_STATUSES as readonly string[]).includes(ASSET_TOMBSTONE_TYPE)).toBe(false);
    expect((ASSET_STATUSES as readonly string[]).includes('purged')).toBe(false);

    // Retained lineage/provenance fields.
    expect(parsed._id).toBe(asset.id);
    expect(parsed.slug).toBe('brave-river-042');
    expect(parsed.derivedFrom).toBe(asset.parentId);
    expect(parsed.versionGroupId).toBe(asset.versionGroupId);
    expect(parsed.versionOfAssetId).toBe(asset.versionOfAssetId);
    expect(parsed.sourceMethod).toBe('url-pull');
    expect(parsed.originUri).toBe(asset.originUri);
    expect(parsed.createdAt).toBe(asset.createdAt);

    // Derived archived-at (last `-> archived` transition) + new purgedAt.
    expect(parsed.archivedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(parsed.purgedAt).toBe(purgedAt);

    // A truncated statusHistory tail that still includes the terminal transition.
    expect(parsed.statusHistory[parsed.statusHistory.length - 1]).toEqual({
      at: '2026-02-01T00:00:00.000Z',
      from: 'ready',
      to: 'archived'
    });

    // The heavy body is dropped — no descriptive/technical/structural namespaces,
    // no renditions/manifests/custom metadata carried onto the tombstone.
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(
      [
        '_id',
        'archivedAt',
        'createdAt',
        'derivedFrom',
        'originUri',
        'purgedAt',
        'resourceType',
        'slug',
        'sourceMethod',
        'statusHistory',
        'versionGroupId',
        'versionOfAssetId'
      ].sort()
    );
  });

  it('truncates statusHistory to the most recent N transitions', () => {
    const history = Array.from({ length: 25 }, (_v, i) => ({
      at: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
      from: 'ready' as const,
      to: i === 24 ? ('archived' as const) : ('processing' as const)
    }));
    const asset = archivedAsset({ statusHistory: history });
    const t = toTombstoneDocument(asset, { statusHistoryLimit: 5 });
    expect(t.statusHistory).toHaveLength(5);
    // Keeps the TAIL (most recent), including the terminal `-> archived`.
    expect(t.statusHistory[t.statusHistory.length - 1].to).toBe('archived');
  });

  it('derives archivedAt from the last archived transition, else updatedAt', () => {
    expect(archivedAtOf(archivedAsset())).toBe('2026-02-01T00:00:00.000Z');
    const noArchive = archivedAsset({
      statusHistory: [{ at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' }],
      updatedAt: '2026-09-09T00:00:00.000Z'
    });
    expect(archivedAtOf(noArchive)).toBe('2026-09-09T00:00:00.000Z');
  });

  it('isTombstoneDoc recognises the marker and rejects assets / undefined', () => {
    expect(isTombstoneDoc({ resourceType: ASSET_TOMBSTONE_TYPE })).toBe(true);
    expect(isTombstoneDoc({ resourceType: 'asset' })).toBe(false);
    expect(isTombstoneDoc(undefined)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// (b) GET /:id -> 410, and (c) list() exclusion — in-memory tier
// -------------------------------------------------------------------------

async function buildApp(repo: InMemoryAssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

describe('tombstone read-path semantics — in-memory tier (issue #326)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    app = await buildApp(repo);
  });

  it('GET /:id on a tombstone returns 410 Gone (not 404, not 200)', async () => {
    const created = await repo.create({ name: 'to-purge' });
    // Drive to archived, then purge in place to a tombstone.
    await repo.update(created.id, { status: 'processing' });
    await repo.update(created.id, { status: 'archived' });
    expect(repo.purgeToTombstone(created.id)).toBe(true);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${created.id}`,
      headers: A
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('gone');
  });

  it('GET /:id on an unknown id still returns 404 (tombstone != not-found)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/01UNKNOWNUNKNOWNUNKNOWNUNK',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /:id on a live asset still returns 200', async () => {
    const created = await repo.create({ name: 'live' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${created.id}`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created.id);
  });

  it('list() excludes tombstones', async () => {
    const a = await repo.create({ name: 'keeps' });
    const b = await repo.create({ name: 'purged' });
    await repo.update(b.id, { status: 'processing' });
    await repo.update(b.id, { status: 'archived' });
    repo.purgeToTombstone(b.id);

    const listed = await repo.list({ limit: 100 });
    const ids = listed.items.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(listed.total).toBe(1);
  });

  it('search() excludes tombstones', async () => {
    const a = await repo.create({ name: 'sunrise' });
    const b = await repo.create({ name: 'sunset' });
    await repo.update(b.id, { status: 'processing' });
    await repo.update(b.id, { status: 'archived' });
    repo.purgeToTombstone(b.id);

    const hits = await repo.search('sun');
    const ids = hits.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});

// -------------------------------------------------------------------------
// (c)/(d) CouchDB Mango tiers: list(), search() (couch-asset-repo) AND the
// SearchRepository tier (couch-search-repo) both exclude tombstones.
// -------------------------------------------------------------------------

// Minimal in-test StackCouch fake. Faithfully implements the two selector
// predicates the tombstone exclusion relies on: `resourceType` equality (both
// tiers pin `{ resourceType: 'asset' }`) plus the dotted/simple equality
// filters the repos push down. It stores whatever body is put, so a doc-replace
// to a tombstone flips `resourceType` and is excluded by every `resourceType:
// 'asset'` selector.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  seed(doc: StoredDoc): void {
    this.docs.set(doc._id, { ...doc, _rev: doc._rev ?? `0-seed` });
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

  private matches(doc: StoredDoc, selector: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(selector)) {
      const actual = key.includes('.')
        ? key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc)
        : (doc as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('$ne' in c && actual === c['$ne']) return false;
        if ('$eq' in c && actual !== c['$eq']) return false;
        if ('$all' in c) {
          const want = c['$all'] as unknown[];
          const have = Array.isArray(actual) ? (actual as unknown[]) : [];
          if (!want.every((w) => have.includes(w))) return false;
        }
      } else if (actual !== cond) {
        return false;
      }
    }
    return true;
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = [...this.docs.values()].filter((d) => this.matches(d, selector));
    const skip = opts.skip ?? 0;
    return all.slice(skip, skip + (opts.limit ?? all.length)).map((d) => ({ ...d }));
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return [...this.docs.values()].filter((d) => this.matches(d, selector)).length;
  }

  async remove(): Promise<void> {
    /* unused */
  }
}

// A live-asset stored document (as toDoc() would emit: namespaced body + the
// top-level `resourceType`/`state`/`slug` mirrors the selectors use).
function liveAssetDoc(id: string, name: string): StoredDoc {
  return {
    _id: id,
    _rev: '0-seed',
    resourceType: 'asset',
    localId: id,
    type: 'asset',
    schemaVersion: 1,
    state: 'ready',
    slug: `slug-${name}`,
    descriptive: { title: name, tags: [], custom: {} },
    technical: {},
    administrative: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      source: { method: 'upload' },
      provenance: [],
      statusHistory: [{ at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' }],
      reviewState: 'draft'
    },
    structural: { renditions: [], collections: [] }
  } as unknown as StoredDoc;
}

describe('tombstone exclusion — CouchDB Mango tiers (issue #326)', () => {
  it('couch list()/search()/getState() exclude tombstones and 410 the id', async () => {
    const couch = new FakeCouch();
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    couch.seed(liveAssetDoc('01LIVELIVELIVELIVELIVELIVE', 'keeps'));
    couch.seed(liveAssetDoc('01PURGEPURGEPURGEPURGEPURG', 'purged'));

    // Both live before purge.
    expect((await repo.list({ limit: 100 })).total).toBe(2);

    // Purge one in place -> tombstone (doc-replace, carries _rev).
    const purgedId = await repo.purgeToTombstone('01PURGEPURGEPURGEPURGEPURG');
    expect(purgedId).toBe('01PURGEPURGEPURGEPURGEPURG');

    // The stored doc is now a tombstone.
    const raw = await couch.get('01PURGEPURGEPURGEPURGEPURG');
    expect(raw?.resourceType).toBe(ASSET_TOMBSTONE_TYPE);
    expect(raw?.purgedAt).toBeTruthy();

    // list() excludes it (Mango selector pins resourceType: 'asset').
    const listed = await repo.list({ limit: 100 });
    expect(listed.total).toBe(1);
    expect(listed.items.map((a) => a.id)).toEqual(['01LIVELIVELIVELIVELIVELIVE']);

    // search() excludes it too.
    const hits = await repo.search('purged');
    expect(hits).toHaveLength(0);
    const liveHits = await repo.search('keeps');
    expect(liveHits.map((a) => a.id)).toEqual(['01LIVELIVELIVELIVELIVELIVE']);

    // get() reads a tombstone as undefined; getState() distinguishes it.
    expect(await repo.get('01PURGEPURGEPURGEPURGEPURG')).toBeUndefined();
    expect((await repo.getState('01PURGEPURGEPURGEPURGEPURG')).kind).toBe('tombstone');
    expect((await repo.getState('01LIVELIVELIVELIVELIVELIVE')).kind).toBe('asset');
    expect((await repo.getState('01MISSINGMISSINGMISSINGMIS')).kind).toBe('not-found');
  });

  it('SearchRepository tier (couch-search-repo) excludes tombstones', async () => {
    const couch = new FakeCouch();
    const assetRepo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    const searchRepo = new CouchSearchRepository(() => couch as unknown as StackCouch);
    couch.seed(liveAssetDoc('01LIVELIVELIVELIVELIVELIVE', 'keeps'));
    couch.seed(liveAssetDoc('01PURGEPURGEPURGEPURGEPURG', 'purged'));

    await assetRepo.purgeToTombstone('01PURGEPURGEPURGEPURGEPURG');

    const all = await searchRepo.search({ pageSize: 100 });
    expect(all.total).toBe(1);
    expect(all.assets.map((a) => a.id)).toEqual(['01LIVELIVELIVELIVELIVELIVE']);

    const byText = await searchRepo.search({ q: 'purged', pageSize: 100 });
    expect(byText.total).toBe(0);
  });
});
