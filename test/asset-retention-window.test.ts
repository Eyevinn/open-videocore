// Per-asset retention window on the asset READ contract (issue #1034).
//
// Covers exactly the acceptance criteria:
//   (a) an archived asset's read body carries `retention` with the correct
//       `archivedAt` / `purgeAfter` / `retentionMs`;
//   (b) `purgeAfter` is `null` when `retentionMs === 0` (retention disabled —
//       never purge), and `retentionMs` is reported as 0 rather than omitted;
//   (c) a non-archived asset carries NO `retention` member at all (the change is
//       additive: every existing body is byte-identical apart from archived
//       assets);
//   plus the properties that keep the field honest: it is derived from the SAME
//   source the purge sweep uses (archivedAtOf — the last `-> archived`
//   transition, NOT `updatedAt`), it tracks a hot-swapped retention window at
//   read time, the 200 body of a successful restore carries none (the asset has
//   just left `archived`), and the published spec advertises the member inside
//   the `additionalProperties: false` asset schema.
//
// Contract grounding (verified in THIS tree before writing, contract-first):
//   - `assetSchema` — src/routes/assets.ts:906 (`const assetSchema = z.object({`),
//     serialized with `additionalProperties: false`; the new member is
//     `retention: retentionWindowSchema.optional()` (src/routes/assets.ts:983),
//     defined by `retentionWindowSchema` (src/routes/assets.ts:868-904).
//   - Read routes serializing it: `app.get('/:id', …)` with
//     `response: { 200: assetSchema, 404, 410 }` — src/routes/assets.ts:3482-3488;
//     `app.get('/', …)` with `200: listSchema` — src/routes/assets.ts:3011-3016;
//     `app.post('/:id/restore', …)` with `200: assetSchema` —
//     src/routes/assets.ts:5909-5914.
//   - `archivedAtOf(asset): string` — the `at` of the LAST `-> archived`
//     transition in `statusHistory`, falling back to `updatedAt` —
//     src/data/asset-tombstone.ts:87-95. The purge sweep measures eligibility
//     from the same call: src/pipeline/archived-asset-purge-sweep.ts:146
//     (`const archivedAtMs = Date.parse(archivedAtOf(asset))`).
//   - Disabled window: `RETENTION_DISABLED_MS = 0` — src/routes/retention.ts:36;
//     the sweep early-returns `{ scanned: 0, purged: 0 }` for `retentionMs <= 0`
//     — src/pipeline/archived-asset-purge-sweep.ts:124-126.
//   - Instance-global window surface: `retentionConfigSchema`
//     `{ retentionMs, auditRetentionMs }` on GET/PATCH `/config` —
//     src/routes/retention.ts:81-128; hot-swapped into main.ts's live
//     `archiveRetentionMs` via `onConfigChange` — src/main.ts:2197-2199, and read
//     per request by the assets router through
//     `retentionMs: () => archiveRetentionMs` — src/main.ts:1899.
//   - `ASSET_STATUSES` includes `archived` and `ALLOWED_TRANSITIONS.archived`
//     is `[]` (terminal) — src/data/asset-repo.ts:29,35-41.

import { readFileSync } from 'node:fs';
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
import { InMemoryAssetRepository, type Asset, type StatusTransition } from '../src/data/asset-repo.js';
import { archivedAtOf } from '../src/data/asset-tombstone.js';
import { assetRetentionWindow } from '../src/data/asset-retention.js';

const A = { authorization: 'Bearer token-a' };

const DAY_MS = 24 * 60 * 60 * 1000;

// Build the router with a LIVE retention getter, exactly as main.ts wires it
// (`retentionMs: () => archiveRetentionMs`, src/main.ts:1899), so a test can
// hot-swap the window between reads the way PATCH /api/v1/retention/config does.
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

// Drive a freshly-created asset to the terminal `archived` state through
// `ready` (mirrors createArchived in test/asset-restore.test.ts).
async function createArchived(repo: InMemoryAssetRepository, name = 'archived-one'): Promise<Asset> {
  const created = await repo.create({ name });
  await repo.update(created.id, { status: 'processing' });
  await repo.update(created.id, { status: 'ready' });
  const archived = await repo.update(created.id, { status: 'archived' });
  if (!archived) throw new Error('fixture failed to archive');
  return archived;
}

async function createReady(repo: InMemoryAssetRepository, name = 'live-one'): Promise<Asset> {
  const created = await repo.create({ name });
  await repo.update(created.id, { status: 'processing' });
  const ready = await repo.update(created.id, { status: 'ready' });
  if (!ready) throw new Error('fixture failed to reach ready');
  return ready;
}

const get = (app: FastifyInstance, id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });

// -------------------------------------------------------------------------
// The projection itself (pure) — no route, no clock
// -------------------------------------------------------------------------

describe('assetRetentionWindow — the derived projection (issue #1034)', () => {
  // A minimal Asset-shaped fixture; only status/statusHistory/updatedAt are read.
  const asset = (status: Asset['status'], history: StatusTransition[], updatedAt: string): Asset =>
    ({
      id: '01HRETENTION0000000000000',
      name: 'x',
      status,
      statusHistory: history,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt
    }) as Asset;

  const archivedHistory: StatusTransition[] = [
    { at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' },
    { at: '2026-01-02T00:00:00.000Z', from: 'uploading', to: 'processing' },
    { at: '2026-01-03T00:00:00.000Z', from: 'processing', to: 'ready' },
    { at: '2026-03-01T00:00:00.000Z', from: 'ready', to: 'archived' }
  ];

  it('derives archivedAt from the LAST `-> archived` transition, not updatedAt', () => {
    // `updatedAt` is deliberately LATER than the archive transition (e.g. a
    // metadata edit after archiving). The window must still be measured from
    // the transition — the same value archivedAtOf() and the sweep use.
    const a = asset('archived', archivedHistory, '2026-06-01T00:00:00.000Z');
    const window = assetRetentionWindow(a, 30 * DAY_MS);
    expect(window?.archivedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(window?.archivedAt).toBe(archivedAtOf(a));
    expect(window?.archivedAt).not.toBe(a.updatedAt);
  });

  it('purgeAfter is archivedAt + retentionMs', () => {
    const window = assetRetentionWindow(asset('archived', archivedHistory, 'x'), 30 * DAY_MS);
    expect(window?.retentionMs).toBe(30 * DAY_MS);
    expect(window?.purgeAfter).toBe('2026-03-31T00:00:00.000Z');
    expect(Date.parse(window!.purgeAfter!) - Date.parse(window!.archivedAt)).toBe(30 * DAY_MS);
  });

  it('purgeAfter is null and retentionMs 0 when retention is disabled', () => {
    for (const disabled of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = assetRetentionWindow(asset('archived', archivedHistory, 'x'), disabled);
      expect(window).toBeDefined();
      expect(window?.purgeAfter).toBeNull();
      expect(window?.retentionMs).toBe(0);
    }
  });

  it('purgeAfter is null when archivedAt cannot be parsed (the sweep refuses to purge too)', () => {
    const window = assetRetentionWindow(
      asset('archived', [{ at: 'not-a-timestamp', from: 'ready', to: 'archived' }], 'x'),
      30 * DAY_MS
    );
    expect(window?.archivedAt).toBe('not-a-timestamp');
    expect(window?.purgeAfter).toBeNull();
    // The window itself is still reported honestly — only the instant is unknown.
    expect(window?.retentionMs).toBe(30 * DAY_MS);
  });

  it('falls back to updatedAt when no `-> archived` transition was recorded', () => {
    const a = asset(
      'archived',
      [{ at: '2026-01-01T00:00:00.000Z', from: null, to: 'uploading' }],
      '2026-05-01T00:00:00.000Z'
    );
    const window = assetRetentionWindow(a, DAY_MS);
    expect(window?.archivedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(window?.archivedAt).toBe(archivedAtOf(a));
    expect(window?.purgeAfter).toBe('2026-05-02T00:00:00.000Z');
  });

  it('returns undefined for every non-archived status', () => {
    for (const status of ['uploading', 'processing', 'ready', 'failed'] as const) {
      expect(assetRetentionWindow(asset(status, archivedHistory, 'x'), 30 * DAY_MS)).toBeUndefined();
    }
  });
});

// -------------------------------------------------------------------------
// The read contract over HTTP
// -------------------------------------------------------------------------

describe('GET /api/v1/assets/:id — retention on the read contract (issue #1034)', () => {
  let repo: InMemoryAssetRepository;

  beforeEach(() => {
    repo = new InMemoryAssetRepository();
  });

  it('an archived asset returns retention with archivedAt/purgeAfter/retentionMs', async () => {
    const app = await buildApp(repo, () => 30 * DAY_MS);
    const archived = await createArchived(repo);
    const res = await get(app, archived.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('archived');
    // The serializer must not strip the new member (assetSchema is serialized
    // with additionalProperties: false — an unlisted key would vanish silently).
    expect(body.retention).toBeDefined();
    expect(Object.keys(body.retention).sort()).toEqual([
      'archivedAt',
      'purgeAfter',
      'retentionMs'
    ]);

    // archivedAt is the `at` of the asset's own last `-> archived` transition,
    // readable from the same body — no second source of truth.
    const archivedTransition = (body.statusHistory as StatusTransition[])
      .filter((t) => t.to === 'archived')
      .at(-1);
    expect(body.retention.archivedAt).toBe(archivedTransition?.at);
    expect(body.retention.archivedAt).toBe(archivedAtOf(archived));

    expect(body.retention.retentionMs).toBe(30 * DAY_MS);
    expect(body.retention.purgeAfter).toBe(
      new Date(Date.parse(body.retention.archivedAt) + 30 * DAY_MS).toISOString()
    );
  });

  it('purgeAfter is null when retentionMs is 0 (retention disabled — never purge)', async () => {
    const app = await buildApp(repo, () => 0);
    const archived = await createArchived(repo);
    const body = (await get(app, archived.id)).json();
    expect(body.retention).toBeDefined();
    expect(body.retention.retentionMs).toBe(0);
    // `null`, not absent and not a zero-length countdown: "never purge" is
    // stated explicitly so a client cannot render a deadline that does not exist.
    expect(body.retention.purgeAfter).toBeNull();
    expect('purgeAfter' in body.retention).toBe(true);
  });

  it('a non-archived asset omits retention entirely (additive, non-breaking)', async () => {
    const app = await buildApp(repo, () => 30 * DAY_MS);
    const ready = await createReady(repo);
    const body = (await get(app, ready.id)).json();
    expect(body.status).toBe('ready');
    expect('retention' in body).toBe(false);
    expect(body.retention).toBeUndefined();
  });

  it('reports the window live, so a hot-swapped retention config is never stale', async () => {
    // Mirrors PATCH /api/v1/retention/config mutating main.ts's live
    // `archiveRetentionMs` (src/main.ts:2197-2199) between two reads.
    let live = 7 * DAY_MS;
    const app = await buildApp(repo, () => live);
    const archived = await createArchived(repo);

    const first = (await get(app, archived.id)).json();
    expect(first.retention.retentionMs).toBe(7 * DAY_MS);
    const firstPurgeAfter = first.retention.purgeAfter;

    live = 14 * DAY_MS;
    const second = (await get(app, archived.id)).json();
    expect(second.retention.retentionMs).toBe(14 * DAY_MS);
    expect(second.retention.purgeAfter).not.toBe(firstPurgeAfter);
    expect(
      Date.parse(second.retention.purgeAfter) - Date.parse(firstPurgeAfter)
    ).toBe(7 * DAY_MS);
    // archivedAt is a property of the asset, not of the policy — unchanged.
    expect(second.retention.archivedAt).toBe(first.retention.archivedAt);

    live = 0;
    const third = (await get(app, archived.id)).json();
    expect(third.retention.retentionMs).toBe(0);
    expect(third.retention.purgeAfter).toBeNull();
  });

  it('is resolvable by slug as well as by id (same read contract)', async () => {
    const app = await buildApp(repo, () => DAY_MS);
    const archived = await createArchived(repo);
    expect(archived.slug).toBeTruthy();
    const body = (await get(app, archived.slug!)).json();
    expect(body.id).toBe(archived.id);
    expect(body.retention.retentionMs).toBe(DAY_MS);
    expect(body.retention.archivedAt).toBe(archivedAtOf(archived));
  });
});

describe('retention on the other archived-asset reads (issue #1034)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    app = await buildApp(repo, () => 30 * DAY_MS);
  });

  it('GET /?status=archived carries the same window per row; live rows carry none', async () => {
    const archived = await createArchived(repo, 'archived-row');
    await createReady(repo, 'ready-row');

    const archivedPage = (
      await app.inject({ method: 'GET', url: '/api/v1/assets/?status=archived', headers: A })
    ).json();
    const row = archivedPage.items.find((i: { id: string }) => i.id === archived.id);
    expect(row).toBeDefined();
    expect(row.retention.archivedAt).toBe(archivedAtOf(archived));
    expect(row.retention.retentionMs).toBe(30 * DAY_MS);
    expect(row.retention.purgeAfter).toBe(
      new Date(Date.parse(archivedAtOf(archived)) + 30 * DAY_MS).toISOString()
    );

    const readyPage = (
      await app.inject({ method: 'GET', url: '/api/v1/assets/?status=ready', headers: A })
    ).json();
    expect(readyPage.items.length).toBeGreaterThan(0);
    for (const item of readyPage.items) {
      expect('retention' in item).toBe(false);
    }
  });

  it('a mutation body that echoes an archived asset carries the same window', async () => {
    // The window is attached by ONE helper at every response serializing an
    // existing asset, so a client that reads the asset back from a mutation
    // echo sees the same value GET /:id reports — not a body that silently
    // drops the field depending on which route answered.
    const archived = await createArchived(repo);
    const expected = (await get(app, archived.id)).json().retention;

    const locked = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${archived.id}/lock`,
      headers: A,
      payload: {}
    });
    expect(locked.statusCode).toBe(200);
    const body = locked.json();
    expect(body.status).toBe('archived');
    expect(body.retention).toEqual(expected);
  });

  it('a successful restore returns NO retention — the asset has left archived', async () => {
    const archived = await createArchived(repo);
    // Pre-restore the window is readable...
    expect((await get(app, archived.id)).json().retention).toBeDefined();

    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${archived.id}/restore`,
      headers: A
    });
    expect(restored.statusCode).toBe(200);
    const body = restored.json();
    expect(body.status).toBe('ready');
    // ...and afterwards there is no purge window to report, so the member is
    // absent rather than stale.
    expect('retention' in body).toBe(false);
    expect((await get(app, archived.id)).json().retention).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// The published contract
// -------------------------------------------------------------------------

describe('openapi.json advertises the retention member (issue #1034)', () => {
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { responses: Record<string, Record<string, never>> }>>;
  };

  // The asset 200 schema for GET /api/v1/assets/{id}.
  const assetSchemaJson = () => {
    const path = spec.paths['/api/v1/assets/{id}'] as unknown as Record<
      string,
      {
        responses: Record<
          string,
          { content: Record<string, { schema: Record<string, unknown> }> }
        >;
      }
    >;
    return path['get'].responses['200'].content['application/json'].schema;
  };

  it('declares retention inside the additionalProperties:false asset schema', () => {
    const schema = assetSchemaJson();
    // Without being declared here the member could never reach a client: the
    // serializer strips anything the schema does not list.
    expect(schema['additionalProperties']).toBe(false);
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['retention']).toBeDefined();
    expect(properties['retention']['type']).toBe('object');
  });

  it('keeps retention OPTIONAL — no existing client is newly non-conformant', () => {
    const schema = assetSchemaJson();
    const required = (schema['required'] ?? []) as string[];
    expect(required).not.toContain('retention');
  });

  it('documents the three members, with purgeAfter nullable', () => {
    const properties = assetSchemaJson()['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const retention = properties['retention'];
    const members = retention['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(members).sort()).toEqual(['archivedAt', 'purgeAfter', 'retentionMs']);
    expect(retention['required']).toEqual(['archivedAt', 'purgeAfter', 'retentionMs']);
    expect(members['purgeAfter']['nullable']).toBe(true);
    expect(members['retentionMs']['type']).toBe('integer');
    // The earliest-possible-purge caveat must be published, not just commented:
    // a client that renders purgeAfter as a hard deadline would be lying.
    expect(String(members['purgeAfter']['description'])).toMatch(/EARLIEST POSSIBLE/);
  });
});
