// Read-time `assetName` enrichment on the jobs API (issue #988).
//
// The jobs listing identified an asset by a 26-char ULID and nothing else. The
// pipelines listing had already solved this one route over, so this mirrors it:
// each job read resolves the asset and carries its human-readable name.
//
// ─── Contract grounding (verified before these assertions were written) ──────
//   - `jobSchema.assetName` — OPTIONAL string, src/routes/jobs.ts:62. Fastify
//     serializes the response against this schema, so a field absent from it
//     would be stripped; the test below would fail loudly rather than silently.
//   - The enrichment pattern mirrored: src/routes/pipelines.ts:95-102
//     (parallel per-row lookup, `.catch(() => undefined)`).
//   - `AssetRepository.get(id): Promise<Asset | undefined>` and `Asset.name:
//     string` — src/data/asset-repo.ts:874 and :476.
//   - `JobRepository.list(): Promise<{ items, total }>` — src/data/job-repo.ts:276.
// Harness wiring (Zod compilers + in-memory repos + connections decoration)
// follows jobs-encode-attempts-read.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryAssetRepository, type AssetRepository } from '../src/data/asset-repo.js';

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
  assets: InMemoryAssetRepository;
};

async function buildApp(assetRepository?: AssetRepository): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {};
  });

  await app.register(jobsRouter, {
    prefix: '/api/v1/jobs',
    repository: jobs,
    assetRepository: assetRepository ?? assets
  });
  await app.ready();
  return { app, jobs, assets };
}

describe('jobs carry the asset name (issue #988)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('GET /api/v1/jobs returns assetName for every job whose asset resolves', async () => {
    const a = await h.assets.create({ name: 'Opening keynote' });
    const b = await h.assets.create({ name: 'Panel discussion' });
    const j1 = await h.jobs.create({ type: 'transcode', assetId: a.id });
    const j2 = await h.jobs.create({ type: 'ingest-url', assetId: b.id });

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/jobs/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);

    const byId = Object.fromEntries(
      (body.items as Array<{ id: string; assetId: string; assetName?: string }>).map((j) => [j.id, j])
    );
    expect(byId[j1.id].assetName).toBe('Opening keynote');
    expect(byId[j2.id].assetName).toBe('Panel discussion');
    // The ULID is NOT replaced — it remains the identifier every asset endpoint
    // accepts, and the UI keeps it beside the name.
    expect(byId[j1.id].assetId).toBe(a.id);
    expect(byId[j2.id].assetId).toBe(b.id);
  });

  it('GET /api/v1/jobs/:id returns assetName for a single job', async () => {
    const asset = await h.assets.create({ name: 'Archive reel 42' });
    const job = await h.jobs.create({ type: 'transcode', assetId: asset.id });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().assetName).toBe('Archive reel 42');
    expect(res.json().assetId).toBe(asset.id);
  });

  it('still lists a job whose asset was deleted — no name, ULID intact', async () => {
    const live = await h.assets.create({ name: 'Still here' });
    const doomed = await h.assets.create({ name: 'About to go' });
    const keptJob = await h.jobs.create({ type: 'transcode', assetId: live.id });
    const orphanJob = await h.jobs.create({ type: 'transcode', assetId: doomed.id });

    // Hard removal: `purgeToTombstone` drops the live record (src/data/
    // asset-repo.ts:1484), so `get()` reads it back as undefined — the exact
    // state a job pointing at a deleted asset is left in.
    expect(h.assets.purgeToTombstone(doomed.id)).toBe(true);
    expect(await h.assets.get(doomed.id)).toBeUndefined();

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/jobs/' });
    // The listing does NOT fail, and it does not drop the orphaned row.
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; assetId: string; assetName?: string }>;
    expect(items).toHaveLength(2);

    const orphan = items.find((j) => j.id === orphanJob.id)!;
    expect(orphan.assetName).toBeUndefined();
    expect(orphan.assetId).toBe(doomed.id); // the ULID is what the row falls back to
    // One missing asset degrades that row ALONE — its neighbour keeps its name.
    expect(items.find((j) => j.id === keptJob.id)!.assetName).toBe('Still here');

    const detail = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${orphanJob.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assetName).toBeUndefined();
    expect(detail.json().assetId).toBe(doomed.id);
  });

  it('degrades to no name (never a 500) when the asset store throws', async () => {
    // The `.catch(() => undefined)` in the route, exercised directly: an
    // unreachable store must not take the jobs listing down with it.
    const throwing = {
      get: async () => {
        throw new Error('asset store unreachable');
      }
    } as unknown as AssetRepository;
    const broken = await buildApp(throwing);
    const job = await broken.jobs.create({ type: 'transcode', assetId: 'asset-x' });

    const list = await broken.app.inject({ method: 'GET', url: '/api/v1/jobs/' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].assetName).toBeUndefined();
    expect(list.json().items[0].assetId).toBe('asset-x');

    const detail = await broken.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assetName).toBeUndefined();
  });

  it('serves jobs unchanged when the router is registered without an asset repository', async () => {
    // Every repo on this router is optional; the enrichment must not become a
    // hard dependency for the existing registrations that omit it.
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const jobs = new InMemoryJobRepository();
    app.decorateRequest('connections', null);
    app.addHook('preHandler', async (request) => {
      (request as unknown as { connections: unknown }).connections = {};
    });
    await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
    await app.ready();

    await jobs.create({ type: 'transcode', assetId: 'asset-y' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].assetName).toBeUndefined();
    expect(res.json().items[0].assetId).toBe('asset-y');
  });

  it('resolves a 50-job page with ONE round of parallel lookups, not 50 serial ones', async () => {
    // The acceptance criterion "a 50-job listing does not measurably slow down"
    // is a structural property, not a wall-clock one: the per-row lookups are
    // issued together (Promise.all), so the page costs one lookup's latency.
    // Asserted by counting overlapping in-flight reads against a deliberately
    // slow store — a serial implementation would never exceed 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = {
      get: async (id: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { id, name: 'Asset ' + id } as never;
      }
    } as unknown as AssetRepository;

    const slowApp = await buildApp(slow);
    for (let i = 0; i < 50; i += 1) {
      await slowApp.jobs.create({ type: 'transcode', assetId: 'asset-' + i });
    }

    const res = await slowApp.app.inject({ method: 'GET', url: '/api/v1/jobs/?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(50);
    expect(maxInFlight).toBe(50);
  });
});
