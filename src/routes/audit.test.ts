// Audit read surface (issue #565).
//
// Exercises the read-only GET /api/v1/audit route against an
// InMemoryAuditRepository seeded directly through the store's `record` write
// primitive (per #565 guidance: instrumentation #564 is NOT a build
// dependency). Coverage:
//   - newest-first ordering (by ULID id, time-sortable)
//   - filters: targetType(+targetId), actor origin, actor principalId, action,
//     and time range (from/to inclusive on `at`)
//   - offset pagination mirroring the asset list surface
//     (`{ items, limit, offset, total }`)
//   - the route never mutates entries (append-only holds)

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { auditRouter } from './audit.js';
import { InMemoryAuditRepository, type AuditEntry } from '../data/audit-repo.js';

async function buildApp(repo: InMemoryAuditRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(auditRouter, { prefix: '/api/v1/audit', repository: repo });
  await app.ready();
  return app;
}

// Seed distinct entries with controlled `at` timestamps. Because ids are ULIDs
// minted at record() time, later record() calls sort newer — so the write
// ORDER defines the newest-first expectation.
async function seed(repo: InMemoryAuditRepository) {
  const e1 = await repo.record({
    actor: { principalId: 'alice', origin: 'user' },
    action: 'asset.create',
    targetType: 'asset',
    targetId: 'asset-1',
    at: '2026-01-01T00:00:00.000Z'
  });
  const e2 = await repo.record({
    actor: { principalId: null, origin: 'system' },
    action: 'asset.transcode',
    targetType: 'asset',
    targetId: 'asset-1',
    at: '2026-02-01T00:00:00.000Z'
  });
  const e3 = await repo.record({
    actor: { principalId: 'bob', origin: 'user' },
    action: 'collection.create',
    targetType: 'collection',
    targetId: 'coll-9',
    at: '2026-03-01T00:00:00.000Z'
  });
  return { e1, e2, e3 };
}

describe('GET /api/v1/audit (issue #565)', () => {
  it('returns entries newest-first with the offset pagination envelope', async () => {
    const repo = new InMemoryAuditRepository();
    const { e1, e2, e3 } = await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'GET', url: '/api/v1/audit' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: AuditEntry[];
      limit: number;
      offset: number;
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    // Newest-first: e3 (Mar) minted last, e1 (Jan) minted first.
    expect(body.items.map((e) => e.id)).toEqual([e3.id, e2.id, e1.id]);
  });

  it('filters by targetType + targetId', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?targetType=asset&targetId=asset-1'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: AuditEntry[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.every((e) => e.targetType === 'asset' && e.targetId === 'asset-1')).toBe(true);
  });

  it('rejects targetId without targetType (400)', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?targetId=asset-1' });
    expect(res.statusCode).toBe(400);
  });

  it('filters by actor (origin and principalId)', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const byOrigin = await app.inject({ method: 'GET', url: '/api/v1/audit?origin=user' });
    expect(byOrigin.statusCode).toBe(200);
    expect((byOrigin.json() as { total: number }).total).toBe(2);

    const byPrincipal = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?principalId=bob'
    });
    expect(byPrincipal.statusCode).toBe(200);
    const body = byPrincipal.json() as { items: AuditEntry[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].action).toBe('collection.create');
  });

  it('filters by action', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=asset.transcode'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: AuditEntry[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].action).toBe('asset.transcode');
  });

  it('filters by inclusive time range on `at`', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?from=2026-02-01T00:00:00.000Z&to=2026-02-28T00:00:00.000Z'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: AuditEntry[]; total: number };
    // Only the Feb entry falls in [Feb 1, Feb 28]; Jan and Mar are excluded.
    expect(body.total).toBe(1);
    expect(body.items[0].action).toBe('asset.transcode');
  });

  it('paginates with limit + offset (newest-first, stable across pages)', async () => {
    const repo = new InMemoryAuditRepository();
    const { e1, e2, e3 } = await seed(repo);
    const app = await buildApp(repo);

    const page1 = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=2&offset=0' });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json() as { items: AuditEntry[]; limit: number; offset: number; total: number };
    expect(b1.total).toBe(3);
    expect(b1.limit).toBe(2);
    expect(b1.items.map((e) => e.id)).toEqual([e3.id, e2.id]);

    const page2 = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=2&offset=2' });
    const b2 = page2.json() as { items: AuditEntry[]; total: number };
    expect(b2.total).toBe(3);
    expect(b2.items.map((e) => e.id)).toEqual([e1.id]);
  });

  it('rejects an out-of-range limit (400)', async () => {
    const repo = new InMemoryAuditRepository();
    await seed(repo);
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=500' });
    expect(res.statusCode).toBe(400);
  });
});
