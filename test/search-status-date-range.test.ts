// Status + created-at date-range filtering on the search and assets endpoints
// (issue #833).
//
// Covers both acceptance criteria from the issue:
//   1. "a status filter returns the same result set whether or not `q` is set"
//      — the exact-filter tier is independent of the free-text tier.
//   2. "a date-range filter matches assets across all pages, not just the page
//      returned" — the range narrows the whole matched set (and therefore
//      `total`) before pagination, on BOTH endpoints and on BOTH backends.
//
// The CouchDB half is exercised against a StackCouch fake that evaluates the
// Mango subset the repositories actually emit (dotted field paths plus
// `$gte`/`$lte`/`$eq`/`$elemMatch`), so the selector the production code builds
// is proven to select the right documents rather than merely being the shape we
// happened to write. That is deliberate: the previous push-down bug (#345) was
// a selector that matched zero documents while every in-memory test passed.

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
import { searchRouter } from '../src/routes/search.js';
import {
  InMemoryAssetRepository,
  type Asset,
  type AssetStatus
} from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import { CouchSearchRepository } from '../src/data/couch-search-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

const A = { authorization: 'Bearer token-a' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Three assets one day apart, with distinct statuses and a free-text term that
// only two of them carry, so a status filter and a `q` filter select
// overlapping-but-different subsets.
const FIXTURES: Array<{
  name: string;
  description: string;
  status: AssetStatus;
  createdAt: string;
}> = [
  {
    name: 'Harbour timelapse',
    description: 'morning light over the quay',
    status: 'ready',
    createdAt: '2026-03-01T08:00:00.000Z'
  },
  {
    name: 'Harbour interview',
    description: 'dockworker interview',
    status: 'processing',
    createdAt: '2026-03-02T08:00:00.000Z'
  },
  {
    name: 'Forest drone pass',
    description: 'canopy flyover',
    status: 'ready',
    createdAt: '2026-03-03T08:00:00.000Z'
  }
];

// Move an asset to a target status through legal transitions only, so the
// fixture is reachable by the real state machine rather than smuggled in.
function pathTo(status: AssetStatus): AssetStatus[] {
  switch (status) {
    case 'uploading':
      return [];
    case 'processing':
      return ['processing'];
    case 'ready':
      return ['processing', 'ready'];
    case 'failed':
      return ['failed'];
    case 'archived':
      return ['archived'];
  }
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

async function seedInMemory(repo: InMemoryAssetRepository): Promise<void> {
  for (const f of FIXTURES) {
    const asset = await repo.create({ name: f.name, description: f.description });
    for (const step of pathTo(f.status)) {
      await repo.update(asset.id, { status: step });
    }
    // `createdAt` is server-owned (stamped at create), so the only way to place
    // a fixture at a chosen instant is to rewrite the stored record.
    const store = (repo as unknown as { store: Map<string, Asset> }).store;
    const stored = store.get(asset.id);
    if (stored) {
      store.set(asset.id, { ...stored, createdAt: f.createdAt });
    }
  }
}

async function buildInMemoryApp(repo: InMemoryAssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(repo)
  });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// CouchDB backend — a StackCouch fake that evaluates the emitted Mango subset
// ---------------------------------------------------------------------------

function readPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, doc);
}

// Evaluates exactly the operators the repositories emit. Mirrors the CouchDB
// 3.5 "Condition Operators" contract, including its rule that the field must
// exist in the document for a condition operator to match.
function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== 'object') {
    return value === condition;
  }
  for (const [op, arg] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case '$eq':
        if (value !== arg) return false;
        break;
      case '$gte':
        if (value === undefined || !(value >= (arg as string))) return false;
        break;
      case '$lte':
        if (value === undefined || !(value <= (arg as string))) return false;
        break;
      case '$elemMatch': {
        if (!Array.isArray(value)) return false;
        if (!value.some((v) => matchesCondition(v, arg))) return false;
        break;
      }
      default:
        throw new Error(`fake couch: unsupported Mango operator ${op}`);
    }
  }
  return true;
}

class MangoFakeCouch {
  readonly docs = new Map<string, StoredDoc>();
  // Every selector this fake was asked to evaluate, so a test can assert on the
  // push-down shape as well as on its effect.
  readonly selectors: Array<Record<string, unknown>> = [];
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, { ...body, _id: localId, _rev: rev } as StoredDoc);
    return { id: localId, rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const d = this.docs.get(localId);
    return d ? { ...d } : undefined;
  }

  private select(selector: Record<string, unknown>): StoredDoc[] {
    this.selectors.push(selector);
    return [...this.docs.values()].filter((doc) =>
      Object.entries(selector).every(([field, condition]) =>
        matchesCondition(readPath(doc as unknown as Record<string, unknown>, field), condition)
      )
    );
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = this.select(selector).sort((a, b) =>
      String(a._id).localeCompare(String(b._id))
    );
    const skip = opts.skip ?? 0;
    return all.slice(skip, skip + (opts.limit ?? all.length)).map((d) => ({ ...d }));
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return this.select(selector).length;
  }

  async remove(localId: string): Promise<void> {
    this.docs.delete(localId);
  }
}

async function seedCouch(): Promise<MangoFakeCouch> {
  const couch = new MangoFakeCouch();
  const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);
  for (const f of FIXTURES) {
    const asset = await repo.create({ name: f.name, description: f.description });
    for (const step of pathTo(f.status)) {
      await repo.update(asset.id, { status: step });
    }
    // Rewrite the persisted `administrative.createdAt` — the field the Mango
    // push-down addresses — to place the fixture at a chosen instant.
    const doc = couch.docs.get(asset.id);
    if (doc) {
      const administrative = { ...(doc['administrative'] as Record<string, unknown>) };
      administrative['createdAt'] = f.createdAt;
      couch.docs.set(asset.id, { ...doc, administrative } as StoredDoc);
    }
  }
  // Drop the selectors recorded during seeding so assertions see only the
  // selectors emitted by the queries under test.
  couch.selectors.length = 0;
  return couch;
}

async function buildCouchApp(couch: MangoFakeCouch): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new CouchAssetRepository(() => couch as unknown as StackCouch)
  });
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new CouchSearchRepository(() => couch as unknown as StackCouch)
  });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function names(items: Array<{ name: string }>): string[] {
  return items.map((i) => i.name).sort();
}

describe('search + assets status and created-at range filters (issue #833)', () => {
  describe.each([
    ['in-memory', async () => buildInMemoryApp(await seedInMemoryRepo())],
    ['couchdb', async () => buildCouchApp(await seedCouch())]
  ] as const)('%s backend', (_backend, build) => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await build();
    });

    it('filters search by exact status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=ready',
        headers: A
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(names(body.assets)).toEqual(['Forest drone pass', 'Harbour timelapse']);
    });

    // Acceptance criterion 1: the status filter is independent of `q`.
    it('answers the same status-filtered set with and without q', async () => {
      const withoutQ = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=processing',
        headers: A
      });
      const withQ = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=processing&q=harbour',
        headers: A
      });
      expect(withoutQ.statusCode).toBe(200);
      expect(withQ.statusCode).toBe(200);
      // `q=harbour` matches both harbour assets; intersecting it with
      // status=processing must leave exactly the set status alone selects,
      // i.e. the status tier did not become a no-op or a q-gated filter.
      expect(names(withQ.json().assets)).toEqual(names(withoutQ.json().assets));
      expect(names(withoutQ.json().assets)).toEqual(['Harbour interview']);
    });

    it('applies the status filter to assets and search identically', async () => {
      const viaAssets = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?status=ready',
        headers: A
      });
      const viaSearch = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=ready',
        headers: A
      });
      expect(names(viaAssets.json().items)).toEqual(names(viaSearch.json().assets));
    });

    // Acceptance criterion 2: the range narrows the whole set, not the page.
    it('applies the search created-at range across every page', async () => {
      const url = '/api/v1/search?from=2026-03-02&to=2026-03-03&pageSize=1';
      const first = await app.inject({ method: 'GET', url: `${url}&page=1`, headers: A });
      const second = await app.inject({ method: 'GET', url: `${url}&page=2`, headers: A });
      const third = await app.inject({ method: 'GET', url: `${url}&page=3`, headers: A });
      expect(first.statusCode).toBe(200);
      // `total` reflects the FILTERED set (2 of 3), not the page and not the
      // unfiltered workspace.
      expect(first.json().total).toBe(2);
      expect(second.json().total).toBe(2);
      const collected = [...first.json().assets, ...second.json().assets];
      expect(names(collected)).toEqual(['Forest drone pass', 'Harbour interview']);
      // The out-of-range asset never surfaces on a later page either.
      expect(third.json().assets).toEqual([]);
    });

    it('applies the assets created-at range across every page', async () => {
      const url = '/api/v1/assets?from=2026-03-02&to=2026-03-03&limit=1';
      const first = await app.inject({ method: 'GET', url: `${url}&offset=0`, headers: A });
      const second = await app.inject({ method: 'GET', url: `${url}&offset=1`, headers: A });
      const third = await app.inject({ method: 'GET', url: `${url}&offset=2`, headers: A });
      expect(first.statusCode).toBe(200);
      expect(first.json().total).toBe(2);
      expect(second.json().total).toBe(2);
      const collected = [...first.json().items, ...second.json().items];
      expect(names(collected)).toEqual(['Forest drone pass', 'Harbour interview']);
      expect(third.json().items).toEqual([]);
    });

    // A bare calendar date on `to` must cover the whole named UTC day, not
    // midnight — otherwise every asset created during that day is dropped.
    it('treats a bare date on `to` as the end of that UTC day', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?from=2026-03-01&to=2026-03-01',
        headers: A
      });
      expect(res.json().total).toBe(1);
      expect(names(res.json().items)).toEqual(['Harbour timelapse']);
    });

    it('accepts a full ISO 8601 instant as a bound', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?from=2026-03-02T08:00:00.000Z',
        headers: A
      });
      expect(names(res.json().items)).toEqual(['Forest drone pass', 'Harbour interview']);
    });

    it('combines status and created-at range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=ready&from=2026-03-03',
        headers: A
      });
      expect(res.json().total).toBe(1);
      expect(names(res.json().assets)).toEqual(['Forest drone pass']);
    });

    it.each(['/api/v1/assets', '/api/v1/search'])('rejects a malformed bound on %s', async (path) => {
      const res = await app.inject({ method: 'GET', url: `${path}?from=last-tuesday`, headers: A });
      expect(res.statusCode).toBe(400);
    });

    it.each(['/api/v1/assets', '/api/v1/search'])(
      'rejects an impossible calendar date on %s',
      async (path) => {
        const res = await app.inject({
          method: 'GET',
          url: `${path}?from=2026-02-31`,
          headers: A
        });
        expect(res.statusCode).toBe(400);
      }
    );

    it.each(['/api/v1/assets', '/api/v1/search'])(
      'rejects an inverted range on %s',
      async (path) => {
        const res = await app.inject({
          method: 'GET',
          url: `${path}?from=2026-03-03&to=2026-03-01`,
          headers: A
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_created_range');
      }
    );

    it('rejects an unknown status value', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/search?status=pending',
        headers: A
      });
      expect(res.statusCode).toBe(400);
    });

    it('is unchanged when neither filter is supplied', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search', headers: A });
      expect(res.json().total).toBe(3);
    });
  });

  // Push-down assertions: the range and the status must reach the database, not
  // just the in-process matcher, or `total`/pagination would be computed over an
  // unfiltered set (assets) or an unfiltered MAX_LIMIT window (search).
  describe('couchdb push-down', () => {
    it('pushes the created-at range into the Mango selector for both endpoints', async () => {
      const couch = await seedCouch();
      const app = await buildCouchApp(couch);
      await app.inject({
        method: 'GET',
        url: '/api/v1/assets?from=2026-03-02&to=2026-03-03',
        headers: A
      });
      await app.inject({
        method: 'GET',
        url: '/api/v1/search?from=2026-03-02&to=2026-03-03&status=ready',
        headers: A
      });
      const ranges = couch.selectors
        .map((s) => s['administrative.createdAt'])
        .filter((v) => v !== undefined);
      expect(ranges.length).toBeGreaterThan(0);
      for (const range of ranges) {
        expect(range).toEqual({
          $gte: '2026-03-02T00:00:00.000Z',
          $lte: '2026-03-03T23:59:59.999Z'
        });
      }
      // Status rides the existing top-level `state` mirror, the same field
      // GET /api/v1/assets/?status= already selects on.
      expect(couch.selectors.some((s) => s['state'] === 'ready')).toBe(true);
    });
  });
});

async function seedInMemoryRepo(): Promise<InMemoryAssetRepository> {
  const repo = new InMemoryAssetRepository();
  await seedInMemory(repo);
  return repo;
}
