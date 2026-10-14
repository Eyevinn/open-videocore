// `statusHistory[].reason` on a SEARCH hit (issue #1085).
//
// The canonical way to find settled assets is `GET /api/v1/search?status=failed`
// — an operator sweeping up after a restart does not know the ids yet. So the
// reason has to be readable from a search hit, not only from
// `GET /api/v1/assets/{id}`. The search router declares its OWN transition
// schema (it does not import the assets router's), and the schema-driven
// serializer strips any key the schema omits, so the two can silently drift:
// only an injected request proves a hit's history reads identically here.
//
// Contract sources (CLAUDE.md rule 7):
//   - Response schema member: `transitionSchema.reason` = `z.string().optional()`
//     (src/routes/search.ts:58), reached via
//     `searchResultSchema.assets[] -> assetSchema.statusHistory`
//     (src/routes/search.ts:116, :154).
//   - Route: `GET /` on `searchRouter`, 200 = `searchResultSchema`
//     (src/routes/search.ts:310).
//   - `SearchRepository.search(query)` / `SearchResult`
//     (src/data/search-repo.ts:95) and the test implementation
//     `InMemorySearchRepository(assets, collections?)`
//     (src/data/inmemory-search-repo.ts:28).
//   - Reason constant `INTERRUPTED_PULL_ASSET_REASON`
//     (src/pipeline/interrupted-ingest-reconciler.ts:143).

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { searchRouter } from './search.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemorySearchRepository } from '../data/inmemory-search-repo.js';
import { INTERRUPTED_PULL_ASSET_REASON } from '../pipeline/interrupted-ingest-reconciler.js';

type TransitionBody = { at: string; from: string | null; to: string; reason?: string };
type SearchBody = {
  assets: { id: string; status: string; statusHistory: TransitionBody[] }[];
  total: number;
};

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(repo)
  });
  await app.ready();
  return app;
}

describe('search hits serialize statusHistory[].reason (issue #1085)', () => {
  it('returns the settle reason on a `?status=failed` hit', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const created = await repo.create({ name: 'interrupted-pull-clip' });
    await repo.update(created.id, {
      status: 'failed',
      statusReason: INTERRUPTED_PULL_ASSET_REASON
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/search/?status=failed' });
    expect(res.statusCode).toBe(200);

    const body = res.json<SearchBody>();
    const hit = body.assets.find((a) => a.id === created.id);
    expect(hit).toBeDefined();
    const settle = hit?.statusHistory.at(-1) as TransitionBody;
    expect(settle.from).toBe('uploading');
    expect(settle.to).toBe('failed');
    expect(settle.reason).toBe(INTERRUPTED_PULL_ASSET_REASON);
    expect(res.payload).toContain(INTERRUPTED_PULL_ASSET_REASON);

    await app.close();
  });

  it('omits `reason` on a hit whose history carries none', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const created = await repo.create({ name: 'user-driven-clip' });
    await repo.update(created.id, { status: 'processing' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/search/?status=processing' });
    expect(res.statusCode).toBe(200);
    const hit = res.json<SearchBody>().assets.find((a) => a.id === created.id);
    expect(hit).toBeDefined();
    for (const entry of hit?.statusHistory ?? []) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
    }

    await app.close();
  });
});
