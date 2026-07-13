// TAMS-addressed lookup on the assets API (issue #175, sub-task of the #116 TAMS
// bridge epic). Contract pinned by ADR-010 / #174.
//
// The route under test is `GET /api/v1/assets/by-tams-address`, a DEDICATED
// lookup (not an overload of `GET /`) that resolves a TAMS flow id (and,
// optionally, a TAI timerange) to AT MOST ONE ready asset and returns a
// `ListResult`-shaped envelope. v1 addressing modes:
//   (1) flowId             -> `?tamsFlowId=<uuid>`
//   (2) flowId + timerange -> `?tamsFlowId=<uuid>&tamsTimerange=<tai>`
//
// Error -> status contract:
//   - malformed tamsFlowId / tamsTimerange -> 400 (schema validation)
//   - unknown / not-yet-indexed / timerange miss -> 404
//   - ambiguous -> 409 (reserved; unreachable in v1)
//
// The on-main `create`/`update` repository surface does NOT accept the TAMS
// addressing fields (they are pipeline-written under the structural namespace),
// so the tests drive a small fake `AssetRepository` whose `list` returns assets
// pre-populated with `tamsFlowIds` / `tamsTimerange`. This mirrors exactly what
// the route consumes (it pages through ready assets via `repo.list`).

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
  MAX_LIMIT,
  type Asset,
  type AssetRepository,
  type ListOptions,
  type ListResult
} from '../src/data/asset-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// A well-formed TAMS flow UUID and a canonical TAI timerange (ADR-008).
const FLOW_A = '11111111-1111-4111-8111-111111111111';
const FLOW_B = '22222222-2222-4222-8222-222222222222';
const TR = '[0:0_10:0)';

function makeAsset(overrides: Partial<Asset>): Asset {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'ASSETIDXXXXXXXXXXXXXXXXXX0',
    name: overrides.name ?? 'clip',
    status: overrides.status ?? 'ready',
    statusHistory: [{ at: now, from: null, to: 'uploading' }],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

// Minimal fake repository: only `list` is exercised by the lookup route. Every
// other method throws so an accidental dependency surfaces loudly in a test.
function fakeRepo(assets: Asset[]): AssetRepository {
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeRepo.${name} unexpectedly called`);
  };
  return {
    async list(opts: ListOptions = {}): Promise<ListResult> {
      const limit = opts.limit ?? MAX_LIMIT;
      const offset = opts.offset ?? 0;
      let all = assets;
      if (opts.status) {
        all = all.filter((a) => a.status === opts.status);
      }
      const items = all.slice(offset, offset + limit);
      return { items, limit, offset, total: all.length };
    },
    create: notUsed('create') as AssetRepository['create'],
    get: notUsed('get') as AssetRepository['get'],
    getBySlug: notUsed('getBySlug') as AssetRepository['getBySlug'],
    search: notUsed('search') as AssetRepository['search'],
    update: notUsed('update') as AssetRepository['update'],
    transitionReviewState: notUsed('transitionReviewState') as AssetRepository['transitionReviewState'],
    countChildren: notUsed('countChildren') as AssetRepository['countChildren'],
    listVersions: notUsed('listVersions') as AssetRepository['listVersions'],
    remove: notUsed('remove') as AssetRepository['remove']
  };
}

async function buildApp(assets: Asset[]): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: fakeRepo(assets)
  });
  await app.ready();
  return app;
}

function lookup(app: FastifyInstance, query: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/assets/by-tams-address?${query}`,
    headers: A
  });
}

describe('GET /api/v1/assets/by-tams-address (issue #175)', () => {
  let app: FastifyInstance;

  const assetA = makeAsset({
    id: 'ASSETAXXXXXXXXXXXXXXXXXXX0',
    name: 'flow-a-asset',
    tamsFlowIds: [FLOW_A],
    tamsTimerange: TR
  });
  const assetB = makeAsset({
    id: 'ASSETBXXXXXXXXXXXXXXXXXXX0',
    name: 'flow-b-asset',
    tamsFlowIds: [FLOW_B]
  });
  // A processing (non-ready) asset carrying FLOW_A must NOT be addressable.
  const assetNotReady = makeAsset({
    id: 'ASSETCXXXXXXXXXXXXXXXXXXX0',
    name: 'not-ready',
    status: 'processing',
    tamsFlowIds: [FLOW_A]
  });

  beforeEach(async () => {
    app = await buildApp([assetA, assetB, assetNotReady]);
  });

  // --- addressing mode (1): flowId only -----------------------------------
  it('resolves flowId only to the single matching asset (one item)', async () => {
    const res = await lookup(app, `tamsFlowId=${FLOW_A}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // ListResult-shaped envelope, single match.
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(assetA.id);
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  // --- addressing mode (2): flowId + timerange (match) --------------------
  it('resolves flowId + matching timerange to that same asset', async () => {
    const res = await lookup(app, `tamsFlowId=${FLOW_A}&tamsTimerange=${encodeURIComponent(TR)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(assetA.id);
  });

  // --- addressing mode (2): flowId + timerange (NON-match) -> 404 ----------
  it('404s when the flow matches but the timerange does not', async () => {
    const other = encodeURIComponent('[10:0_20:0)');
    const res = await lookup(app, `tamsFlowId=${FLOW_A}&tamsTimerange=${other}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  // --- unknown address (well-formed, no carrier) -> 404 -------------------
  it('404s for a well-formed but unknown flowId', async () => {
    const unknown = '99999999-9999-4999-8999-999999999999';
    const res = await lookup(app, `tamsFlowId=${unknown}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  // --- only READY assets are addressable ----------------------------------
  it('does not resolve a flow carried only by a non-ready asset', async () => {
    // FLOW_A is also on the `processing` assetNotReady, but assetA (ready) owns
    // it too, so this asserts the ready one is what resolves — and a flow that
    // exists ONLY on a non-ready asset is unknown.
    const readyOnly = await buildApp([assetNotReady]);
    const res = await lookup(readyOnly, `tamsFlowId=${FLOW_A}`);
    expect(res.statusCode).toBe(404);
  });

  // --- malformed flowId -> 400 --------------------------------------------
  it('400s for a malformed (non-UUID) tamsFlowId', async () => {
    const res = await lookup(app, `tamsFlowId=not-a-uuid`);
    expect(res.statusCode).toBe(400);
  });

  // --- malformed timerange -> 400 -----------------------------------------
  it('400s for a malformed tamsTimerange', async () => {
    const bad = encodeURIComponent('not-a-timerange');
    const res = await lookup(app, `tamsFlowId=${FLOW_A}&tamsTimerange=${bad}`);
    expect(res.statusCode).toBe(400);
  });

  // --- ambiguous -> 409 (reserved; forced here with a rigged repo) ---------
  it('409s when more than one ready asset carries the same flow (reserved case)', async () => {
    const dupe1 = makeAsset({ id: 'DUPE1XXXXXXXXXXXXXXXXXXXXX0', tamsFlowIds: [FLOW_A] });
    const dupe2 = makeAsset({ id: 'DUPE2XXXXXXXXXXXXXXXXXXXXX0', tamsFlowIds: [FLOW_A] });
    const ambiguous = await buildApp([dupe1, dupe2]);
    const res = await lookup(ambiguous, `tamsFlowId=${FLOW_A}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ambiguous_tams_address');
  });

  // --- route is not shadowed by /:id --------------------------------------
  it('is not captured by the /:id param route (missing required flowId -> 400)', async () => {
    // Hitting the path with no query must be a 400 from the lookup schema, NOT a
    // 404 from /:id treating "by-tams-address" as an id/slug.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/by-tams-address',
      headers: A
    });
    expect(res.statusCode).toBe(400);
  });
});
