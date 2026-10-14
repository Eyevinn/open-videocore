// Regression: an out-of-range retention window must not 500 an archived-asset
// read (issue #1034, review finding on PR #1037).
//
// `withRetentionWindow` (src/routes/assets.ts:2057) is now called on EVERY
// response that serializes an existing asset — GET /:id, the list page, the
// versions list, search hits, by-external-id, and every mutation echo. It calls
// `assetRetentionWindow` (src/data/asset-retention.ts), which used to build
// `new Date(archivedAtMs + effectiveMs).toISOString()` unguarded.
// `Date.prototype.toISOString` throws `RangeError: Invalid time value` once that
// sum leaves the ±8.64e15 ms Date range, so a single oversized retention window
// turned every archived-asset read into a 500. `retentionMs` reaches that
// arithmetic from an operator-supplied, intentionally unauthenticated
// `PATCH /api/v1/retention/config`, so the throw was remotely reachable.
//
// Proven here:
//   1. the projection is TOTAL — an out-of-range sum yields `purgeAfter: null`
//      (the same "never purged" answer already given for a disabled window and
//      an unparseable stamp) instead of throwing;
//   2. the archived-asset read still answers 200 with `purgeAfter: null` under
//      such a window;
//   3. defence in depth — `PATCH /api/v1/retention/config` now REJECTS a window
//      past `MAX_RETENTION_MS` rather than installing it.
//
// Contract sources verified in this tree before writing (per CLAUDE.md rule 7):
//   - `assetRetentionWindow(asset, retentionMs): AssetRetentionWindow | undefined`
//     and its private `purgeAfterOf` — src/data/asset-retention.ts:58,86.
//   - `withRetentionWindow(asset)` and the live per-request window read
//     `const retentionMsNow = opts.retentionMs ?? archiveRetentionMsFromEnv`
//     — src/routes/assets.ts:2048,2057.
//   - `retentionConfigSchema` = `{ retentionMs: z.number().int().min(0).max(MAX_RETENTION_MS),
//     auditRetentionMs: z.number().int().min(0) }`, bodied on PATCH '/config' as
//     `retentionConfigSchema.partial()` — src/routes/retention.ts.
//   - `MAX_RETENTION_MS` (100 years in ms) — src/routes/retention.ts, exported.
//   - Harness (`buildApp` with a live `retentionMs` getter, `createArchived`)
//     mirrored from test/asset-retention-window.test.ts:78-104.

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
import { retentionRouter, MAX_RETENTION_MS } from '../src/routes/retention.js';
import { InMemoryAssetRepository, type Asset, type StatusTransition } from '../src/data/asset-repo.js';
import { assetRetentionWindow } from '../src/data/asset-retention.js';

const A = { authorization: 'Bearer token-a' };

// The widest instant a JS Date can represent (ECMA-262 time range).
const MAX_TIME_VALUE_MS = 8.64e15;

// The exact payload from the review finding: a window that overflows the Date
// range when added to any real archive stamp.
const OVERFLOWING_MS = 1e16;

async function buildApp(
  repo: InMemoryAssetRepository,
  retentionMs: () => number
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    retentionMs
  });
  await app.ready();
  return app;
}

async function createArchived(repo: InMemoryAssetRepository, name = 'archived-one'): Promise<Asset> {
  const created = await repo.create({ name });
  await repo.update(created.id, { status: 'processing' });
  await repo.update(created.id, { status: 'ready' });
  const archived = await repo.update(created.id, { status: 'archived' });
  if (!archived) throw new Error('fixture failed to archive');
  return archived;
}

describe('assetRetentionWindow is total across the whole Date range (#1034)', () => {
  const archivedAsset = (at: string): Asset =>
    ({
      id: '01HRETENTION0000000000000',
      name: 'x',
      status: 'archived',
      statusHistory: [{ at, from: 'ready', to: 'archived' }] as StatusTransition[],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: at
    }) as Asset;

  it('does not throw and reports purgeAfter null when the sum overflows the Date range', () => {
    const asset = archivedAsset('2026-03-01T00:00:00.000Z');
    // Pre-fix this call threw RangeError: Invalid time value.
    expect(() => assetRetentionWindow(asset, OVERFLOWING_MS)).not.toThrow();

    const window = assetRetentionWindow(asset, OVERFLOWING_MS);
    expect(window).toBeDefined();
    expect(window?.archivedAt).toBe('2026-03-01T00:00:00.000Z');
    // An instant beyond the end of representable time is an instant the sweep
    // can never reach, so it is reported with the same "never purged" null the
    // disabled-window and unparseable-stamp cases already use.
    expect(window?.purgeAfter).toBeNull();
    // The window itself is still reported honestly — only the instant is unknown.
    expect(window?.retentionMs).toBe(OVERFLOWING_MS);
  });

  it('never throws for any window up to Number.MAX_SAFE_INTEGER', () => {
    const asset = archivedAsset('2026-03-01T00:00:00.000Z');
    for (const ms of [
      MAX_TIME_VALUE_MS,
      MAX_TIME_VALUE_MS + 1,
      1e16,
      1e21,
      Number.MAX_SAFE_INTEGER
    ]) {
      expect(() => assetRetentionWindow(asset, ms)).not.toThrow();
      expect(assetRetentionWindow(asset, ms)?.purgeAfter).toBeNull();
    }
  });

  it('still reports a real instant for the largest window that does fit', () => {
    // The guard must reject only what cannot be represented — a window that
    // lands exactly on the boundary is a legitimate purge instant.
    const asset = archivedAsset('1970-01-01T00:00:00.000Z');
    const window = assetRetentionWindow(asset, MAX_TIME_VALUE_MS);
    expect(window?.purgeAfter).toBe(new Date(MAX_TIME_VALUE_MS).toISOString());
  });
});

describe('archived-asset reads survive an out-of-range retention window (#1034)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    // The live getter main.ts wires (src/main.ts:1899) returning the oversized
    // window a PATCH /api/v1/retention/config could have installed.
    app = await buildApp(repo, () => OVERFLOWING_MS);
  });

  it('GET /api/v1/assets/:id returns 200 with purgeAfter null, not 500', async () => {
    const archived = await createArchived(repo);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${archived.id}`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('archived');
    expect(body.retention).toBeDefined();
    expect(body.retention.purgeAfter).toBeNull();
    expect('purgeAfter' in body.retention).toBe(true);
  });

  it('GET /api/v1/assets/?status=archived returns 200 with purgeAfter null per row', async () => {
    const archived = await createArchived(repo, 'archived-row');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/?status=archived',
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().items.find((i: { id: string }) => i.id === archived.id);
    expect(row).toBeDefined();
    expect(row.retention.purgeAfter).toBeNull();
  });

  it('a mutation echo of an archived asset returns 200, not 500', async () => {
    const archived = await createArchived(repo);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${archived.id}/lock`,
      headers: A,
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retention.purgeAfter).toBeNull();
  });
});

describe('PATCH /retention/config bounds the window (defence in depth, #1034)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(retentionRouter, {
      prefix: '/retention',
      retentionMs: 0,
      auditRetentionMs: 0
    });
    await app.ready();
  });

  it('rejects a window past MAX_RETENTION_MS instead of installing it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/retention/config',
      payload: { retentionMs: OVERFLOWING_MS }
    });
    expect(res.statusCode).toBe(400);

    // The live window is unchanged — the rejected value was never installed.
    const after = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(after.statusCode).toBe(200);
    expect(after.json().retentionMs).toBe(0);
  });

  it('still accepts any realistic window, up to and including the bound', async () => {
    for (const retentionMs of [0, 3_600_000, 30 * 24 * 60 * 60 * 1000, MAX_RETENTION_MS]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/retention/config',
        payload: { retentionMs }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().retentionMs).toBe(retentionMs);
    }
    // And the bound leaves plenty of headroom below the Date range, so an
    // accepted window can never overflow for a real archive stamp.
    expect(MAX_RETENTION_MS).toBeLessThan(MAX_TIME_VALUE_MS / 1000);
  });
});
