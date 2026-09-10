// Collection descriptive-metadata caps (issue #562).
//
// The collection `custom` bag and the `tags`/`description` fields (added in
// #559/#560) are open/unbounded at the type level; without API-layer caps a
// caller can inflate a single collection document. This suite asserts that both
// the create (POST /) and update (PATCH /:id) paths reject metadata exceeding a
// cap with a machine-readable 400, and accept within-cap metadata unchanged.
//
// Contract sources verified:
//   - Routes + caps: src/routes/collections.ts
//       createBodySchema / updateBodySchema carry description/tags/custom;
//       checkCollectionMetadataCaps + COLLECTION_* constants are the caps;
//       a breach returns 400 { error: 'metadata_cap_exceeded', reason, message }.
//   - Collection type fields: src/data/collection-repo.ts (description?, tags?,
//       custom?).

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
import { collectionsRouter } from '../src/routes/collections.js';
import {
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_TAGS_MAX_COUNT,
  COLLECTION_TAG_MAX_LENGTH,
  COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES,
  checkCollectionMetadataCaps
} from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';

const A = { authorization: 'Bearer token-a' } as const;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const collections = new InMemoryCollectionRepository();
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: collections,
    assetRepository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

async function create(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/collections', headers: A, payload });
}

describe('collection metadata caps — pure cap check (issue #562)', () => {
  it('passes within-cap metadata', () => {
    expect(
      checkCollectionMetadataCaps({
        description: 'x'.repeat(COLLECTION_DESCRIPTION_MAX_LENGTH),
        tags: Array.from({ length: COLLECTION_TAGS_MAX_COUNT }, (_, i) => `t${i}`),
        custom: { a: 1 }
      })
    ).toBeUndefined();
  });

  it('flags an over-long description', () => {
    const v = checkCollectionMetadataCaps({
      description: 'x'.repeat(COLLECTION_DESCRIPTION_MAX_LENGTH + 1)
    });
    expect(v?.reason).toBe('description_too_long');
  });

  it('flags too many tags', () => {
    const v = checkCollectionMetadataCaps({
      tags: Array.from({ length: COLLECTION_TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`)
    });
    expect(v?.reason).toBe('too_many_tags');
  });

  it('flags an over-long single tag', () => {
    const v = checkCollectionMetadataCaps({ tags: ['x'.repeat(COLLECTION_TAG_MAX_LENGTH + 1)] });
    expect(v?.reason).toBe('tag_too_long');
  });

  it('flags an over-large serialized custom bag', () => {
    const big = 'y'.repeat(COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES + 1);
    const v = checkCollectionMetadataCaps({ custom: { blob: big } });
    expect(v?.reason).toBe('custom_too_large');
  });
});

describe('collection metadata caps — create path (issue #562)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('accepts within-cap metadata unchanged', async () => {
    const res = await create(app, {
      name: 'c1',
      description: 'a modest description',
      tags: ['news', 'sv'],
      custom: { project: 'demo', priority: 3 }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.description).toBe('a modest description');
    expect(body.tags).toEqual(['news', 'sv']);
    expect(body.custom).toEqual({ project: 'demo', priority: 3 });
  });

  it('rejects an over-large custom bag with a machine-readable reason', async () => {
    const big = 'y'.repeat(COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES + 1);
    const res = await create(app, { name: 'c2', custom: { blob: big } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('metadata_cap_exceeded');
    expect(res.json().reason).toBe('custom_too_large');
    expect(typeof res.json().message).toBe('string');
  });

  it('rejects an over-long description', async () => {
    const res = await create(app, {
      name: 'c3',
      description: 'x'.repeat(COLLECTION_DESCRIPTION_MAX_LENGTH + 1)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('description_too_long');
  });

  it('rejects too many tags', async () => {
    const res = await create(app, {
      name: 'c4',
      tags: Array.from({ length: COLLECTION_TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('too_many_tags');
  });

  it('does not persist a rejected collection', async () => {
    const big = 'y'.repeat(COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES + 1);
    await create(app, { name: 'rejected', custom: { blob: big } });
    const list = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: A });
    expect(list.json().collections.some((c: { name: string }) => c.name === 'rejected')).toBe(
      false
    );
  });
});

describe('collection metadata caps — update path (issue #562)', () => {
  let app: FastifyInstance;
  let id: string;
  beforeEach(async () => {
    app = await buildApp();
    id = (await create(app, { name: 'base' })).json().id;
  });

  it('accepts a within-cap update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: A,
      payload: { description: 'updated', tags: ['a'], custom: { k: 'v' } }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe('updated');
  });

  it('rejects an over-large custom bag on update', async () => {
    const big = 'y'.repeat(COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES + 1);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: A,
      payload: { custom: { blob: big } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('metadata_cap_exceeded');
    expect(res.json().reason).toBe('custom_too_large');
  });

  it('does not mutate the stored document when an update is rejected', async () => {
    const big = 'y'.repeat(COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES + 1);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: A,
      payload: { description: 'should-not-apply', custom: { blob: big } }
    });
    const read = await app.inject({ method: 'GET', url: `/api/v1/collections/${id}`, headers: A });
    expect(read.json().description).toBeUndefined();
  });
});
