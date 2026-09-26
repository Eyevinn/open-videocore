// Full-text + metadata search tests (issue #10).
//
// Exercises the search router against the in-memory search repository, which
// shares the matchesQuery semantics with the CouchDB fallback path, so the
// match rules under test here are backend-agnostic by construction.

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
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// Seed an asset directly through the repository, allowing test-only fields
// (tags, technicalMetadata) the public create() does not accept.
async function seed(
  repo: InMemoryAssetRepository,
  workspaceId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const asset = await repo.create({ name: String(fields['name'] ?? 'asset') });
  if (fields['technicalMetadata']) {
    await repo.update(asset.id, {
      technicalMetadata: fields['technicalMetadata'] as never
    });
  }
  if (fields['description']) {
    await repo.update(asset.id, { description: String(fields['description']) });
  }
  // tags are not part of the public model; attach them to the stored record.
  if (fields['tags']) {
    const stored = await repo.get(asset.id);
    (stored as { tags?: unknown }).tags = fields['tags'];
    (repo as unknown as { store: Map<string, unknown> }).store.set(asset.id, stored);
  }
}

function meta(containerFormat: string): Record<string, unknown> {
  return {
    codec: 'h264',
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    bitrateBps: 5_000_000,
    containerFormat,
    audioTracks: [],
    extractedAt: new Date().toISOString()
  };
}

async function buildApp(repo: InMemoryAssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(repo)
  });
  await app.ready();
  return app;
}

describe('asset search (issue #10)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    await seed(repo, 'workspace-a', {
      name: 'Sunset over the ocean',
      description: 'A calm beach clip',
      technicalMetadata: meta('mp4'),
      tags: ['nature', 'beach']
    });
    await seed(repo, 'workspace-a', {
      name: 'City traffic',
      description: 'Busy intersection at night',
      technicalMetadata: meta('webm'),
      tags: ['urban']
    });
    await seed(repo, 'workspace-a', { name: 'Untagged clip' });
    app = await buildApp(repo);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=sunset' });
    expect(res.statusCode).toBe(401);
  });

  it('matches free text over name and description', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=beach', headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.assets[0].name).toBe('Sunset over the ocean');
    expect(body.page).toBe(1);
  });

  it('is case-insensitive', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=SUNSET', headers: A });
    expect(res.json().total).toBe(1);
  });

  it('filters by mimeType (container format)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?mimeType=webm', headers: A });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.assets[0].name).toBe('City traffic');
  });

  it('filters by a single tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?tags=nature', headers: A });
    expect(res.json().total).toBe(1);
  });

  it('requires all tags to match (AND semantics)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?tags=nature,beach',
      headers: A
    });
    expect(res.json().total).toBe(1);
    const none = await app.inject({
      method: 'GET',
      url: '/api/v1/search?tags=nature,urban',
      headers: A
    });
    expect(none.json().total).toBe(0);
  });

  it('combines free text and mimeType filters', async () => {
    const hit = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=sunset&mimeType=mp4',
      headers: A
    });
    expect(hit.json().total).toBe(1);
    const miss = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=sunset&mimeType=webm',
      headers: A
    });
    expect(miss.json().total).toBe(0);
  });

  it('returns all assets when no filters are given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search', headers: A });
    expect(res.json().total).toBe(3);
  });

  it.skip('does not leak assets from another workspace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=sunset', headers: A });
    const names = res.json().assets.map((a: { name: string }) => a.name);
    expect(names).not.toContain('Sunset secret');
  });

  it('paginates results', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/search?pageSize=2&page=1',
      headers: A
    });
    expect(page1.json().assets).toHaveLength(2);
    expect(page1.json().total).toBe(3);
    expect(page1.json().page).toBe(1);

    const page2 = await app.inject({
      method: 'GET',
      url: '/api/v1/search?pageSize=2&page=2',
      headers: A
    });
    expect(page2.json().assets).toHaveLength(1);
    expect(page2.json().page).toBe(2);
  });

  it('rejects an out-of-range pageSize', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?pageSize=9999',
      headers: A
    });
    expect(res.statusCode).toBe(400);
  });
});

// Container/MIME filter (issue #822).
//
// Verified contract (CLAUDE.md rule 7):
//   - Query parameter: `mimeType`, src/routes/search.ts searchQuerySchema
//     (z.string().min(1).max(128).optional()); mirrored in openapi.json
//     "/api/v1/search/".get.parameters[] name "mimeType".
//   - Matched field: Asset.technicalMetadata.containerFormat
//     (src/data/asset-repo.ts:312 TechnicalMetadata.containerFormat; surfaced in
//     the response by src/routes/search.ts technicalMetadataSchema).
//   - Stored value shape: ffprobe's comma-separated `format.format_name`, copied
//     verbatim by src/pipeline/metadata-extractor.ts:125 — e.g. "mov,mp4,m4a"
//     and "matroska,webm" (asserted independently in
//     test/metadata-extraction.test.ts:128,189).
//
// Before the fix the matcher compared the WHOLE stored string for equality
// against the raw query value, so the UI's own placeholder ("video/mp4") and a
// real probe value ("mov,mp4,m4a" queried as "mp4") both returned an empty page
// that was indistinguishable from "no assets match".
describe('mimeType filter matches real container values (issue #822)', () => {
  let repo: InMemoryAssetRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    // The container formats an actual probe emits, not tidied-up tokens.
    await seed(repo, 'workspace-a', {
      name: 'Probed MP4',
      technicalMetadata: meta('mov,mp4,m4a,3gp,3g2,mj2')
    });
    await seed(repo, 'workspace-a', {
      name: 'Probed WebM',
      technicalMetadata: meta('matroska,webm')
    });
    await seed(repo, 'workspace-a', { name: 'Unprobed clip' });
    app = await buildApp(repo);
  });

  const total = (body: { total: number }) => body.total;

  it('matches the Search tab placeholder value "video/mp4"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?mimeType=video%2Fmp4',
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(total(body)).toBe(1);
    expect(body.assets[0].name).toBe('Probed MP4');
  });

  it('matches a bare container token against the comma-separated family', async () => {
    for (const value of ['mp4', 'mov', 'MP4']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/search?mimeType=${value}`,
        headers: A
      });
      expect(total(res.json()), value).toBe(1);
      expect(res.json().assets[0].name).toBe('Probed MP4');
    }
  });

  it('still matches the exact stored container string', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?mimeType=mov%2Cmp4%2Cm4a%2C3gp%2C3g2%2Cmj2',
      headers: A
    });
    expect(total(res.json())).toBe(1);
  });

  it('maps webm/matroska MIME types onto the probed family', async () => {
    for (const value of ['video/webm', 'video/x-matroska', 'webm', 'matroska']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/search?mimeType=${encodeURIComponent(value)}`,
        headers: A
      });
      expect(total(res.json()), value).toBe(1);
      expect(res.json().assets[0].name).toBe('Probed WebM');
    }
  });

  it('ignores MIME parameters when resolving the container family', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/search?mimeType=${encodeURIComponent('video/mp4; codecs="avc1.42E01E"')}`,
      headers: A
    });
    expect(total(res.json())).toBe(1);
  });

  it('does not match a different container family', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?mimeType=video%2Fwebm&q=MP4',
      headers: A
    });
    expect(total(res.json())).toBe(0);
  });

  it('never matches an asset that has no probed container format', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?mimeType=mp4', headers: A });
    const names = res.json().assets.map((a: { name: string }) => a.name);
    expect(names).not.toContain('Unprobed clip');
  });

  // Acceptance criterion 3: a value that CANNOT match any asset must be
  // distinguishable from a search that legitimately found nothing. A MIME-shaped
  // value that maps to no container family is structurally unmatchable
  // (container formats never contain "/"), so it fails at the boundary.
  it('rejects an unmatchable MIME-shaped value with 400 instead of an empty page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?mimeType=video%2Fnot-a-real-type',
      headers: A
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('unsupported_mime_type');
    expect(body.message).toContain('video/not-a-real-type');
    // The message tells the caller what IS accepted.
    expect(body.message).toContain('video/mp4');
    expect(body.message).toContain('mp4');
  });

  it('does not reject a bare value that simply matches nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?mimeType=avi', headers: A });
    expect(res.statusCode).toBe(200);
    expect(total(res.json())).toBe(0);
  });
});
