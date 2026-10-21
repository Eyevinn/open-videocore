// Rename identity-stability regression (issue #927, AC3).
//
// A rename is allowed to change exactly one thing an operator can see — the
// asset's editorial title — and NOTHING that anything else in the system is
// holding a reference to. The acceptance criterion names three: the `id`, the
// `slug`, and the stored object key(s). This file is the regression net for that
// property, asserted through the PUBLIC route rather than by reading the
// repository code: a future change that started deriving a slug from the name, or
// re-keying stored objects on rename, would break links, presigned download URLs
// and in-flight jobs, and it must fail here first.
//
// It also pins AC2 — the new name appearing in the asset list and in search — on
// the same path, in one scenario, so the two criteria cannot be satisfied
// separately by two different behaviours.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT GROUNDING (CLAUDE.md rule 7 — read in this tree before anything below
// was written; no field name or status code is taken from the issue text).
//
//   The write — PATCH /api/v1/assets/{id}
//     openapi.json .paths["/api/v1/assets/{id}"].patch:
//       parameters: exactly one, path `id` (string, required);
//       requestBody properties: `name` (string, minLength 1, maxLength 256),
//         `description`, `objectKey`, `status`, `metadata`, `tags` — every one
//         optional, `additionalProperties: false`;
//       responses: 200 (the full asset), 404, 422.
//     Source of truth: `updateSchema` (src/routes/assets.ts:418) with
//       `name: z.string().min(1).max(256).optional()` at :420 and
//       `.refine(b => Object.keys(b).length > 0)`; wired at
//       `app.patch('/:id', …)` src/routes/assets.ts:5682, response map
//       `{ 200: assetSchema, 404: errorSchema, 422: errorSchema }`.
//     So renaming needs NO schema change — `name` was always accepted. That is
//     the premise of #927 and it is re-checked by the body this file sends.
//
//   Why the identity cannot move (the behaviour under test, not an assumption):
//     - `slug` is minted ONCE at creation by `generateUniqueSlug`
//       (src/data/asset-repo.ts:1424, inside `create`). Neither update path
//       assigns `slug`: `InMemoryAssetRepository.update`
//       (src/data/asset-repo.ts:1620) and `CouchAssetRepository.applyPatch`
//       (src/data/couch-asset-repo.ts:376) copy the existing asset and then
//       assign ONLY the keys the patch carries.
//     - `id` is the ULID store key on both paths and is never rewritten.
//     - stored object keys derive from the ASSET ID, never from the name —
//       `sourceObjectKey(assetId) => 'sources/' + assetId`
//       (src/routes/asset-upload.ts:96). `objectKey` moves only when the patch
//       itself carries one (asset-repo.ts:1633).
//     The four places an asset holds object keys are all covered below:
//       `objectKey` (the source), `renditions[].objectKey`,
//       `subtitleTracks[].objectKey` and `thumbnails[]` — the storage-class
//       groups listed at src/data/asset-repo.ts:157-169.
//
//   Why one rename is enough for list AND search (AC2):
//     `name` is the single documented location for an asset's title across GET,
//     list and search responses (the property description in openapi.json), and
//     search is a read-through projection over the live asset documents, not a
//     separate index: `InMemorySearchRepository.search` reads `assets.list()`
//     (src/data/inmemory-search-repo.ts:38) and matches in process via
//     `matchesQuery`. The Couch tier has the same property and is covered at that
//     tier by test/rename-search-freshness.test.ts (issue #929). There is no
//     reindex step for this file to call, and it deliberately calls none.
//
// The repository under test is the in-memory one, driven through the real
// routers — the same choice, for the same reason, as test/asset-lifecycle.test.ts:
// the rules being asserted live in the shared domain layer, not in the storage
// wiring.

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
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

const A = { authorization: 'Bearer token-a' };

const OLD_NAME = 'promo-cut.mov';
const NEW_NAME = 'Autumn campaign — master';

type Harness = { app: FastifyInstance; assets: InMemoryAssetRepository };

async function buildApp(): Promise<Harness> {
  const assets = new InMemoryAssetRepository();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: assets });
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(assets)
  });
  await app.ready();
  return { app, assets };
}

async function getAsset(app: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function rename(
  app: FastifyInstance,
  id: string,
  name: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/assets/${id}`,
    headers: A,
    // EXACTLY the field the affordance sends (renameRequestBody,
    // public/asset-rename.js) — no sibling field rides along.
    payload: { name }
  });
  return { status: res.statusCode, body: res.json() };
}

/**
 * An asset that owns object keys in all four storage groups, so a rename has
 * something to break. The keys are seeded through the repository, which is how the
 * pipeline fills them: `renditions`, `thumbnails` and `subtitleTracks` are not on
 * the PATCH body schema at all, and the source key an upload would mint is
 * `sources/<id>` (sourceObjectKey, src/routes/asset-upload.ts:96).
 */
async function seedAsset(h: Harness): Promise<{ id: string; before: Record<string, unknown> }> {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: OLD_NAME, description: 'Rough cut delivered by the agency' }
  });
  expect(created.statusCode).toBe(201);
  const id = String(created.json().id);

  await h.assets.update(id, {
    objectKey: `sources/${id}`,
    renditions: [
      {
        id: 'r-1080',
        label: '1080p',
        width: 1920,
        height: 1080,
        objectKey: `renditions/${id}/1080p.mp4`
      }
    ],
    thumbnails: [`thumbnails/${id}/0001.jpg`, `thumbnails/${id}/0002.jpg`],
    subtitleTracks: [
      { id: 'st-sv', language: 'sv', format: 'vtt', objectKey: `subtitles/${id}/sv.vtt` }
    ]
  });

  return { id, before: await getAsset(h.app, id) };
}

describe('renaming an asset leaves its identity and its stored objects alone (issue #927)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('accepts a name-only PATCH and returns the renamed asset', async () => {
    const { id } = await seedAsset(h);
    const { status, body } = await rename(h.app, id, NEW_NAME);
    expect(status).toBe(200);
    expect(body['name']).toBe(NEW_NAME);
    // The 200 carries the FULL asset, which is what lets the UI re-render from
    // the response instead of guessing.
    expect(body['id']).toBe(id);
    expect(body['status']).toBe('uploading');
  });

  it('keeps the id and the slug exactly as they were', async () => {
    const { id, before } = await seedAsset(h);
    expect(before['slug']).toBeTruthy();

    await rename(h.app, id, NEW_NAME);
    const after = await getAsset(h.app, id);

    expect(after['id']).toBe(before['id']);
    expect(after['slug']).toBe(before['slug']);
    // Not re-derived from the new title: the slug still reads as the one minted
    // from the ORIGINAL name, and carries nothing from the new one.
    expect(String(after['slug'])).not.toContain('autumn');
    expect(String(after['slug'])).not.toContain('campaign');
  });

  it('keeps the asset reachable by the same slug after the rename', async () => {
    const { id, before } = await seedAsset(h);
    await rename(h.app, id, NEW_NAME);

    // GET /assets/:id is the one slug-tolerant asset read (resolveAsset), so this
    // is the assertion that existing slug links still resolve.
    const bySlug = await getAsset(h.app, String(before['slug']));
    expect(bySlug['id']).toBe(id);
    expect(bySlug['name']).toBe(NEW_NAME);
  });

  it('keeps every stored object key: source, renditions, subtitles, thumbnails', async () => {
    const { id, before } = await seedAsset(h);
    await rename(h.app, id, NEW_NAME);
    const after = await getAsset(h.app, id);

    expect(after['objectKey']).toBe(before['objectKey']);
    expect(after['objectKey']).toBe(`sources/${id}`);
    expect(after['renditions']).toEqual(before['renditions']);
    expect(after['thumbnails']).toEqual(before['thumbnails']);
    expect(after['subtitleTracks']).toEqual(before['subtitleTracks']);

    // Nothing anywhere in the document was re-keyed on the new title.
    expect(JSON.stringify(after)).not.toContain('Autumn-campaign');
    expect(JSON.stringify(after)).not.toContain('autumn-campaign');
  });

  it('changes nothing else in the document except the name, its timestamp and its provenance', async () => {
    const { id, before } = await seedAsset(h);
    await rename(h.app, id, NEW_NAME);
    const after = await getAsset(h.app, id);

    // Whitelist rather than a field-by-field check, so a field added to the asset
    // document in future is covered by this regression the day it appears.
    //   name       — the point of the operation
    //   updatedAt  — every update stamps it (asset-repo.ts:1630)
    // The repository also appends a `descriptive` provenance entry for a patch
    // carrying `name` (provenanceForPatch, asset-repo.ts:1136-1145), but
    // `provenance` is not part of this response's projection — the GET /{id}
    // schema's properties are id, name, slug, description, status, reviewState,
    // deleteLock, storageTiering, parentId, versionOfAssetId, versionGroupId,
    // objectKey, statusHistory, technicalMetadata, technicalMetadataError,
    // sceneMetadata, sceneDetectionError, manifestUrls, packagingError,
    // renditions, thumbnails, metadata, audioTracks, subtitleTracks, tags,
    // createdAt, updatedAt (openapi.json
    // .paths["/api/v1/assets/{id}"].get.responses["200"]) — so it is not
    // observable here and is deliberately not listed.
    const ALLOWED_TO_CHANGE = ['name', 'updatedAt'];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [...keys].filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
    );
    // Nothing outside the whitelist moved — the assertion that matters.
    expect(changed.filter((k) => !ALLOWED_TO_CHANGE.includes(k))).toEqual([]);
    expect(changed).toContain('name');
    // `updatedAt` is checked as monotonic rather than as necessarily different:
    // `new Date().toISOString()` has millisecond resolution, so a seed and a
    // rename that land inside the same millisecond legitimately stamp the same
    // value. Asserting inequality there would make this test clock-dependent.
    expect(String(after['updatedAt']) >= String(before['updatedAt'])).toBe(true);

    expect(after['createdAt']).toBe(before['createdAt']);
    expect(after['status']).toBe(before['status']);
    expect(after['statusHistory']).toEqual(before['statusHistory']);
    expect(after['description']).toBe(before['description']);
  });

  it('holds the identity stable across repeated renames', async () => {
    const { id, before } = await seedAsset(h);
    for (const name of ['first pass', 'second pass', NEW_NAME]) {
      const { status } = await rename(h.app, id, name);
      expect(status).toBe(200);
    }
    const after = await getAsset(h.app, id);
    expect(after['name']).toBe(NEW_NAME);
    expect(after['id']).toBe(id);
    expect(after['slug']).toBe(before['slug']);
    expect(after['objectKey']).toBe(before['objectKey']);
  });
});

describe('a renamed asset reads back with the new name in the list and in search (issue #927)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  async function listNames(): Promise<Record<string, unknown>[]> {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/assets/', headers: A });
    expect(res.statusCode).toBe(200);
    return res.json().items as Record<string, unknown>[];
  }

  async function searchFor(q: string): Promise<Record<string, unknown>[]> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    return res.json().assets as Record<string, unknown>[];
  }

  it('shows the new name on the list, with the slug and id unchanged there too', async () => {
    const { id, before } = await seedAsset(h);
    await rename(h.app, id, NEW_NAME);

    const row = (await listNames()).find((a) => a['id'] === id);
    expect(row).toBeTruthy();
    expect(row!['name']).toBe(NEW_NAME);
    expect(row!['slug']).toBe(before['slug']);
  });

  it('matches the new name on the very next search request, with no reindex step', async () => {
    const { id } = await seedAsset(h);
    await rename(h.app, id, NEW_NAME);

    // Nothing is called between the rename and this search.
    const hits = await searchFor('Autumn campaign');
    expect(hits.map((a) => a['id'])).toContain(id);
    expect(hits.find((a) => a['id'] === id)!['name']).toBe(NEW_NAME);
  });

  it('stops matching the old name, so no stale title survives in search', async () => {
    const { id } = await seedAsset(h);
    expect((await searchFor('promo-cut')).map((a) => a['id'])).toContain(id);

    await rename(h.app, id, NEW_NAME);

    expect((await searchFor('promo-cut')).map((a) => a['id'])).not.toContain(id);
  });
});
