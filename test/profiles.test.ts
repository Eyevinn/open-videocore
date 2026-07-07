// Encore profile management tests (issue #84).
//
// Exercises the profiles router + bootstrap against the in-memory repository,
// which mirrors the CouchDB backend's naming semantics, so the rules under test
// are backend-agnostic by construction. The whole router is unauthenticated by
// design (public index.yml must be reachable by Encore without a token), so no
// auth wiring is needed here.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { profilesRouter } from '../src/routes/profiles.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import { parseProfileIndex, bootstrapProfiles } from '../src/services/profile-bootstrap.js';

const BOOTSTRAP_URL = 'https://example.test/profiles.yml';

async function buildApp(repo: InMemoryProfileRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: repo,
    bootstrapIndexUrl: BOOTSTRAP_URL
  });
  await app.ready();
  return app;
}

describe('profiles CRUD router (issue #84)', () => {
  let repo: InMemoryProfileRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryProfileRepository();
    app = await buildApp(repo);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates, lists, gets, updates and deletes a profile', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'program', yaml: 'name: program\n' }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: 'program', yaml: 'name: program\n' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
    expect(list.statusCode).toBe(200);
    expect(list.json().profiles).toEqual(['program']);
    expect(list.json().items).toHaveLength(1);

    const get = await app.inject({ method: 'GET', url: '/api/v1/profiles/program' });
    expect(get.statusCode).toBe(200);
    expect(get.json().yaml).toBe('name: program\n');

    const update = await app.inject({
      method: 'PUT',
      url: '/api/v1/profiles/program',
      payload: { yaml: 'name: program\nupdated: true\n' }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().yaml).toContain('updated: true');

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/program' });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: '/api/v1/profiles/program' });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects a duplicate name with 409', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'a', yaml: 'x: 1\n' } });
    const dup = await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'a', yaml: 'y: 2\n' } });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects an invalid profile name with 400', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'bad name/../etc', yaml: 'x: 1\n' }
    });
    expect(bad.statusCode).toBe(400);
  });

  it('DELETE of an unknown profile is idempotent (204)', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/nope' });
    expect(del.statusCode).toBe(204);
  });

  it('PUT of an unknown profile is 404', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/v1/profiles/nope', payload: { yaml: 'x: 1\n' } });
    expect(put.statusCode).toBe(404);
  });

  it('serves a valid Encore-format index.yml with per-profile refs', async () => {
    await repo.create({ name: 'program', yaml: 'a: 1\n' });
    await repo.create({ name: 'archive', yaml: 'b: 2\n' });

    const index = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/yaml');
    // Sorted, each name mapped to its per-profile yaml document.
    expect(index.body).toBe('archive: archive/yaml\nprogram: program/yaml\n');
  });

  it('serves per-profile raw YAML', async () => {
    await repo.create({ name: 'program', yaml: 'name: program\nfoo: bar\n' });
    const yaml = await app.inject({ method: 'GET', url: '/api/v1/profiles/program/yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toContain('text/yaml');
    expect(yaml.body).toBe('name: program\nfoo: bar\n');
  });
});

describe('profile bootstrap (issue #84)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a flat Encore profile index', () => {
    const parsed = parseProfileIndex('# comment\nprogram: program.yml\narchive: archive.yml\nnone: none.yml\n');
    expect(parsed).toEqual([
      { name: 'program', ref: 'program.yml' },
      { name: 'archive', ref: 'archive.yml' },
      { name: 'none', ref: 'none.yml' }
    ]);
  });

  it('seeds the repository from the index, resolving each ref, and skips "none"', async () => {
    const repo = new InMemoryProfileRepository();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/profiles.yml')) {
        return new Response('program: program.yml\nnone: none.yml\n', { status: 200 });
      }
      if (url.endsWith('/program.yml')) {
        return new Response('name: program\n', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await bootstrapProfiles({
      repository: repo,
      indexUrl: 'https://example.test/dir/profiles.yml'
    });

    expect(result).toEqual({ seeded: 1, skipped: false });
    const stored = await repo.list();
    expect(stored.map((p) => p.name)).toEqual(['program']);
    expect(stored[0].yaml).toBe('name: program\n');
  });

  it('skips seeding when profiles already exist', async () => {
    const repo = new InMemoryProfileRepository();
    await repo.create({ name: 'existing', yaml: 'x: 1\n' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await bootstrapProfiles({ repository: repo, indexUrl: 'https://example.test/profiles.yml' });
    expect(result).toEqual({ seeded: 0, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
